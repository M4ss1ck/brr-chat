// Local persistence for the PWA. IndexedDB only: no localStorage, no cookies, and every
// write is small and versioned by the object store, so a shell update cannot lose the
// session (docs/PROTOCOL.md, app shell budget).
import { EMOJI_PALETTE_SIZE, Role, Tag, type Event, type Op, type VersionRange } from "@brr-chat/protocol";

const DB_NAME = "brr-chat";
const DB_VERSION = 1;
const STORE = "kv";

const KEY_SESSION = "session";
const KEY_RANGE = "range";

const postsKey = (username: string, scope: number): string => `posts:${username}:${scope}`;
const membersKey = (username: string, scope: number): string => `members:${username}:${scope}`;
const reactionsKey = (username: string, scope: number): string => `reactions:${username}:${scope}`;
const outboxKey = (username: string): string => `outbox:${username}`;
const cursorKey = (username: string): string => `cursor:${username}`;
const groupsKey = (username: string): string => `groups:${username}`;
const dmsKey = (username: string): string => `dms:${username}`;
const profilesKey = (username: string): string => `profiles:${username}`;
const selfKey = (username: string): string => `self:${username}`;

export interface Session {
  /** Bare 32-char session token (ADR 0007). */
  token: string;
  username: string;
  /** True until the signup code's last group is typed back (ADR 0006). */
  recoveryPending?: boolean;
}

let dbHandle: Promise<IDBDatabase> | null = null;

function openStore(): Promise<IDBDatabase> {
  if (dbHandle) return dbHandle;
  dbHandle = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        dbHandle = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      dbHandle = null;
      reject(request.error ?? new Error("indexeddb: open failed"));
    };
    request.onblocked = () => {
      reject(new Error("indexeddb: open blocked by another tab"));
    };
  }).catch((err: unknown) => {
    dbHandle = null;
    throw err;
  });
  return dbHandle;
}

/** Drops the cached handle. Safe to call when nothing is open. */
export async function closeStore(): Promise<void> {
  const pending = dbHandle;
  dbHandle = null;
  if (!pending) return;
  try {
    (await pending).close();
  } catch {
    // An open that already failed has nothing to close.
  }
}

function read(key: string): Promise<unknown> {
  return openStore().then(
    (database) =>
      new Promise<unknown>((resolve, reject) => {
        const request = database.transaction(STORE, "readonly").objectStore(STORE).get(key);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error);
        };
      }),
  );
}

function write(key: string, value: unknown): Promise<void> {
  return openStore().then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error);
        };
      }),
  );
}

function remove(key: string): Promise<void> {
  return openStore().then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error);
        };
      }),
  );
}

// ---- narrowers: a row written by an older or broken shell must read as absent ----

function asCursor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asSession(value: unknown): Session | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as { token?: unknown; username?: unknown; recoveryPending?: unknown };
  if (typeof row.token !== "string" || row.token.length === 0) return null;
  if (typeof row.username !== "string" || row.username.length === 0) return null;
  const session: Session = { token: row.token, username: row.username };
  if (row.recoveryPending === true) session.recoveryPending = true;
  return session;
}

function asRange(value: unknown): VersionRange | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as { min?: unknown; max?: unknown };
  if (typeof row.min !== "number" || !Number.isSafeInteger(row.min) || row.min <= 0) return null;
  if (typeof row.max !== "number" || !Number.isSafeInteger(row.max) || row.max <= 0) return null;
  return { min: row.min, max: row.max };
}

function assertCursor(value: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("cursor: expected a safe uint");
  }
}

// ---- cursor ----
//
// Scoped by account. A cursor belongs to the events one account has applied; sharing it
// between accounts would skip the second account's first events.

/** Last applied seq, or null when this account has never synced on this device. */
export async function getStoredCursor(username: string): Promise<number | null> {
  return asCursor(await read(cursorKey(username)));
}

/** Last applied seq; a fresh account is at 0. */
export async function getCursor(username: string): Promise<number> {
  return (await getStoredCursor(username)) ?? 0;
}

export async function setCursor(username: string, value: number): Promise<void> {
  assertCursor(value);
  await write(cursorKey(username), value);
}

// ---- session ----

export async function getSession(): Promise<Session | null> {
  return asSession(await read(KEY_SESSION));
}

export async function setSession(session: Session | null): Promise<void> {
  await write(KEY_SESSION, session);
}

// ---- server version range ----

