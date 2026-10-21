// Local persistence for the PWA. IndexedDB only: no localStorage, no cookies, and every
// write is small and versioned by the object store, so a shell update cannot lose the
// session (docs/PROTOCOL.md, app shell budget).
//
// One device holds several servers, like an IRC client with several networks (#18, ADR 0020).
// Each server has its own account, cursor, range, outbox and event cache. Group and DM ids
// are small integers local to one server, so every per-account key starts with the server
// origin: two servers' logs would otherwise collide in one key space.
import {
  AckError,
  EMOJI_PALETTE_SIZE,
  Role,
  Tag,
  type Ack,
  type Event,
  type Media,
  type Op,
  type VersionRange,
} from "@brr-chat/protocol";
import { isMonthKey } from "./month.ts";
import { serverIdOf, serverLabel, type PendingInvite } from "./servers.ts";

const DB_NAME = "brr-chat";
const DB_VERSION = 1;
const STORE = "kv";

/** Content events kept per scope. Posts, replies and DMs share the budget (ADR 0013). */
const EVENT_CACHE_LIMIT = 2_000;
/** The newest messages per scope that eviction never touches, so offline opening is instant. */
const LATEST_PAGE_SIZE = 100;
/** Downloaded images kept across the app; older bytes leave first (ADR 0013). */
export const MEDIA_CACHE_LIMIT_BYTES = 50 * 1024 * 1024;

/** The server list and which entry the UI is showing. Both are device state, not server state. */
const KEY_SERVERS = "servers";
const KEY_ACTIVE = "active";
const MEDIA_INDEX = "media-index";

const rangeKey = (server: string): string => `range:${server}`;
const meterKey = (server: string): string => `meter:${server}`;
/** The durable image cache is scoped by an owner key the caller chooses (account + server). */
const mediaKey = (owner: string, id: number): string => `media:${owner}:${id}`;

/**
 * The key namespace shared by every cached row of one account. Exported so the UI's own keys
 * (admin cache, history exhaustion) use the same encoding instead of rebuilding it.
 */
export function accountKey(account: AccountKey): string {
  return `${account.server} ${account.username}`;
}
const postsKey = (account: AccountKey, scope: number): string => `posts:${accountKey(account)}:${scope}`;
const membersKey = (account: AccountKey, scope: number): string => `members:${accountKey(account)}:${scope}`;
const reactionsKey = (account: AccountKey, scope: number): string => `reactions:${accountKey(account)}:${scope}`;
const bansKey = (account: AccountKey, scope: number): string => `bans:${accountKey(account)}:${scope}`;
const outboxKey = (account: AccountKey): string => `outbox:${accountKey(account)}`;
const cursorKey = (account: AccountKey): string => `cursor:${accountKey(account)}`;
const groupsKey = (account: AccountKey): string => `groups:${accountKey(account)}`;
const dmsKey = (account: AccountKey): string => `dms:${accountKey(account)}`;
const gapsKey = (account: AccountKey, scope: number): string => `gaps:${accountKey(account)}:${scope}`;
const profilesKey = (account: AccountKey): string => `profiles:${accountKey(account)}`;
const selfKey = (account: AccountKey): string => `self:${accountKey(account)}`;

/** One calendar month of metered traffic. The month is the device's local `YYYY-MM`. */
export interface StoredMeter {
  month: string;
  bytes: number;
}

export interface Session {
  /** Bare 32-char session token (ADR 0007). */
  token: string;
  username: string;
  /** True until the signup code's last group is typed back (ADR 0006). */
  recoveryPending?: boolean;
}

/** One server's account on this device: the session plus the origin it belongs to. */
export interface Account extends Session {
  server: string;
}

/** The pair every cached row belongs to. A cursor without a server would skip the other log. */
export type AccountKey = Pick<Account, "server" | "username">;

/** One entry in the server list, like a network in an IRC client. */
export interface StoredServer {
  /** Canonical origin. The id, the fetch base, and the cache namespace. */
  id: string;
  /** Human label, the host by default. */
  name: string;
  addedAt: number;
  /** This server's account on this device, or null while signed out. */
  session: Session | null;
  /** A link the user arrived by, kept until sign-up or join consumes it. */
  invite: PendingInvite | null;
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

function asMeter(value: unknown): StoredMeter | null {
  const row = asObject(value);
  if (!isMonthKey(row.month)) return null;
  if (!isUint(row.bytes)) return null;
  return { month: row.month, bytes: row.bytes };
}

function asPendingInvite(value: unknown): PendingInvite | null {
  const row = asObject(value);
  const kind = row.kind;
  const token = row.token;
  if (kind !== "signup" && kind !== "join") return null;
  if (typeof token !== "string" || token.length === 0) return null;
  return { kind, token };
}

function asServer(value: unknown): StoredServer | null {
  const row = asObject(value);
  const id = typeof row.id === "string" ? serverIdOf(row.id) : null;
  if (id === null) return null;
  const name = typeof row.name === "string" && row.name.length > 0 ? row.name : serverLabel(id);
  const addedAt = isUint(row.addedAt) ? row.addedAt : 0;
  return { id, name, addedAt, session: asSession(row.session), invite: asPendingInvite(row.invite) };
}

function assertCursor(value: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("cursor: expected a safe uint");
  }
}

