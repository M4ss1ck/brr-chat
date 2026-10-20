// The append-only log and the group state built from it. Every op is validated against the
// current membership, appended as canonical event bytes, and projected into the small tables
// that make the next sync cheap. See docs/PROTOCOL.md and ADR 0010.
import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import {
  AckError,
  Role,
  Tag,
  decodeEventBytes,
  encodeEventBytes,
  type Ack,
  type Event,
  type Op,
} from "@brr-chat/protocol";
import { headCursor } from "./db.ts";

/** How long a cid is remembered, so a retry returns the original seq (docs/PROTOCOL.md). */
export const OUTBOX_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Group creation is gated on an account at least this old (ADR 0010). */
export const GROUP_CREATE_MIN_AGE_SECONDS = 24 * 60 * 60;
/** Paging: at most this many events, or this many bytes of stored event payload. */
export const MAX_SYNC_EVENTS = 500;
export const MAX_SYNC_BYTES = 64 * 1024;

export interface Actor {
  /** BetterAuth's text id. */
  id: string;
  /** The uint every event and op uses. */
  wireId: number;
  /** Account creation, Unix seconds. */
  createdAt: number;
}

interface GroupRow {
  id: number;
  open: number;
  invite_token: string | null;
}

/** Bytes of randomness in one invite token. 128 bits, URL-safe, one per invite-only group. */
export const INVITE_TOKEN_BYTES = 16;

/** A fresh invite token. Base64url keeps it copy-pasteable and safe in a URL or QR code. */
export function newInviteToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(INVITE_TOKEN_BYTES))).toString("base64url");
}