/** Cached [vMin, vMax], used to warn about updates before the server refuses the request. */
export async function getRange(): Promise<VersionRange | null> {
  return asRange(await read(KEY_RANGE));
}

export async function setRange(range: VersionRange): Promise<void> {
  await write(KEY_RANGE, range);
}

// ---- groups, posts, members, profiles ----
//
// Events are applied by seq into plain records, so applying the same event twice (a state
// snapshot can legally repeat an event at or below the cursor) cannot duplicate a post.

export interface StoredGroup {
  id: number;
  seq: number;
  name: string;
  about: string;
  open: boolean;
}

export interface StoredPost {
  seq: number;
  ts: number;
  author: number;
  scope: number;
  text: string;
  /** Seq of the post this replies to, or 0 for a top-level post. */
  parent: number;
}

/** One account's latest reaction to one target and emoji. Toggling off keeps the record. */
export interface StoredReaction {
  scope: number;
  target: number;
  emoji: number;
  user: number;
  on: boolean;
  seq: number;
}

/** Aggregated reactions for one target, in palette order. */
export interface ReactionTally {
  emoji: number;
  count: number;
  mine: boolean;
}

export interface StoredMember {
  group: number;
  user: number;
  role: number;
  seq: number;
}

/** A DM conversation. `a` is the opener (event author) and `b` the peer it was opened with. */
export interface StoredDm {
  id: number;
  seq: number;
  a: number;
  b: number;
}

export interface StoredProfile {
  user: number;
  seq: number;
  username: string;
  displayName: string;
  bio: string;
}

function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asGroup(value: unknown): StoredGroup | null {
  const row = asObject(value);
  if (!isUint(row.id) || row.id === 0 || !isUint(row.seq) || row.seq === 0) return null;
  if (typeof row.name !== "string" || typeof row.about !== "string" || typeof row.open !== "boolean") return null;
  return { id: row.id, seq: row.seq, name: row.name, about: row.about, open: row.open };
}

function asPost(value: unknown): StoredPost | null {
  const row = asObject(value);
  if (!isUint(row.seq) || row.seq === 0) return null;
  if (!isUint(row.ts) || !isUint(row.author) || !isUint(row.scope) || row.scope === 0) return null;
  if (typeof row.text !== "string") return null;
  // Rows written before replies existed have no parent field: they are top-level posts.
  if (row.parent !== undefined && !isUint(row.parent)) return null;
  return { seq: row.seq, ts: row.ts, author: row.author, scope: row.scope, text: row.text, parent: isUint(row.parent) ? row.parent : 0 };
}

function asReaction(value: unknown): StoredReaction | null {
  const row = asObject(value);
  if (!isUint(row.scope) || row.scope === 0 || !isUint(row.target) || row.target === 0) return null;
  if (!isUint(row.user) || row.user === 0 || !isUint(row.seq) || row.seq === 0) return null;
  if (!isUint(row.emoji) || row.emoji >= EMOJI_PALETTE_SIZE || typeof row.on !== "boolean") return null;
  return { scope: row.scope, target: row.target, emoji: row.emoji, user: row.user, on: row.on, seq: row.seq };
}

function asDm(value: unknown): StoredDm | null {
  const row = asObject(value);
  if (!isUint(row.id) || row.id === 0 || !isUint(row.seq) || row.seq === 0) return null;
  if (!isUint(row.a) || row.a === 0 || !isUint(row.b) || row.b === 0 || row.a === row.b) return null;
  return { id: row.id, seq: row.seq, a: row.a, b: row.b };
}

function asMember(value: unknown): StoredMember | null {
  const row = asObject(value);
  if (!isUint(row.group) || row.group === 0 || !isUint(row.user) || row.user === 0) return null;
  if (!isUint(row.role) || row.role > Role.Owner || !isUint(row.seq) || row.seq === 0) return null;
  return { group: row.group, user: row.user, role: row.role, seq: row.seq };
}

function asProfile(value: unknown): StoredProfile | null {
  const row = asObject(value);
  if (!isUint(row.user) || row.user === 0 || !isUint(row.seq) || row.seq === 0) return null;
  if (typeof row.username !== "string" || typeof row.displayName !== "string" || typeof row.bio !== "string") return null;
  return { user: row.user, seq: row.seq, username: row.username, displayName: row.displayName, bio: row.bio };
}

function asMap<T>(value: unknown, parse: (v: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, raw] of Object.entries(asObject(value))) {
    const row = parse(raw);
    if (row) out[key] = row;
  }
  return out;
}