// ---- server list ----
//
// The list is device state: which communities this client knows and which one is on screen.
// A server's account lives inside its row, so one server being signed in says nothing about
// the next one.

async function readServers(): Promise<StoredServer[]> {
  const value = await read(KEY_SERVERS);
  if (!Array.isArray(value)) return [];
  return value.map(asServer).filter((row): row is StoredServer => row !== null);
}

async function writeServers(servers: readonly StoredServer[]): Promise<void> {
  await write(KEY_SERVERS, servers);
}

/** Every server this device knows, in the order they were added. */
export async function listServers(): Promise<StoredServer[]> {
  return [...(await readServers())].sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id));
}

async function getServer(id: string): Promise<StoredServer | null> {
  return (await readServers()).find((row) => row.id === id) ?? null;
}

/** Adds a server once. Called on boot for the serving origin, so a first visit seeds itself. */
export async function ensureServer(id: string, name?: string): Promise<StoredServer> {
  const canonical = serverIdOf(id);
  if (canonical === null) throw new RangeError(`server: expected an http(s) origin, got ${id}`);
  const servers = await readServers();
  const existing = servers.find((row) => row.id === canonical);
  if (existing) return existing;
  const row: StoredServer = {
    id: canonical,
    name: name?.trim() || serverLabel(canonical),
    addedAt: Date.now(),
    session: null,
    invite: null,
  };
  servers.push(row);
  await writeServers(servers);
  return row;
}

/** The server on screen. A stale id (a removed server) reads as none, never as another entry. */
export async function getActiveServerId(): Promise<string | null> {
  const value = await read(KEY_ACTIVE);
  if (typeof value !== "string") return null;
  return (await getServer(value))?.id ?? null;
}

export async function setActiveServer(id: string): Promise<void> {
  if ((await getServer(id)) === null) throw new Error(`active server: unknown server ${id}`);
  await write(KEY_ACTIVE, id);
}

// ---- account ----

/** This server's stored session, or null while signed out. */
export async function getSession(server: string): Promise<Session | null> {
  return (await getServer(server))?.session ?? null;
}

export async function setSession(server: string, session: Session | null): Promise<void> {
  const canonical = serverIdOf(server);
  if (canonical === null) throw new RangeError(`session: expected an http(s) origin, got ${server}`);
  const servers = await readServers();
  let row = servers.find((entry) => entry.id === canonical);
  if (!row) {
    row = { id: canonical, name: serverLabel(canonical), addedAt: Date.now(), session: null, invite: null };
    servers.push(row);
  }
  row.session = session === null ? null : { ...session };
  await writeServers(servers);
}

/** The active server's account, or null when it is signed out (or no server is active). */
export async function getActiveAccount(): Promise<Account | null> {
  const id = await getActiveServerId();
  if (id === null) return null;
  const session = await getSession(id);
  return session === null ? null : { server: id, ...session };
}

export async function setPendingInvite(server: string, invite: PendingInvite | null): Promise<void> {
  const servers = await readServers();
  const row = servers.find((entry) => entry.id === server);
  if (!row) throw new Error(`pending invite: unknown server ${server}`);
  row.invite = invite === null ? null : { ...invite };
  await writeServers(servers);
}

export async function getPendingInvite(server: string): Promise<PendingInvite | null> {
  return (await getServer(server))?.invite ?? null;
}

/** Every key in the one object store, for the two whole-device operations (remove, migrate). */
function allKeys(): Promise<string[]> {
  return openStore().then(
    (database) =>
      new Promise<string[]>((resolve, reject) => {
        const request = database.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
        request.onsuccess = () => {
          resolve(request.result.filter((key): key is string => typeof key === "string"));
        };
        request.onerror = () => {
          reject(request.error);
        };
      }),
  );
}

/**
 * Forgets one server: its account, invite, cursor, outbox and every cached event. Removing a
 * community from the list must not leave its posts readable under a key nobody lists.
 */
export async function removeServer(server: string): Promise<void> {
  const servers = (await readServers()).filter((row) => row.id !== server);
  await writeServers(servers);
  // Read the pointer itself: once the row is gone, getActiveServerId() would already read null.
  if ((await read(KEY_ACTIVE)) === server) {
    await write(KEY_ACTIVE, servers[0]?.id ?? null);
  }
  const namespace = `${server} `;
  const doomed = (await allKeys()).filter(
    (key) => key.includes(namespace) || key === rangeKey(server) || key === meterKey(server),
  );
  for (const key of doomed) await remove(key);
  // Downloaded image bytes are indexed by account, so their owner key starts with the server.
  const index = await readMediaIndex();
  const keep = index.filter((entry) => !entry.owner.startsWith(namespace));
  if (keep.length !== index.length) await write(MEDIA_INDEX, keep);
}

/**
 * Moves a device from the single-server shell to the server list without losing its account,
 * cursor or cache. Runs once: the presence of the `servers` row means it already happened.
 * A fresh device gets one seeded, signed-out entry for the origin that served the app.
 */