/** Constant-time comparison: a wrong token must not reveal how much of it was right. */
export function inviteMatches(group: Pick<GroupRow, "invite_token">, token: string | null | undefined): boolean {
  if (group.invite_token === null || typeof token !== "string" || token.length === 0) return false;
  const expected = Buffer.from(group.invite_token, "utf8");
  const actual = Buffer.from(token, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

interface MemberRow {
  group_id: number;
  user_id: number;
  role: number;
  seq: number;
}

interface DmScopeRow {
  id: number;
  user_a: number;
  user_b: number;
}

interface EventRow {
  seq: number;
  bytes: Uint8Array;
}

interface PriorOpRow {
  tag: number;
  seq: number;
  created_at: number;
}

/** Stable wire id for an account, allocated on first use. */
export function actorFor(db: Database, userId: string): Actor {
  const user = db.query("SELECT createdAt FROM user WHERE id = ?").get(userId) as { createdAt: string } | null;
  if (!user) throw new Error(`unknown user ${userId}`);
  const parsed = Date.parse(user.createdAt);
  const createdAt = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);

  const existing = db.query("SELECT wire_id FROM wire_users WHERE id = ?").get(userId) as { wire_id: number } | null;
  if (existing) return { id: userId, wireId: Number(existing.wire_id), createdAt };

  const wireId = db.transaction((): number => {
    const again = db.query("SELECT wire_id FROM wire_users WHERE id = ?").get(userId) as { wire_id: number } | null;
    if (again) return Number(again.wire_id);
    const row = db.query("SELECT COALESCE(MAX(wire_id), 0) + 1 AS next FROM wire_users").get() as { next: number };
    const next = Number(row.next);
    db.query("INSERT INTO wire_users (id, wire_id, created_at) VALUES (?, ?, ?)").run(userId, next, createdAt);
    return next;
  })();

  return { id: userId, wireId, createdAt };
}

export interface OutboxResult {
  acks: Ack[];
  /** True when this batch opened a scope (created or joined a group): answer with state. */
  state: boolean;
  /** First event created by this batch, or null when it created none. */
  firstSeq: number | null;
}

type Applied = { seq: number; firstSeq: number; state: boolean };
type Failure = { error: AckError };

function nextSeq(db: Database): number {
  const row = db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events").get() as { seq: number };
  return Number(row.seq);
}

function insertEventAt(db: Database, seq: number, build: (seq: number) => Event): number {
  const event = build(seq);
  db.query("INSERT INTO events (seq, tag, ts, author, scope, bytes) VALUES (?, ?, ?, ?, ?, ?)").run(
    seq,
    event.tag,
    event.ts,
    event.author,
    event.scope,
    encodeEventBytes(event),
  );
  return seq;
}

function insertEvent(db: Database, build: (seq: number) => Event): number {
  return insertEventAt(db, nextSeq(db), build);
}

export function groupFor(db: Database, id: number): GroupRow | null {
  return db.query("SELECT id, open, invite_token FROM chat_groups WHERE id = ?").get(id) as GroupRow | null;
}

/** Resolves the one live token to its group; a rotated token finds nothing. */
export function groupForInviteToken(db: Database, token: string): GroupRow | null {
  return db.query("SELECT id, open, invite_token FROM chat_groups WHERE invite_token = ?").get(token) as GroupRow | null;
}

export function memberFor(db: Database, groupId: number, wireId: number): MemberRow | null {
  return db
    .query("SELECT group_id, user_id, role, seq FROM group_members WHERE group_id = ? AND user_id = ?")
    .get(groupId, wireId) as MemberRow | null;
}

/** A group op needs a real group scope and current membership; null means allowed. */
function groupAccessError(db: Database, actor: Actor, scope: number): AckError | null {
  if (scope === 0) return AckError.Invalid;
  if (!groupFor(db, scope)) return AckError.NotFound;
  if (!memberFor(db, scope, actor.wireId)) return AckError.Forbidden;
  return null;
}

interface EventHeaderRow {
  tag: number;
  scope: number;
}

/** Tag and scope of an existing event, or null when the seq is unknown. */
function headerFor(db: Database, seq: number): EventHeaderRow | null {
  const row = db.query("SELECT tag, scope FROM events WHERE seq = ?").get(seq) as EventHeaderRow | null;
  return row ? { tag: Number(row.tag), scope: Number(row.scope) } : null;
}

/** The scope row for an unordered pair, or null when these two have never talked. */
function dmScopeForPair(db: Database, a: number, b: number): DmScopeRow | null {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return db.query("SELECT id, user_a, user_b FROM dm_scopes WHERE user_a = ? AND user_b = ?").get(lo, hi) as
    | DmScopeRow
    | null;
}

function dmScopeById(db: Database, id: number): DmScopeRow | null {
  return db.query("SELECT id, user_a, user_b FROM dm_scopes WHERE id = ?").get(id) as DmScopeRow | null;
}

function peerIsKnown(db: Database, wireId: number): boolean {
  return db.query("SELECT 1 AS ok FROM wire_users WHERE wire_id = ?").get(wireId) !== null;
}

function rememberOp(db: Database, actor: Actor, op: Op, tag: number, seq: number, now: number): void {
  db.query("INSERT INTO outbox_ops (user_id, cid, tag, seq, created_at) VALUES (?, ?, ?, ?, ?)").run(
    actor.id,
    op.cid,
    tag,
    seq,
    now,
  );
}

/** Applies one op. Every path returns an event seq or an ack error; nothing throws. */
function applyOp(db: Database, actor: Actor, op: Op, now: number): Applied | Failure {
  switch (op.tag) {
    case Tag.GroupMeta: {
      if (op.scope !== 0) return { error: AckError.Invalid };
      if (now - actor.createdAt < GROUP_CREATE_MIN_AGE_SECONDS) return { error: AckError.Forbidden };
      if (op.name.trim().length === 0) return { error: AckError.Invalid };
      const groupId = insertEvent(db, (seq) => ({
        tag: Tag.GroupMeta,
        seq,
        ts: now,
        author: actor.wireId,
        scope: seq,
        name: op.name,
        about: op.about,
        open: op.open,
      }));
      db.query("INSERT INTO chat_groups (id, open, created_at, invite_token) VALUES (?, ?, ?, ?)").run(
        groupId,
        op.open ? 1 : 0,
        now,
        // Only an invite-only group needs a secret link; open groups have the open list.
        op.open ? null : newInviteToken(),
      );
      const memberSeq = insertEvent(db, (seq) => ({
        tag: Tag.Membership,
        seq,
        ts: now,
        author: actor.wireId,
        scope: groupId,
        user: actor.wireId,
        role: Role.Owner,
      }));
      db.query("INSERT INTO group_members (group_id, user_id, role, seq) VALUES (?, ?, ?, ?)").run(
        groupId,
        actor.wireId,
        Role.Owner,
        memberSeq,
      );
      return { seq: groupId, firstSeq: groupId, state: true };
    }
    case Tag.Membership: {
      if (op.scope === 0) return { error: AckError.Invalid };
      const group = groupFor(db, op.scope);
      if (!group) return { error: AckError.NotFound };
      if (op.user !== actor.wireId) return { error: AckError.Forbidden };
      const existing = memberFor(db, op.scope, actor.wireId);
      if (existing) {
        // Joining twice is idempotent; changing a role is group moderation, not this op.
        return existing.role === op.role
          ? { seq: Number(existing.seq), firstSeq: Number(existing.seq), state: true }
          : { error: AckError.Forbidden };
      }
      // An invite-only group is joinable only with its current link token (ADR 0010). Open
      // groups ignore any token the client happens to send. The token is an op field and is
      // never copied into the membership event.
      if (!group.open && !inviteMatches(group, op.invite)) return { error: AckError.Forbidden };
      if (op.role !== Role.Member) return { error: AckError.Forbidden };
      const seq = insertEvent(db, (next) => ({
        tag: Tag.Membership,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope: op.scope,
        user: actor.wireId,
        role: Role.Member,
      }));
      db.query("INSERT INTO group_members (group_id, user_id, role, seq) VALUES (?, ?, ?, ?)").run(
        op.scope,
        actor.wireId,
        Role.Member,
        seq,
      );
      return { seq, firstSeq: seq, state: true };
    }
    case Tag.Post: {
      // Group scopes only: DMs have their own tag and their own slice.
      const denied = groupAccessError(db, actor, op.scope);
      if (denied !== null) return { error: denied };
      if (op.text.trim().length === 0) return { error: AckError.Invalid };
      // Media needs the upload pipeline (ADR 0011); accepting it here would silently drop it.
      if (op.media !== null) return { error: AckError.Unsupported };
      const seq = insertEvent(db, (next) => ({
        tag: Tag.Post,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope: op.scope,
        text: op.text,
        media: null,
      }));
      return { seq, firstSeq: seq, state: false };
    }
    case Tag.Reply: {
      // One level only: a reply's parent must be a post in the same group.
      const denied = groupAccessError(db, actor, op.scope);
      if (denied !== null) return { error: denied };
      if (op.text.trim().length === 0) return { error: AckError.Invalid };
      if (op.media !== null) return { error: AckError.Unsupported };
      const parent = headerFor(db, op.parent);
      if (!parent) return { error: AckError.NotFound };
      // A reply is not a valid parent, even in the right scope: that is Invalid, not NotFound.
      if (parent.tag !== Tag.Post) return { error: AckError.Invalid };
      if (parent.scope !== op.scope) return { error: AckError.NotFound };
      const seq = insertEvent(db, (next) => ({
        tag: Tag.Reply,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope: op.scope,
        parent: op.parent,
        text: op.text,
        media: null,
      }));
      return { seq, firstSeq: seq, state: false };
    }
    case Tag.Reaction: {
      // The palette range (0..7) is already enforced by the op decoder.
      const denied = groupAccessError(db, actor, op.scope);
      if (denied !== null) return { error: denied };
      const target = headerFor(db, op.target);
      if (!target || target.scope !== op.scope) return { error: AckError.NotFound };
      if (target.tag !== Tag.Post && target.tag !== Tag.Reply) return { error: AckError.Invalid };
      // Toggling is append-only: each press writes on/off, and clients keep the latest one.
      const seq = insertEvent(db, (next) => ({
        tag: Tag.Reaction,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope: op.scope,
        target: op.target,
        emoji: op.emoji,
        on: op.on,
      }));
      return { seq, firstSeq: seq, state: false };
    }
    case Tag.Dm: {
      if (op.peer === 0 || op.peer === actor.wireId) return { error: AckError.Invalid };
      if (op.text.trim().length === 0) return { error: AckError.Invalid };
      // Media needs the upload pipeline (ADR 0011); accepting it here would silently drop it.
      if (op.media !== null) return { error: AckError.Unsupported };

      let scope = op.scope;
      let firstSeq: number;
      let created = false;

      if (scope === 0) {
        // A DM op with scope 0 opens (or reuses) the one scope for this pair. The scope id is
        // the seq of the dm_scope event, so the pair and the first message share a log position.
        if (!peerIsKnown(db, op.peer)) return { error: AckError.NotFound };
        const existing = dmScopeForPair(db, actor.wireId, op.peer);
        if (existing) {
          scope = existing.id;
        } else {
          const candidate = nextSeq(db);
          db.query("INSERT OR IGNORE INTO dm_scopes (id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)").run(
            candidate,
            Math.min(actor.wireId, op.peer),
            Math.max(actor.wireId, op.peer),
            now,
          );
          // A concurrent first message may have won the unique pair index. Either way there is
          // now exactly one row, and the scope id is whatever it says.
          const row = dmScopeForPair(db, actor.wireId, op.peer);
          if (!row) throw new Error("dm scope vanished inside its own transaction");
          scope = row.id;
          created = row.id === candidate;
          if (created) {
            insertEventAt(db, candidate, (seq) => ({
              tag: Tag.DmScope,
              seq,
              ts: now,
              author: actor.wireId,
              scope,
              peer: op.peer,
            }));
          }
        }
      } else {
        const dm = dmScopeById(db, scope);
        if (!dm) return { error: AckError.NotFound };
        if (dm.user_a !== actor.wireId && dm.user_b !== actor.wireId) return { error: AckError.Forbidden };
        const other = dm.user_a === actor.wireId ? dm.user_b : dm.user_a;
        if (other !== op.peer) return { error: AckError.Invalid };
      }

      const seq = nextSeq(db);
      insertEventAt(db, seq, (next) => ({
        tag: Tag.Dm,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope,
        peer: op.peer,
        text: op.text,
        media: null,
      }));
      firstSeq = created ? scope : seq;
      return { seq, firstSeq, state: false };
    }
    case Tag.Profile: {
      if (op.scope !== 0) return { error: AckError.Invalid };
      if (op.username.trim().length === 0) return { error: AckError.Invalid };
      const seq = insertEvent(db, (next) => ({
        tag: Tag.Profile,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope: 0,
        username: op.username,
        displayName: op.displayName,
        bio: op.bio,
      }));
      return { seq, firstSeq: seq, state: false };
    }
    default:
      // Delete and ban arrive in later slices. The tag is known, but this server does not
      // implement it yet, so the device gets a nack instead of a silent drop.
      return { error: AckError.Unsupported };
  }
}

/** Applies a whole outbox in one transaction: all of it, or none of it. */
export function applyOutbox(db: Database, actor: Actor, ops: readonly Op[], now = Math.floor(Date.now() / 1000)): OutboxResult {
  return db.transaction((): OutboxResult => {
    db.query("DELETE FROM outbox_ops WHERE created_at < ?").run(now - OUTBOX_TTL_SECONDS);

    const acks: Ack[] = [];
    let state = false;
    let firstSeq: number | null = null;

    for (const op of ops) {
      const prior = db
        .query("SELECT tag, seq, created_at FROM outbox_ops WHERE user_id = ? AND cid = ?")
        .get(actor.id, op.cid) as PriorOpRow | null;

      if (prior && now - Number(prior.created_at) <= OUTBOX_TTL_SECONDS) {
        acks.push({ cid: op.cid, seq: Number(prior.seq) });
        // A retried create or join lost its first response: send the state snapshot again.
        if (Number(prior.tag) === Tag.GroupMeta || Number(prior.tag) === Tag.Membership) {
          state = true;
          if (firstSeq === null) firstSeq = Number(prior.seq);
        }
        continue;
      }
      if (prior) {
        db.query("DELETE FROM outbox_ops WHERE user_id = ? AND cid = ?").run(actor.id, op.cid);
      }

      const applied = applyOp(db, actor, op, now);
      if ("error" in applied) {
        acks.push({ cid: op.cid, error: applied.error });
        continue;
      }
      rememberOp(db, actor, op, op.tag, applied.seq, now);
      acks.push({ cid: op.cid, seq: applied.seq });
      state = state || applied.state;
      if (firstSeq === null) firstSeq = applied.firstSeq;
    }

    return { acks, state, firstSeq };
  })();
}

// One viewer placeholder per branch; callers bind the viewer once per `?` (three times).
const VISIBLE_SQL = `
  e.scope = 0
  OR e.scope IN (SELECT group_id FROM group_members WHERE user_id = ?)
  OR e.scope IN (SELECT id FROM dm_scopes WHERE user_a = ? OR user_b = ?)
  OR (e.tag = ${Tag.GroupMeta} AND e.scope IN (SELECT id FROM chat_groups WHERE open = 1))
`;

function decodeRows(rows: EventRow[]): Event[] {
  const events: Event[] = [];
  for (const row of rows) {
    try {
      const event = decodeEventBytes(row.bytes);
      if (event) events.push(event);
    } catch {
      // A corrupt row must not wedge one device's sync forever (docs/PROTOCOL.md).
    }
  }
  return events;
}

export interface VisiblePage {
  events: Event[];
  more: boolean;
  cursor: number;
}

/** Events after `cursor` the viewer may see, oldest first, paged by count and bytes. */
export function visibleEvents(db: Database, viewer: number, cursor: number): VisiblePage {
  const rows = db
    .query(
      `SELECT e.seq, e.bytes FROM events e
       WHERE e.seq > ? AND (${VISIBLE_SQL})
       ORDER BY e.seq ASC
       LIMIT ?`,
    )
    .all(cursor, viewer, viewer, viewer, MAX_SYNC_EVENTS + 1) as EventRow[];

  const events: Event[] = [];
  let bytes = 0;
  let more = rows.length > MAX_SYNC_EVENTS;
  for (const row of rows) {
    if (events.length >= MAX_SYNC_EVENTS || (events.length > 0 && bytes + row.bytes.length > MAX_SYNC_BYTES)) {
      more = true;
      break;
    }
    let event: Event | null;
    try {
      event = decodeEventBytes(row.bytes);
    } catch {
      // A corrupt row is dropped, like an unknown tag: one bad event must not wedge sync.
      continue;
    }
    if (!event) continue;
    events.push(event);
    bytes += row.bytes.length;
  }

  const last = events.at(-1);
  return { events, more, cursor: more && last ? last.seq : headCursor(db) };
}

/** Events created by this batch that the viewer may see, regardless of their old cursor. */
export function visibleFrom(db: Database, viewer: number, firstSeq: number): Event[] {
  const rows = db
    .query(
      `SELECT e.seq, e.bytes FROM events e
       WHERE e.seq >= ? AND (${VISIBLE_SQL})
       ORDER BY e.seq ASC`,
    )
    .all(firstSeq, viewer, viewer, viewer) as EventRow[];
  return decodeRows(rows);
}

/**
 * Current state for a fresh device or a new join: latest profiles, group metadata the viewer
 * may see, and current memberships of the viewer's groups. Never posts (ADR 0009).
 */
export function stateEvents(db: Database, viewer: number): Event[] {
  const profiles = db
    .query(
      `SELECT e.bytes FROM events e
       WHERE e.tag = ${Tag.Profile}
         AND e.seq = (SELECT MAX(p.seq) FROM events p WHERE p.tag = ${Tag.Profile} AND p.author = e.author)
       ORDER BY e.seq ASC`,
    )
    .all() as EventRow[];
  const groups = db
    .query(
      `SELECT e.bytes FROM events e
       WHERE e.tag = ${Tag.GroupMeta}
         AND e.seq = (SELECT MAX(g.seq) FROM events g WHERE g.tag = ${Tag.GroupMeta} AND g.scope = e.scope)
         AND (e.scope IN (SELECT id FROM chat_groups WHERE open = 1)
              OR e.scope IN (SELECT group_id FROM group_members WHERE user_id = ?))
       ORDER BY e.seq ASC`,
    )
    .all(viewer) as EventRow[];
  const members = db
    .query(
      `SELECT e.bytes FROM group_members m JOIN events e ON e.seq = m.seq
       WHERE m.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
       ORDER BY e.seq ASC`,
    )
    .all(viewer) as EventRow[];
  // A fresh device learns which DM conversations exist, but no messages (ADR 0009). The
  // dm_scope event names the pair and its seq is the scope id, exactly like group metadata.
  const dms = db
    .query(
      `SELECT e.bytes FROM events e
       WHERE e.tag = ${Tag.DmScope}
         AND e.seq = (SELECT MAX(d.seq) FROM events d WHERE d.tag = ${Tag.DmScope} AND d.scope = e.scope)
         AND e.scope IN (SELECT id FROM dm_scopes WHERE user_a = ? OR user_b = ?)
       ORDER BY e.seq ASC`,
    )
    .all(viewer, viewer) as EventRow[];
  return decodeRows([...profiles, ...groups, ...members, ...dms]).sort((a, b) => a.seq - b.seq);
}

/** Merges events by seq. State events can sit at or below the old cursor; the client applies them. */
export function mergeEvents(...lists: Event[][]): Event[] {
  const bySeq = new Map<number, Event>();
  for (const list of lists) for (const event of list) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