async function readMap<T>(key: string, parse: (v: unknown) => T | null): Promise<Record<string, T>> {
  return asMap(await read(key), parse);
}

/** Applies a sync response's events. Safe to call with events at or below the stored cursor. */
export async function applyEvents(username: string, events: Event[]): Promise<void> {
  if (events.length === 0) return;

  const groups = await readMap(groupsKey(username), asGroup);
  const dms = await readMap(dmsKey(username), asDm);
  const profiles = await readMap(profilesKey(username), asProfile);
  const scopes = [...new Set(events.map((e) => e.scope).filter((scope) => scope > 0))];
  const posts = new Map<number, Record<string, StoredPost>>();
  const members = new Map<number, Record<string, StoredMember>>();
  const reactions = new Map<number, Record<string, StoredReaction>>();
  for (const scope of scopes) {
    posts.set(scope, await readMap(postsKey(username, scope), asPost));
    members.set(scope, await readMap(membersKey(username, scope), asMember));
    reactions.set(scope, await readMap(reactionsKey(username, scope), asReaction));
  }

  const touchedPosts = new Set<number>();
  const touchedMembers = new Set<number>();
  const touchedReactions = new Set<number>();
  let touchedDms = false;

  for (const event of events) {
    switch (event.tag) {
      case Tag.GroupMeta:
        groups[String(event.scope)] = {
          id: event.scope,
          seq: event.seq,
          name: event.name,
          about: event.about,
          open: event.open,
        };
        break;
      case Tag.Membership: {
        const map = members.get(event.scope);
        if (!map) break;
        if (event.role === Role.None) delete map[String(event.user)];
        else map[String(event.user)] = { group: event.scope, user: event.user, role: event.role, seq: event.seq };
        touchedMembers.add(event.scope);
        break;
      }
      case Tag.DmScope:
        dms[String(event.scope)] = {
          id: event.scope,
          seq: event.seq,
          a: event.author,
          b: event.peer,
        };
        touchedDms = true;
        break;
      case Tag.Post:
      case Tag.Reply:
      case Tag.Dm: {
        const map = posts.get(event.scope);
        if (!map) break;
        map[String(event.seq)] = {
          seq: event.seq,
          ts: event.ts,
          author: event.author,
          scope: event.scope,
          text: event.text,
          parent: event.tag === Tag.Reply ? event.parent : 0,
        };
        touchedPosts.add(event.scope);
        break;
      }
      case Tag.Reaction: {
        const map = reactions.get(event.scope);
        if (!map) break;
        const key = `${event.target}:${event.emoji}:${event.author}`;
        const prior = map[key];
        // A state snapshot can repeat an event at or below the cursor. The newer seq wins,
        // so replaying an old "on" cannot undo a later "off".
        if (prior && prior.seq > event.seq) break;
        map[key] = {
          scope: event.scope,
          target: event.target,
          emoji: event.emoji,
          user: event.author,
          on: event.on,
          seq: event.seq,
        };
        touchedReactions.add(event.scope);
        break;
      }
      case Tag.Profile:
        profiles[String(event.author)] = {
          user: event.author,
          seq: event.seq,
          username: event.username,
          displayName: event.displayName,
          bio: event.bio,
        };
        break;
      case Tag.ScopeLeft:
        if (event.purge) {
          const postMap = posts.get(event.scope);
          if (postMap) for (const key of Object.keys(postMap)) delete postMap[key];
          const memberMap = members.get(event.scope);
          if (memberMap) for (const key of Object.keys(memberMap)) delete memberMap[key];
          const reactionMap = reactions.get(event.scope);
          if (reactionMap) for (const key of Object.keys(reactionMap)) delete reactionMap[key];
          if (groups[String(event.scope)]?.open !== true) delete groups[String(event.scope)];
          if (dms[String(event.scope)]) {
            delete dms[String(event.scope)];
            touchedDms = true;
          }
          touchedPosts.add(event.scope);
          touchedMembers.add(event.scope);
          touchedReactions.add(event.scope);
        }
        break;
      default:
        // Gap and unknown tags carry no state this slice can cache.
        break;
    }
  }

  const writes = [write(groupsKey(username), groups), write(profilesKey(username), profiles)];
  if (touchedDms) writes.push(write(dmsKey(username), dms));
  for (const scope of touchedPosts) writes.push(write(postsKey(username, scope), posts.get(scope) ?? {}));
  for (const scope of touchedMembers) writes.push(write(membersKey(username, scope), members.get(scope) ?? {}));
  for (const scope of touchedReactions) writes.push(write(reactionsKey(username, scope), reactions.get(scope) ?? {}));
  await Promise.all(writes);
}