export async function migrateLegacy(server: string): Promise<boolean> {
  const canonical = serverIdOf(server);
  if (canonical === null) throw new RangeError(`migrate: expected an http(s) origin, got ${server}`);
  const existing = await read(KEY_SERVERS);
  if (Array.isArray(existing)) return false;

  const session = asSession(await read("session"));
  const entries: StoredServer[] = [
    {
      id: canonical,
      name: serverLabel(canonical),
      addedAt: Date.now(),
      session,
      invite: null,
    },
  ];
  const written: [string, unknown][] = [];
  const deleted: string[] = [];
  for (const key of await allKeys()) {
    if (key === "session") {
      deleted.push(key);
      continue;
    }
    if (key === "range" || key === "meter") {
      written.push([key === "range" ? rangeKey(canonical) : meterKey(canonical), await read(key)]);
      deleted.push(key);
      continue;
    }
    if (session === null) continue;
    // `<kind>:<username>[:<scope>]` was the whole key space of the single-server shell.
    const parts = key.split(":");
    if (parts.length < 2 || parts[1] !== session.username) continue;
    const rest = parts.slice(2);
    const target = `${parts[0]}:${canonical} ${session.username}${rest.length > 0 ? `:${rest.join(":")}` : ""}`;
    written.push([target, await read(key)]);
    deleted.push(key);
  }

  for (const [key, value] of written) await write(key, value);
  await writeServers(entries);
  await write(KEY_ACTIVE, canonical);
  for (const key of deleted) await remove(key);
  return true;
}

// ---- cursor ----
//
// Scoped by server and account. A cursor belongs to the events one account has applied;
// sharing it between accounts, or between two servers, would skip a log.

/** Last applied seq, or null when this account has never synced on this device. */
export async function getStoredCursor(account: AccountKey): Promise<number | null> {
  return asCursor(await read(cursorKey(account)));
}

/** Last applied seq; a fresh account is at 0. */
export async function getCursor(account: AccountKey): Promise<number> {
  return (await getStoredCursor(account)) ?? 0;
}

export async function setCursor(account: AccountKey, value: number): Promise<void> {
  assertCursor(value);
  await write(cursorKey(account), value);
}

// ---- server version range ----
//
// Per server: two servers can run different builds, and a cached range from the other one
// would either warn about an update that is not there or hide one that is.

/** Cached [vMin, vMax], used to warn about updates before the server refuses the request. */
export async function getRange(server: string): Promise<VersionRange | null> {
  return asRange(await read(rangeKey(server)));
}

export async function setRange(server: string, range: VersionRange): Promise<void> {
  await write(rangeKey(server), range);
}

// ---- data meter ----
//
// One month row per server, so the bill can say which community spent the bytes. The session
// counter starts at zero on every page load, which is what "this session" means; the month
// survives reloads (ADR 0018, ADR 0020).

/** Last stored month total for one server, or null when it has never metered a request. */
export async function getMeter(server: string): Promise<StoredMeter | null> {
  return asMeter(await read(meterKey(server)));
}

export async function setMeter(server: string, meter: StoredMeter): Promise<void> {
  if (!isMonthKey(meter.month)) throw new RangeError("meter: expected a YYYY-MM month");
  if (!isUint(meter.bytes)) throw new RangeError("meter: expected a safe uint");
  await write(meterKey(server), meter);
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

/** The inline image placeholder cached beside a post. Bytes are a plain array like cid. */
export interface StoredMedia {
  id: number;
  w: number;
  h: number;
  thumbhash: number[];
}

export interface StoredPost {
  seq: number;
  ts: number;
  author: number;
  scope: number;
  text: string;
  /** Seq of the post this replies to, or 0 for a top-level post. */
  parent: number;
  /** Image placeholder, or null for a text-only post. The bytes are never cached. */
  media: StoredMedia | null;
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

/** Current ban state for one account in one group. Unbans keep the row with `banned = false`. */
export interface StoredBan {
  group: number;
  user: number;
  banned: boolean;
  seq: number;
}

/** A DM conversation. `a` is the opener (event author) and `b` the peer it was opened with. */
export interface StoredDm {
  id: number;
  seq: number;
  a: number;
  b: number;
}

/**
 * A hole a gap marker left in one scope: content in `(after, before)` was not delivered.
 * `before` is where the next "load older" tap starts; `count` is what the server said is
 * hidden there (ADR 0009, ADR 0019).
 */
export interface StoredGap {
  scope: number;
  after: number;
  before: number;
  count: number;
  /** Seq of the gap marker, so replaying the same sync cannot duplicate the hole. */
  seq: number;
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

function readMedia(value: unknown): StoredMedia | null {
  const row = asObject(value);
  if (!isUint(row.id) || row.id === 0 || !isUint(row.w) || row.w === 0 || !isUint(row.h) || row.h === 0) return null;
  const thumbhash = row.thumbhash;
  if (!Array.isArray(thumbhash) || thumbhash.length > 32) return null;
  if (!thumbhash.every((byte) => isUint(byte) && byte <= 255)) return null;
  return { id: row.id, w: row.w, h: row.h, thumbhash: thumbhash as number[] };
}

function toStoredMedia(media: Media | null): StoredMedia | null {
  return media === null ? null : { id: media.id, w: media.w, h: media.h, thumbhash: [...media.thumbhash] };
}

function asPost(value: unknown): StoredPost | null {
  const row = asObject(value);
  if (!isUint(row.seq) || row.seq === 0) return null;
  if (!isUint(row.ts) || !isUint(row.author) || !isUint(row.scope) || row.scope === 0) return null;
  if (typeof row.text !== "string") return null;
  // Rows written before replies existed have no parent field: they are top-level posts.
  if (row.parent !== undefined && !isUint(row.parent)) return null;
  // Rows written before images existed have no media field: a text-only post.
  const media = row.media === undefined || row.media === null ? null : readMedia(row.media);
  return {
    seq: row.seq,
    ts: row.ts,
    author: row.author,
    scope: row.scope,
    text: row.text,
    parent: isUint(row.parent) ? row.parent : 0,
    media,
  };
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

function asGap(value: unknown): StoredGap | null {
  const row = asObject(value);
  if (!isUint(row.scope) || row.scope === 0 || !isUint(row.seq) || row.seq === 0) return null;
  if (!isUint(row.after) || !isUint(row.before) || row.before <= row.after) return null;
  if (!isUint(row.count) || row.count === 0) return null;
  return { scope: row.scope, after: row.after, before: row.before, count: row.count, seq: row.seq };
}

function asMember(value: unknown): StoredMember | null {
  const row = asObject(value);
  if (!isUint(row.group) || row.group === 0 || !isUint(row.user) || row.user === 0) return null;
  if (!isUint(row.role) || row.role > Role.Owner || !isUint(row.seq) || row.seq === 0) return null;
  return { group: row.group, user: row.user, role: row.role, seq: row.seq };
}

function asBan(value: unknown): StoredBan | null {
  const row = asObject(value);
  if (!isUint(row.group) || row.group === 0 || !isUint(row.user) || row.user === 0) return null;
  if (typeof row.banned !== "boolean" || !isUint(row.seq) || row.seq === 0) return null;
  return { group: row.group, user: row.user, banned: row.banned, seq: row.seq };
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

/**
 * Removes the oldest posts above the per-scope cap. The newest `LATEST_PAGE_SIZE` rows and
 * rows named by an unsent op (a reply's parent, a reaction's target) are never removed, so
 * the cap can only ever make the window shorter, never the queue invalid.
 */
function prunePosts(map: Record<string, StoredPost>, protectedSeqs: ReadonlySet<number>): Set<number> {
  const removed = new Set<number>();
  const rows = Object.values(map).sort((a, b) => a.seq - b.seq);
  let overflow = rows.length - EVENT_CACHE_LIMIT;
  if (overflow <= 0) return removed;
  const newestStart = Math.max(0, rows.length - LATEST_PAGE_SIZE);
  for (let index = 0; index < newestStart && overflow > 0; index++) {
    const row = rows[index];
    if (!row || protectedSeqs.has(row.seq)) continue;
    delete map[String(row.seq)];
    removed.add(row.seq);
    overflow -= 1;
  }
  return removed;
}

export interface ApplyOptions {
  /**
   * Events the caller is about to show (a /history page). Eviction keeps them for this batch,
   * so a page bought on demand is never deleted by its own write.
   */
  protectedSeqs?: ReadonlySet<number>;
}

/** Applies a sync response's events. Safe to call with events at or below the stored cursor. */
export async function applyEvents(account: AccountKey, events: Event[], options: ApplyOptions = {}): Promise<void> {
  if (events.length === 0) return;

  const groups = await readMap(groupsKey(account), asGroup);
  const dms = await readMap(dmsKey(account), asDm);
  const profiles = await readMap(profilesKey(account), asProfile);
  const scopes = [...new Set(events.map((e) => e.scope).filter((scope) => scope > 0))];
  const posts = new Map<number, Record<string, StoredPost>>();
  const members = new Map<number, Record<string, StoredMember>>();
  const reactions = new Map<number, Record<string, StoredReaction>>();
  const bans = new Map<number, Record<string, StoredBan>>();
  for (const scope of scopes) {
    posts.set(scope, await readMap(postsKey(account, scope), asPost));
    members.set(scope, await readMap(membersKey(account, scope), asMember));
    reactions.set(scope, await readMap(reactionsKey(account, scope), asReaction));
    bans.set(scope, await readMap(bansKey(account, scope), asBan));
  }

  const touchedPosts = new Set<number>();
  const touchedMembers = new Set<number>();
  const touchedReactions = new Set<number>();
  const touchedBans = new Set<number>();
  const purgedScopes = new Set<number>();
  const gapEvents: StoredGap[] = [];
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
          media: toStoredMedia(event.media),
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
      case Tag.Delete: {
        // One level, like replies: deleting a root post takes its direct replies with it.
        const removed = new Set<number>([event.target]);
        const postMap = posts.get(event.scope);
        if (postMap) {
          for (const row of Object.values(postMap)) {
            if (row.parent === event.target) removed.add(row.seq);
          }
          for (const seq of removed) delete postMap[String(seq)];
        }
        const reactionMap = reactions.get(event.scope);
        if (reactionMap) {
          for (const [key, row] of Object.entries(reactionMap)) {
            if (removed.has(row.target)) delete reactionMap[key];
          }
        }
        touchedPosts.add(event.scope);
        touchedReactions.add(event.scope);
        break;
      }
      case Tag.Ban: {
        // A server-wide ban is about the account, not this group cache.
        if (event.scope === 0) break;
        const map = bans.get(event.scope);
        if (!map) break;
        const key = String(event.user);
        const prior = map[key];
        if (prior && prior.seq > event.seq) break;
        map[key] = { group: event.scope, user: event.user, banned: event.on, seq: event.seq };
        if (event.on) {
          const memberMap = members.get(event.scope);
          if (memberMap) delete memberMap[key];
          touchedMembers.add(event.scope);
        }
        touchedBans.add(event.scope);
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
          const banMap = bans.get(event.scope);
          if (banMap) for (const key of Object.keys(banMap)) delete banMap[key];
          if (groups[String(event.scope)]?.open !== true) delete groups[String(event.scope)];
          if (dms[String(event.scope)]) {
            delete dms[String(event.scope)];
            touchedDms = true;
          }
          touchedPosts.add(event.scope);
          touchedMembers.add(event.scope);
          touchedReactions.add(event.scope);
          touchedBans.add(event.scope);
          purgedScopes.add(event.scope);
        }
        break;
      case Tag.Block:
        // A block is silent but not retroactively invisible to this device: drop what it
        // already cached from that author, in every group and DM it knows (ADR 0012).
        if (event.on) {
          const knownScopes = new Set<number>([
            ...Object.values(groups).map((group) => group.id),
            ...Object.values(dms).map((dm) => dm.id),
          ]);
          for (const scope of knownScopes) {
            const postMap = posts.get(scope) ?? (await readMap(postsKey(account, scope), asPost));
            posts.set(scope, postMap);
            for (const [key, post] of Object.entries(postMap)) {
              if (post.author === event.user) delete postMap[key];
            }
            const reactionMap = reactions.get(scope) ?? (await readMap(reactionsKey(account, scope), asReaction));
            reactions.set(scope, reactionMap);
            for (const [key, reaction] of Object.entries(reactionMap)) {
              if (reaction.user === event.user) delete reactionMap[key];
            }
            touchedPosts.add(scope);
            touchedReactions.add(scope);
          }
        }
        break;
      case Tag.Gap:
        // A marker, not content: remember the hole so "load older" starts at its top edge.
        if (event.scope > 0 && event.before > event.after && event.count > 0) {
          gapEvents.push({
            scope: event.scope,
            after: event.after,
            before: event.before,
            count: event.count,
            seq: event.seq,
          });
        }
        break;
      default:
        // Unknown tags carry no state this slice can cache.
        break;
    }
  }

  // Bound the cache after applying the batch, before it is written. The newest page and
  // events an unsent op still points at are never candidates (ADR 0013).
  if (touchedPosts.size > 0 || touchedReactions.size > 0) {
    const protectedSeqs = new Set<number>(options.protectedSeqs ?? []);
    for (const op of await getPendingOps(account)) {
      if (op.parent !== undefined && op.parent > 0) protectedSeqs.add(op.parent);
      if (op.target !== undefined && op.target > 0) protectedSeqs.add(op.target);
    }
    for (const scope of new Set([...touchedPosts, ...touchedReactions])) {
      const postMap = posts.get(scope);
      if (!postMap) continue;
      const removed = prunePosts(postMap, protectedSeqs);
      if (removed.size > 0) touchedPosts.add(scope);
      const reactionMap = reactions.get(scope);
      if (!reactionMap) continue;
      let changed = false;
      // A reaction row is only useful next to its post. Once this scope has any posts, drop
      // rows whose target is gone too; the empty-cache case keeps reactions that arrived
      // before their post did.
      const hasPosts = Object.keys(postMap).length > 0;
      for (const [key, row] of Object.entries(reactionMap)) {
        if (!removed.has(row.target) && !(hasPosts && !postMap[String(row.target)])) continue;
        delete reactionMap[key];
        changed = true;
      }
      if (changed) touchedReactions.add(scope);
    }
  }

  const writes = [write(groupsKey(account), groups), write(profilesKey(account), profiles)];
  if (touchedDms) writes.push(write(dmsKey(account), dms));
  for (const scope of touchedPosts) writes.push(write(postsKey(account, scope), posts.get(scope) ?? {}));
  for (const scope of touchedMembers) writes.push(write(membersKey(account, scope), members.get(scope) ?? {}));
  for (const scope of touchedReactions) writes.push(write(reactionsKey(account, scope), reactions.get(scope) ?? {}));
  for (const scope of touchedBans) writes.push(write(bansKey(account, scope), bans.get(scope) ?? {}));
  await Promise.all(writes);

  for (const scope of purgedScopes) await remove(gapsKey(account, scope));
  await recordGaps(
    account,
    gapEvents.filter((gap) => !purgedScopes.has(gap.scope)),
  );
}

/** Merges gap markers into the stored holes, keyed by marker seq so a retried sync is a no-op. */
async function recordGaps(account: AccountKey, gaps: readonly StoredGap[]): Promise<void> {
  const scopes = new Set(gaps.map((gap) => gap.scope));
  for (const scope of scopes) {
    const stored = await getGaps(account, scope);
    const bySeq = new Map(stored.map((gap) => [gap.seq, gap]));
    for (const gap of gaps) if (gap.scope === scope) bySeq.set(gap.seq, gap);
    await setGaps(account, scope, [...bySeq.values()].sort((a, b) => a.before - b.before));
  }
}

/** Holes in one scope, nearest to the oldest cached content first. */
export async function getGaps(account: AccountKey, scope: number): Promise<StoredGap[]> {
  const value = await read(gapsKey(account, scope));
  if (!Array.isArray(value)) return [];
  return value
    .map(asGap)
    .filter((gap): gap is StoredGap => gap !== null)
    .sort((a, b) => a.before - b.before);
}

export async function setGaps(account: AccountKey, scope: number, gaps: readonly StoredGap[]): Promise<void> {
  if (gaps.length === 0) await remove(gapsKey(account, scope));
  else await write(gapsKey(account, scope), gaps);
}

// ---- media bytes ----
//
// Images are downloaded only on tap (ADR 0011), so they need their own bounded cache. The
// ThumbHash placeholder already lives on the event row; the 50 MB budget covers the bytes a
// tap actually fetched, across every group and DM on the device. Rows are scoped by an owner
// key (account plus server origin), so a second account or server on this device never reads
// another one's downloaded images.

interface MediaEntry {
  owner: string;
  id: number;
  bytes: number;
  /** Millisecond recency; lower leaves first. */
  used: number;
}

function asMediaEntry(value: unknown): MediaEntry | null {
  const row = asObject(value);
  if (typeof row.owner !== "string" || row.owner.length === 0) return null;
  if (!isUint(row.id) || row.id === 0 || !isUint(row.bytes) || !isUint(row.used)) return null;
  return { owner: row.owner, id: row.id, bytes: row.bytes, used: row.used };
}

async function readMediaIndex(): Promise<MediaEntry[]> {
  const value = await read(MEDIA_INDEX);
  if (!Array.isArray(value)) return [];
  return value.map(asMediaEntry).filter((entry): entry is MediaEntry => entry !== null);
}

/**
 * Writes the index after removing the least recently used rows until the cap holds, and
 * returns the rows that survived so the caller can skip storing bytes already evicted.
 */
async function persistMediaIndex(entries: MediaEntry[]): Promise<MediaEntry[]> {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= MEDIA_CACHE_LIMIT_BYTES) {
    await write(MEDIA_INDEX, entries);
    return entries;
  }
  entries.sort((a, b) => a.used - b.used || a.owner.localeCompare(b.owner) || a.id - b.id);
  while (total > MEDIA_CACHE_LIMIT_BYTES && entries.length > 0) {
    const oldest = entries.shift();
    if (!oldest) break;
    await remove(mediaKey(oldest.owner, oldest.id));
    total -= oldest.bytes;
  }
  await write(MEDIA_INDEX, entries);
  return entries;
}

/** Stores downloaded image bytes and evicts the oldest images over the 50 MB cap. */
export async function putMediaBytes(
  owner: string,
  id: number,
  bytes: Uint8Array,
  usedAt: number = Date.now(),
): Promise<void> {
  if (owner.length === 0) throw new RangeError("media: expected an owner key");
  if (!isUint(id) || id === 0) throw new RangeError("media: expected a positive uint id");
  if (!isUint(usedAt)) throw new RangeError("media: expected a safe uint timestamp");
  const rest = (await readMediaIndex()).filter((entry) => !(entry.owner === owner && entry.id === id));
  // A single image over the whole budget is never cached; keeping it would evict every other.
  if (bytes.byteLength > MEDIA_CACHE_LIMIT_BYTES) {
    await remove(mediaKey(owner, id));
    await persistMediaIndex(rest);
    return;
  }
  // Index first, bytes second: a crash between the two leaves a phantom row, which the next
  // read removes. The reverse order would leave orphan bytes that no eviction can ever see.
  rest.push({ owner, id, bytes: bytes.byteLength, used: usedAt });
  const survivors = await persistMediaIndex(rest);
  if (survivors.some((entry) => entry.owner === owner && entry.id === id)) {
    await write(mediaKey(owner, id), bytes);
  }
}

/** Reads cached image bytes and marks them most recently used. */
export async function getMediaBytes(
  owner: string,
  id: number,
  usedAt: number = Date.now(),
): Promise<Uint8Array | null> {
  const value = await read(mediaKey(owner, id));
  if (!(value instanceof Uint8Array)) {
    // An interrupted write can leave an index row without bytes; it must not count toward
    // the budget forever.
    const entries = await readMediaIndex();
    const next = entries.filter((entry) => !(entry.owner === owner && entry.id === id));
    if (next.length !== entries.length) await write(MEDIA_INDEX, next);
    return null;
  }
  const entries = await readMediaIndex();
  const hit = entries.find((entry) => entry.owner === owner && entry.id === id);
  if (hit) {
    hit.used = usedAt;
    hit.bytes = value.byteLength;
  } else {
    entries.push({ owner, id, bytes: value.byteLength, used: usedAt });
  }
  // A recovered index entry could put the cache over budget; persist enforces it either way.
  await persistMediaIndex(entries);
  return value;
}

/** Drops one owner's cached image bytes, or every owner's when no key is given. */
export async function clearMediaBytes(owner?: string): Promise<void> {
  const entries = await readMediaIndex();
  const dropped = owner === undefined ? entries : entries.filter((entry) => entry.owner === owner);
  const keep = owner === undefined ? [] : entries.filter((entry) => entry.owner !== owner);
  await Promise.all(dropped.map((entry) => remove(mediaKey(entry.owner, entry.id))));
  await write(MEDIA_INDEX, keep);
}

/** Bytes held by the media cache across every account on this device. */
export async function mediaCacheBytes(): Promise<number> {
  return (await readMediaIndex()).reduce((sum, entry) => sum + entry.bytes, 0);
}

export async function getGroups(account: AccountKey): Promise<StoredGroup[]> {
  return Object.values(await readMap(groupsKey(account), asGroup)).sort((a, b) => a.seq - b.seq);
}

export async function getPosts(account: AccountKey, scope: number): Promise<StoredPost[]> {
  return Object.values(await readMap(postsKey(account, scope), asPost)).sort((a, b) => a.seq - b.seq);
}

/** Latest reaction per account, target and emoji; callers tally what is still on. */
export async function getReactions(account: AccountKey, scope: number): Promise<StoredReaction[]> {
  return Object.values(await readMap(reactionsKey(account, scope), asReaction)).sort((a, b) => a.seq - b.seq);
}

/**
 * The value the next tap should send. Pending outbox rows win over the synced cache, so two
 * taps on a flaky link become on then off instead of two "on" ops.
 */
export async function nextReactionOn(
  account: AccountKey,
  scope: number,
  target: number,
  emoji: number,
  self: number,
): Promise<boolean> {
  const stored = (await getReactions(account, scope)).find(
    (row) => row.target === target && row.emoji === emoji && row.user === self,
  );
  let on = stored?.on === true;
  // A failed tap was never applied, so the next tap decides from the synced cache again.
  for (const op of await getPendingOps(account)) {
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
export async function getDmScopes(account: AccountKey): Promise<StoredDm[]> {
  return Object.values(await readMap(dmsKey(account), asDm)).sort((a, b) => a.seq - b.seq);
}

/** One DM thread, oldest first. Messages share the post store: a seq names exactly one scope. */
export async function getDmMessages(account: AccountKey, scope: number): Promise<StoredPost[]> {
  return getPosts(account, scope);
}

export async function getMembers(account: AccountKey, scope: number): Promise<StoredMember[]> {
  return Object.values(await readMap(membersKey(account, scope), asMember)).sort((a, b) => a.user - b.user);
}

/** Accounts currently banned from one group. Unban rows are kept but filtered out here. */
export async function getBans(account: AccountKey, scope: number): Promise<StoredBan[]> {
  return Object.values(await readMap(bansKey(account, scope), asBan))
    .filter((row) => row.banned)
    .sort((a, b) => a.seq - b.seq);
}

export async function getProfiles(account: AccountKey): Promise<Map<number, StoredProfile>> {
  const rows = await readMap(profilesKey(account), asProfile);
  return new Map(Object.values(rows).map((row) => [row.user, row]));
}

export async function getProfile(account: AccountKey, user: number): Promise<StoredProfile | null> {
  return (await getProfiles(account)).get(user) ?? null;
}

// ---- this account's wire id ----

/** Scoped by server and account: one device can hold the same username on two servers. */
export async function getSelf(account: AccountKey): Promise<number | null> {
  const value = await read(selfKey(account));
  return isUint(value) && value > 0 ? value : null;
}

export async function setSelf(account: AccountKey, value: number): Promise<void> {
  if (account.username.length === 0) throw new RangeError("self: expected an account");
  if (!isUint(value) || value === 0) throw new RangeError("self: expected a positive uint");
  await write(selfKey(account), value);
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
  /** Current invite token, for joining an invite-only group from its link. */
  invite?: string;
  username?: string;
  displayName?: string;
  bio?: string;
  parent?: number;
  target?: number;
  emoji?: number;
  on?: boolean;
  /** Inline image placeholder for a post, reply or DM. The upload happens before queueing. */
  media?: StoredMedia;
  /**
   * Set when the server refused this op for good and retrying cannot help (ADR 0013).
   * The row stays so the UI can show the draft and offer discard; it is never resent.
   */
  failed?: number;
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
  if (typeof row.invite === "string") op.invite = row.invite;
  if (typeof row.username === "string") op.username = row.username;
  if (typeof row.displayName === "string") op.displayName = row.displayName;
  if (typeof row.bio === "string") op.bio = row.bio;
  if (isUint(row.parent)) op.parent = row.parent;
  if (isUint(row.target)) op.target = row.target;
  if (isUint(row.emoji)) op.emoji = row.emoji;
  if (typeof row.on === "boolean") op.on = row.on;
  if (row.media !== undefined && row.media !== null) {
    const media = readMedia(row.media);
    if (media) op.media = media;
  }
  if (isUint(row.failed) && row.failed > 0) op.failed = row.failed;
  return op;
}

export async function getOutbox(account: AccountKey): Promise<StoredOp[]> {
  const rows = await read(outboxKey(account));
  if (!Array.isArray(rows)) return [];
  return rows.map(asStoredOp).filter((op): op is StoredOp => op !== null);
}

/** Queues one op with a fresh device-chosen cid. It stays queued until an ack arrives. */
export async function enqueueOp(account: AccountKey, op: Omit<StoredOp, "cid">): Promise<StoredOp> {
  const cid = Array.from(crypto.getRandomValues(new Uint8Array(8)));
  const stored: StoredOp = { ...op, cid };
  const outbox = await getOutbox(account);
  outbox.push(stored);
  await write(outboxKey(account), outbox);
  return stored;
}

/** Ops that still need a server answer, oldest first. Failed rows are deliberately left out. */
export async function getPendingOps(account: AccountKey): Promise<StoredOp[]> {
  return (await getOutbox(account)).filter((op) => op.failed === undefined);
}

/** Ops the server refused for good, kept for the draft text and the discard action. */
export async function getFailedOps(account: AccountKey): Promise<StoredOp[]> {
  return (await getOutbox(account)).filter((op) => op.failed !== undefined);
}

/**
 * Applies one sync response's acks. A success drops the row. A NotFound ack keeps it as
 * failed with its draft, because the target was deleted while the device was offline and
 * retrying can never succeed (ADR 0013). Other nacks drop the row, as before: resending
 * would produce the same refusal.
 */
export async function settleOutbox(account: AccountKey, acks: readonly Ack[]): Promise<StoredOp[]> {
  if (acks.length === 0) return [];
  const byCid = new Map(acks.map((ack) => [cidHex(ack.cid), ack]));
  const outbox = await getOutbox(account);
  const failed: StoredOp[] = [];
  const kept: StoredOp[] = [];
  for (const op of outbox) {
    const ack = byCid.get(cidHex(op.cid));
    if (!ack) {
      kept.push(op);
      continue;
    }
    // A successful ack and every other nack need no row: nothing sends them again.
    if ("error" in ack && ack.error === AckError.NotFound) {
      const row: StoredOp = { ...op, failed: ack.error };
      failed.push(row);
      kept.push(row);
    }
  }
  await write(outboxKey(account), kept);
  return failed;
}

/** Removes one failed op after the user has copied its text. */
export async function discardOutbox(account: AccountKey, cid: ArrayLike<number>): Promise<void> {
  await removeOutbox(account, [cid]);
}

function cidHex(cid: ArrayLike<number>): string {
  let out = "";
  for (let index = 0; index < cid.length; index++) out += (cid[index] ?? 0).toString(16).padStart(2, "0");
  return out;
}

/** Drops every named op. Success acks use settleOutbox; discard uses this. */
export async function removeOutbox(account: AccountKey, cids: readonly ArrayLike<number>[]): Promise<void> {
  if (cids.length === 0) return;
  const done = new Set(cids.map((cid) => cidHex(cid)));
  const outbox = await getOutbox(account);
  await write(outboxKey(account), outbox.filter((op) => !done.has(cidHex(op.cid))));
}

function toWireMedia(media: StoredMedia | undefined): Media | null {
  if (!media) return null;
  return { id: media.id, w: media.w, h: media.h, thumbhash: new Uint8Array(media.thumbhash) };
}

/** Turns a stored row back into the protocol's op shape, with a real `cid` byte array. */
export function toWireOp(op: StoredOp): Op {
  const cid = new Uint8Array(op.cid);
  switch (op.tag) {
    case Tag.Post:
      return { cid, tag: Tag.Post, scope: op.scope, text: op.text ?? "", media: toWireMedia(op.media) };
    case Tag.Reply:
      return {
        cid,
        tag: Tag.Reply,
        scope: op.scope,
        parent: op.parent ?? 0,
        text: op.text ?? "",
        media: toWireMedia(op.media),
      };
    case Tag.Reaction:
      return {
        cid,
        tag: Tag.Reaction,
        scope: op.scope,
        target: op.target ?? 0,
        emoji: op.emoji ?? 0,
        on: op.on === true,
      };
    case Tag.Delete:
      return { cid, tag: Tag.Delete, scope: op.scope, target: op.target ?? 0 };
    case Tag.Ban:
      return { cid, tag: Tag.Ban, scope: op.scope, user: op.user ?? 0, on: op.on === true };
    case Tag.Dm:
      return {
        cid,
        tag: Tag.Dm,
        scope: op.scope,
        peer: op.peer ?? 0,
        text: op.text ?? "",
        media: toWireMedia(op.media),
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
    case Tag.Membership: {
      const membership: Op = {
        cid,
        tag: Tag.Membership,
        scope: op.scope,
        user: op.user ?? 0,
        role: (op.role ?? Role.Member) as typeof Role.Member,
      };
      // exactOptionalPropertyTypes: only present when the link carried a token.
      return op.invite === undefined ? membership : { ...membership, invite: op.invite };
    }
    case Tag.Profile:
      return {
        cid,
        tag: Tag.Profile,
        scope: 0,
        username: op.username ?? "",
        displayName: op.displayName ?? "",
        bio: op.bio ?? "",
      };
    case Tag.Block:
      return { cid, tag: Tag.Block, scope: 0, user: op.user ?? 0, on: op.on === true };
    default:
      throw new Error(`outbox: unsupported tag ${op.tag}`);
  }
}