export async function getGroups(username: string): Promise<StoredGroup[]> {
  return Object.values(await readMap(groupsKey(username), asGroup)).sort((a, b) => a.seq - b.seq);
}

export async function getPosts(username: string, scope: number): Promise<StoredPost[]> {
  return Object.values(await readMap(postsKey(username, scope), asPost)).sort((a, b) => a.seq - b.seq);
}

/** Latest reaction per account, target and emoji; callers tally what is still on. */
export async function getReactions(username: string, scope: number): Promise<StoredReaction[]> {
  return Object.values(await readMap(reactionsKey(username, scope), asReaction)).sort((a, b) => a.seq - b.seq);
}

/**
 * The value the next tap should send. Pending outbox rows win over the synced cache, so two
 * taps on a flaky link become on then off instead of two "on" ops.
 */
export async function nextReactionOn(
  username: string,
  scope: number,
  target: number,
  emoji: number,
  self: number,
): Promise<boolean> {
  const stored = (await getReactions(username, scope)).find(
    (row) => row.target === target && row.emoji === emoji && row.user === self,
  );
  let on = stored?.on === true;
  for (const op of await getOutbox(username)) {
    if (op.tag !== Tag.Reaction || op.scope !== scope || op.target !== target || op.emoji !== emoji) continue;
    if (typeof op.on === "boolean") on = op.on;
  }
  return !on;
}

/**
 * Counts the reactions still on, per target, in palette order. Replaying events cannot
 * double-count because the store keeps one row per account, target and emoji.
 */
export function tallyReactions(rows: readonly StoredReaction[], self: number | null): Map<number, ReactionTally[]> {
  const byTarget = new Map<number, Map<number, { count: number; mine: boolean }>>();
  for (const row of rows) {
    if (!row.on) continue;
    let byEmoji = byTarget.get(row.target);
    if (!byEmoji) {
      byEmoji = new Map();
      byTarget.set(row.target, byEmoji);
    }
    const tally = byEmoji.get(row.emoji) ?? { count: 0, mine: false };
    tally.count += 1;
    if (self !== null && row.user === self) tally.mine = true;
    byEmoji.set(row.emoji, tally);
  }

  const out = new Map<number, ReactionTally[]>();
  for (const [target, byEmoji] of byTarget) {
    out.set(
      target,
      [...byEmoji.entries()]
        .sort(([a], [b]) => a - b)
        .map(([emoji, tally]) => ({ emoji, count: tally.count, mine: tally.mine })),
    );
  }
  return out;
}

/** DM conversations cached on this device, in the order they were opened. */
export async function getDmScopes(username: string): Promise<StoredDm[]> {
  return Object.values(await readMap(dmsKey(username), asDm)).sort((a, b) => a.seq - b.seq);
}

/** One DM thread, oldest first. Messages share the post store: a seq names exactly one scope. */
export async function getDmMessages(username: string, scope: number): Promise<StoredPost[]> {
  return getPosts(username, scope);
}

export async function getMembers(username: string, scope: number): Promise<StoredMember[]> {
  return Object.values(await readMap(membersKey(username, scope), asMember)).sort((a, b) => a.user - b.user);
}

export async function getProfiles(username: string): Promise<Map<number, StoredProfile>> {
  const rows = await readMap(profilesKey(username), asProfile);
  return new Map(Object.values(rows).map((row) => [row.user, row]));
}

export async function getProfile(username: string, user: number): Promise<StoredProfile | null> {
  return (await getProfiles(username)).get(user) ?? null;
}

// ---- this account's wire id ----

/** Scoped by username: one device can sign into a second account without inheriting an id. */
export async function getSelf(username: string): Promise<number | null> {
  const value = await read(selfKey(username));
  return isUint(value) && value > 0 ? value : null;
}

export async function setSelf(username: string, value: number): Promise<void> {
  if (username.length === 0) throw new RangeError("self: expected a username");
  if (!isUint(value) || value === 0) throw new RangeError("self: expected a positive uint");
  await write(selfKey(username), value);
}

// ---- outbox ----
//
// The cid is persisted before the request goes out, so a retry after a lost response reuses
// it and the server returns the original seq instead of a duplicate (docs/PROTOCOL.md).
// Ops are scoped by account: signing into another account must not send the first one's queue.

export interface StoredOp {
  /** 8 bytes, kept as a plain array so IndexedDB and JSON both round-trip it. */
  cid: number[];
  tag: number;
  scope: number;
  text?: string;
  name?: string;
  about?: string;
  open?: boolean;
  user?: number;
  role?: number;
  peer?: number;
  username?: string;
  displayName?: string;
  bio?: string;
  parent?: number;
  target?: number;
  emoji?: number;
  on?: boolean;
}

function asStoredOp(value: unknown): StoredOp | null {
  const row = asObject(value);
  const cid = row.cid;
  if (!Array.isArray(cid) || cid.length !== 8 || !cid.every((b) => isUint(b) && b <= 255)) return null;
  if (!isUint(row.tag) || !isUint(row.scope)) return null;
  const op: StoredOp = { cid, tag: row.tag, scope: row.scope };
  if (typeof row.text === "string") op.text = row.text;
  if (typeof row.name === "string") op.name = row.name;
  if (typeof row.about === "string") op.about = row.about;
  if (typeof row.open === "boolean") op.open = row.open;
  if (isUint(row.user)) op.user = row.user;
  if (isUint(row.role)) op.role = row.role;
  if (isUint(row.peer)) op.peer = row.peer;
  if (typeof row.username === "string") op.username = row.username;
  if (typeof row.displayName === "string") op.displayName = row.displayName;
  if (typeof row.bio === "string") op.bio = row.bio;
  if (isUint(row.parent)) op.parent = row.parent;
  if (isUint(row.target)) op.target = row.target;
  if (isUint(row.emoji)) op.emoji = row.emoji;
  if (typeof row.on === "boolean") op.on = row.on;
  return op;
}

export async function getOutbox(username: string): Promise<StoredOp[]> {
  const rows = await read(outboxKey(username));
  if (!Array.isArray(rows)) return [];
  return rows.map(asStoredOp).filter((op): op is StoredOp => op !== null);
}

/** Queues one op with a fresh device-chosen cid. It stays queued until an ack arrives. */
export async function enqueueOp(username: string, op: Omit<StoredOp, "cid">): Promise<StoredOp> {
  const cid = Array.from(crypto.getRandomValues(new Uint8Array(8)));
  const stored: StoredOp = { ...op, cid };
  const outbox = await getOutbox(username);
  outbox.push(stored);
  await write(outboxKey(username), outbox);
  return stored;
}

function hex(cid: readonly number[]): string {
  return cid.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Drops every op the server answered, success or nack: a nack would fail the same way again. */
export async function removeOutbox(username: string, cids: readonly Uint8Array[]): Promise<void> {
  if (cids.length === 0) return;
  const done = new Set(cids.map((cid) => hex([...cid])));
  const outbox = await getOutbox(username);
  await write(outboxKey(username), outbox.filter((op) => !done.has(hex(op.cid))));
}

/** Turns a stored row back into the protocol's op shape, with a real `cid` byte array. */
export function toWireOp(op: StoredOp): Op {
  const cid = new Uint8Array(op.cid);
  switch (op.tag) {
    case Tag.Post:
      return { cid, tag: Tag.Post, scope: op.scope, text: op.text ?? "", media: null };
    case Tag.Reply:
      return { cid, tag: Tag.Reply, scope: op.scope, parent: op.parent ?? 0, text: op.text ?? "", media: null };
    case Tag.Reaction:
      return {
        cid,
        tag: Tag.Reaction,
        scope: op.scope,
        target: op.target ?? 0,
        emoji: op.emoji ?? 0,
        on: op.on === true,
      };
    case Tag.Dm:
      return {
        cid,
        tag: Tag.Dm,
        scope: op.scope,
        peer: op.peer ?? 0,
        text: op.text ?? "",
        media: null,
      };
    case Tag.GroupMeta:
      return {
        cid,
        tag: Tag.GroupMeta,
        scope: op.scope,
        name: op.name ?? "",
        about: op.about ?? "",
        open: op.open === true,
      };
    case Tag.Membership:
      return {
        cid,
        tag: Tag.Membership,
        scope: op.scope,
        user: op.user ?? 0,
        role: (op.role ?? Role.Member) as typeof Role.Member,
      };
    case Tag.Profile:
      return {
        cid,
        tag: Tag.Profile,
        scope: 0,
        username: op.username ?? "",
        displayName: op.displayName ?? "",
        bio: op.bio ?? "",
      };
    default:
      throw new Error(`outbox: unsupported tag ${op.tag}`);
  }
}
