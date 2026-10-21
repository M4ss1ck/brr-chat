// The append-only log and the group state built from it. Every op is validated against the
// current membership, appended as canonical event bytes, and projected into the small tables
// that make the next sync cheap. See docs/PROTOCOL.md and ADR 0010.
import type { Database } from "bun:sqlite";
import {
  AckError,
  GAP_COVERED_TAGS,
  Role,
  Tag,
  decodeEventBytes,
  encodeEventBytes,
  type Ack,
  type Event,
  type Op,
} from "@brr-chat/protocol";
import { headCursor } from "./db.ts";
import { AbuseLimiters } from "./limits.ts";
import { isServerAdmin, tokenMatches } from "./settings.ts";

/** How long a cid is remembered, so a retry returns the original seq (docs/PROTOCOL.md). */
export const OUTBOX_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Group creation is gated on an account at least this old (ADR 0010). */
export const GROUP_CREATE_MIN_AGE_SECONDS = 24 * 60 * 60;
/** Paging: at most this many events, or this many bytes of stored event payload. */
export const MAX_SYNC_EVENTS = 500;
export const MAX_SYNC_BYTES = 64 * 1024;
/** Past this many missed content events in one scope, catch-up sends a gap instead (ADR 0009). */
export const GAP_AFTER_MISSED_EVENTS = 100;

const GAP_TAG_LIST = GAP_COVERED_TAGS.join(", ");

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
  return tokenMatches(group.invite_token, token);
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

interface BanRow {
  group_id: number;
  user_id: number;
  banned: number;
  seq: number;
}

interface ServerUserRow {
  id: string;
  banned: number | null;
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
  author: number;
}

/** Tag, scope and author of an existing event, or null when the seq is unknown. */
function headerFor(db: Database, seq: number): EventHeaderRow | null {
  const row = db.query("SELECT tag, scope, author FROM events WHERE seq = ?").get(seq) as EventHeaderRow | null;
  return row ? { tag: Number(row.tag), scope: Number(row.scope), author: Number(row.author) } : null;
}

function groupRole(db: Database, groupId: number, wireId: number): number {
  return memberFor(db, groupId, wireId)?.role ?? Role.None;
}

function groupBanFor(db: Database, groupId: number, wireId: number): BanRow | null {
  return db
    .query("SELECT group_id, user_id, banned, seq FROM group_bans WHERE group_id = ? AND user_id = ?")
    .get(groupId, wireId) as BanRow | null;
}

function deletionFor(db: Database, scope: number, target: number): { seq: number } | null {
  return db.query("SELECT seq FROM deleted_events WHERE scope = ? AND target = ?").get(scope, target) as
    | { seq: number }
    | null;
}

/** Writes the current membership row and its event. `author` is 0 for server-generated changes. */
function setMembership(
  db: Database,
  scope: number,
  userId: number,
  role: number,
  author: number,
  now: number,
): number {
  const seq = insertEvent(db, (next) => ({
    tag: Tag.Membership,
    seq: next,
    ts: now,
    author,
    scope,
    user: userId,
    role,
  }));
  if (role === Role.None) {
    db.query("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(scope, userId);
  } else {
    db.query(
      `INSERT INTO group_members (group_id, user_id, role, seq) VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role, seq = excluded.seq`,
    ).run(scope, userId, role, seq);
    // A stale purge must not wipe a group the user has since rejoined.
    db.query("DELETE FROM scope_lefts WHERE user_id = ? AND scope = ?").run(userId, scope);
  }
  return seq;
}

/** Appends the server-generated purge event and makes it visible to the user who lost access. */
function recordScopeLeft(db: Database, userId: number, scope: number, now: number): number {
  const seq = insertEvent(db, (next) => ({
    tag: Tag.ScopeLeft,
    seq: next,
    ts: now,
    author: 0,
    scope,
    purge: true,
  }));
  db.query(
    `INSERT INTO scope_lefts (user_id, scope, seq) VALUES (?, ?, ?)
     ON CONFLICT(user_id, scope) DO UPDATE SET seq = excluded.seq`,
  ).run(userId, scope, seq);
  return seq;
}

/** Lifts a group ban with an event, so the log still says who stopped the ban and when. */
function liftGroupBan(db: Database, groupId: number, userId: number, author: number, now: number): void {
  if (groupBanFor(db, groupId, userId)?.banned !== 1) return;
  const seq = insertEvent(db, (next) => ({
    tag: Tag.Ban,
    seq: next,
    ts: now,
    author,
    scope: groupId,
    user: userId,
    on: false,
  }));
  db.query("UPDATE group_bans SET banned = 0, seq = ? WHERE group_id = ? AND user_id = ?").run(
    seq,
    groupId,
    userId,
  );
}

function serverUserFor(db: Database, wireId: number): ServerUserRow | null {
  return db
    .query("SELECT u.id AS id, u.banned AS banned FROM wire_users w JOIN user u ON u.id = w.id WHERE w.wire_id = ?")
    .get(wireId) as ServerUserRow | null;
}

/**
 * Who inherits a group when its owner leaves or is banned server-wide (ADR 0010): the
 * longest-serving current group admin, else the oldest server admin who is not the owner.
 * Banned accounts are never successors.
 */
function successorForGroup(db: Database, groupId: number, ownerWire: number): number | null {
  const admin = db
    .query(
      `SELECT m.user_id AS user_id FROM group_members m
       LEFT JOIN wire_users w ON w.wire_id = m.user_id
       LEFT JOIN user u ON u.id = w.id
       WHERE m.group_id = ? AND m.role = ? AND m.user_id <> ?
         AND (u.banned IS NULL OR u.banned = 0)
       ORDER BY m.seq ASC LIMIT 1`,
    )
    .get(groupId, Role.Admin, ownerWire) as { user_id: number } | null;
  if (admin) return Number(admin.user_id);

  const serverAdmin = db
    .query(
      `SELECT w.wire_id AS wire_id FROM user u JOIN wire_users w ON w.id = u.id
       WHERE (',' || replace(u.role, ' ', '') || ',') LIKE '%,admin,%'
         AND (u.banned IS NULL OR u.banned = 0) AND w.wire_id <> ?
         AND w.wire_id NOT IN (SELECT user_id FROM group_bans WHERE group_id = ? AND banned = 1)
       ORDER BY u.createdAt ASC LIMIT 1`,
    )
    .get(ownerWire, groupId) as { wire_id: number } | null;
  return serverAdmin ? Number(serverAdmin.wire_id) : null;
}

/** Hands `ownerWire`'s group to the next owner. Returns false when nobody can take it. */
function handOverOwnership(db: Database, groupId: number, ownerWire: number, now: number): boolean {
  const successor = successorForGroup(db, groupId, ownerWire);
  if (successor === null) return false;
  setMembership(db, groupId, successor, Role.Owner, 0, now);
  return true;
}

/** The block lookup for one viewer and the event's author, shared by /sync and the DM list. */
const BLOCKED_AUTHOR_SQL = `EXISTS (
  SELECT 1 FROM user_blocks b WHERE b.blocker = ? AND b.blocked = e.author
)`;

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
function applyOp(db: Database, actor: Actor, op: Op, now: number, limits: AbuseLimiters): Applied | Failure {
  // The log works in seconds; the in-memory budgets work in milliseconds.
  const nowMs = now * 1000;
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
      const existing = memberFor(db, op.scope, op.user);

      if (op.user === actor.wireId) {
        // A member changes only their own row: join, leave, or replay a join.
        if (op.role === Role.Member) {
          if (existing) {
            return existing.role === Role.Member
              ? { seq: Number(existing.seq), firstSeq: Number(existing.seq), state: true }
              : { error: AckError.Forbidden };
          }
          // An invite-only group is joinable only with its current link token (ADR 0016). Open
          // groups ignore any token the client happens to send. The token is an op field and
          // is never copied into the membership event.
          if (!group.open && !inviteMatches(group, op.invite)) return { error: AckError.Forbidden };
          // A ban survives until an admin lifts it: being kicked is not a way around it.
          if (groupBanFor(db, op.scope, op.user)?.banned === 1) return { error: AckError.Forbidden };
          const seq = setMembership(db, op.scope, actor.wireId, Role.Member, actor.wireId, now);
          return { seq, firstSeq: seq, state: true };
        }

        if (op.role === Role.None) {
          if (!existing) return { error: AckError.NotFound };
          if (existing.role === Role.Owner) {
            // Resolve the successor before writing anything: a failed op must change nothing.
            const successor = successorForGroup(db, op.scope, actor.wireId);
            if (successor === null) return { error: AckError.Forbidden };
            // Leaving without transferring hands the group on in the same transaction.
            const seq = setMembership(db, op.scope, actor.wireId, Role.None, actor.wireId, now);
            setMembership(db, op.scope, successor, Role.Owner, 0, now);
            recordScopeLeft(db, actor.wireId, op.scope, now);
            return { seq, firstSeq: seq, state: false };
          }
          const seq = setMembership(db, op.scope, actor.wireId, Role.None, actor.wireId, now);
          recordScopeLeft(db, actor.wireId, op.scope, now);
          return { seq, firstSeq: seq, state: false };
        }

        // Promoting yourself is not this op: only the owner changes roles.
        return { error: AckError.Forbidden };
      }
      // Changing someone else's role is owner-only (ADR 0010).
      if (groupRole(db, op.scope, actor.wireId) !== Role.Owner) return { error: AckError.Forbidden };
      if (!existing) return { error: AckError.NotFound };
      if (existing.role === op.role) return { seq: Number(existing.seq), firstSeq: Number(existing.seq), state: false };

      if (op.role === Role.Owner) {
        // Transfer is one transaction: the target becomes owner, the old owner becomes admin.
        const targetSeq = setMembership(db, op.scope, op.user, Role.Owner, actor.wireId, now);
        setMembership(db, op.scope, actor.wireId, Role.Admin, actor.wireId, now);
        return { seq: targetSeq, firstSeq: targetSeq, state: false };
      }

      if (op.role === Role.Admin) {
        if (existing.role !== Role.Member) return { error: AckError.Forbidden };
        const seq = setMembership(db, op.scope, op.user, Role.Admin, actor.wireId, now);
        return { seq, firstSeq: seq, state: false };
      }

      if (op.role === Role.Member) {
        if (existing.role !== Role.Admin) return { error: AckError.Forbidden };
        const seq = setMembership(db, op.scope, op.user, Role.Member, actor.wireId, now);
        return { seq, firstSeq: seq, state: false };
      }

      if (op.role === Role.None) {
        if (existing.role === Role.Owner) return { error: AckError.Forbidden };
        const seq = setMembership(db, op.scope, op.user, Role.None, actor.wireId, now);
        recordScopeLeft(db, op.user, op.scope, now);
        return { seq, firstSeq: seq, state: false };
      }

      return { error: AckError.Invalid };
    }
    case Tag.Post: {
      // Group scopes only: DMs have their own tag and their own slice.
      const denied = groupAccessError(db, actor, op.scope);
      if (denied !== null) return { error: denied };
      if (op.text.trim().length === 0) return { error: AckError.Invalid };
      // Media needs the upload pipeline (ADR 0011); accepting it here would silently drop it.
      if (op.media !== null) return { error: AckError.Unsupported };
      if (!limits.allowsMessage(actor.id, nowMs)) return { error: AckError.RateLimited };
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
      if (deletionFor(db, op.scope, op.parent)) return { error: AckError.NotFound };
      if (!limits.allowsMessage(actor.id, nowMs)) return { error: AckError.RateLimited };
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
      if (deletionFor(db, op.scope, op.target)) return { error: AckError.NotFound };
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
    case Tag.Delete: {
      // The author, a group admin, or the owner. DM messages have no moderation.
      const denied = groupAccessError(db, actor, op.scope);
      if (denied !== null) return { error: denied };
      const target = headerFor(db, op.target);
      if (!target || target.scope !== op.scope) return { error: AckError.NotFound };
      if (target.tag !== Tag.Post && target.tag !== Tag.Reply) return { error: AckError.Invalid };
      if (target.author !== actor.wireId && groupRole(db, op.scope, actor.wireId) < Role.Admin) {
        return { error: AckError.Forbidden };
      }
      const already = deletionFor(db, op.scope, op.target);
      if (already) return { seq: Number(already.seq), firstSeq: Number(already.seq), state: false };
      const seq = insertEvent(db, (next) => ({
        tag: Tag.Delete,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope: op.scope,
        target: op.target,
      }));
      db.query("INSERT INTO deleted_events (scope, target, seq) VALUES (?, ?, ?)").run(op.scope, op.target, seq);
      return { seq, firstSeq: seq, state: false };
    }
    case Tag.Ban: {
      if (op.user === 0) return { error: AckError.Invalid };

      if (op.scope === 0) {
        // Server-wide ban: server admin only (ADR 0010).
        if (!isServerAdmin(db, actor.id)) return { error: AckError.Forbidden };
        const target = serverUserFor(db, op.user);
        if (!target) return { error: AckError.NotFound };
        if (target.id === actor.id) return { error: AckError.Forbidden };
        if (op.on) {
          db.query("UPDATE user SET banned = 1 WHERE id = ?").run(target.id);
          // Revoking every session is part of the ban, not a side effect: a token already in
          // a client's hand must stop working now, even if the client never calls /sync.
          db.query("DELETE FROM session WHERE userId = ?").run(target.id);
          // A server ban removes access everywhere, so every group membership goes, and an
          // owned group gets a successor in the same transaction.
          const memberships = db
            .query("SELECT group_id, role FROM group_members WHERE user_id = ?")
            .all(op.user) as { group_id: number; role: number }[];
          for (const row of memberships) {
            const groupId = Number(row.group_id);
            const owner = Number(row.role) === Role.Owner;
            setMembership(db, groupId, op.user, Role.None, 0, now);
            if (owner && !handOverOwnership(db, groupId, op.user, now)) {
              // The actor is the last server admin, but may itself be group-banned. Taking the
              // group is what lifts that ban: nobody can own a group they cannot enter.
              liftGroupBan(db, groupId, actor.wireId, actor.wireId, now);
              setMembership(db, groupId, actor.wireId, Role.Owner, 0, now);
            }
            recordScopeLeft(db, op.user, groupId, now);
          }
          // DM scopes are access too: the banned account's device purges every conversation.
          // The scope row stays, so the other participant keeps their side of the history.
          const dms = db
            .query("SELECT id FROM dm_scopes WHERE user_a = ? OR user_b = ?")
            .all(op.user, op.user) as { id: number }[];
          for (const row of dms) recordScopeLeft(db, op.user, Number(row.id), now);
        } else {
          db.query("UPDATE user SET banned = 0 WHERE id = ?").run(target.id);
          // DM scopes have no join: the pair row is the access. Clear their pending purge on
          // unban so the restored account can see the conversation again; group purges stay,
          // because a lifted ban does not restore group membership.
          db.query(
            `DELETE FROM scope_lefts
             WHERE user_id = ?
               AND scope IN (SELECT id FROM dm_scopes WHERE user_a = ? OR user_b = ?)`,
          ).run(op.user, op.user, op.user);
        }
        const seq = insertEvent(db, (next) => ({
          tag: Tag.Ban,
          seq: next,
          ts: now,
          author: actor.wireId,
          scope: 0,
          user: op.user,
          on: op.on,
        }));
        return { seq, firstSeq: seq, state: false };
      }

      const group = groupFor(db, op.scope);
      if (!group) return { error: AckError.NotFound };
      const actorRole = groupRole(db, op.scope, actor.wireId);
      if (actorRole < Role.Admin) return { error: AckError.Forbidden };
      if (op.user === actor.wireId) return { error: AckError.Forbidden };

      const ban = groupBanFor(db, op.scope, op.user);
      if (ban && ban.banned === (op.on ? 1 : 0)) {
        return { seq: Number(ban.seq), firstSeq: Number(ban.seq), state: false };
      }

      if (op.on) {
        const target = memberFor(db, op.scope, op.user);
        if (!target) return { error: AckError.NotFound };
        // Admins moderate members. Banning a peer or the owner is the owner's call.
        if (target.role === Role.Owner) return { error: AckError.Forbidden };
        if (actorRole === Role.Admin && target.role === Role.Admin) return { error: AckError.Forbidden };

        // A ban kicks: membership goes away, then the user is told to purge the scope.
        const firstSeq = setMembership(db, op.scope, op.user, Role.None, actor.wireId, now);
        const seq = insertEvent(db, (next) => ({
          tag: Tag.Ban,
          seq: next,
          ts: now,
          author: actor.wireId,
          scope: op.scope,
          user: op.user,
          on: true,
        }));
        recordScopeLeft(db, op.user, op.scope, now);
        db.query(
          `INSERT INTO group_bans (group_id, user_id, banned, seq) VALUES (?, ?, 1, ?)
           ON CONFLICT(group_id, user_id) DO UPDATE SET banned = 1, seq = excluded.seq`,
        ).run(op.scope, op.user, seq);
        return { seq, firstSeq, state: false };
      }

      // Unban keeps the person out until an admin lifts the ban; it does not restore membership.
      if (!ban) return { error: AckError.NotFound };
      const seq = insertEvent(db, (next) => ({
        tag: Tag.Ban,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope: op.scope,
        user: op.user,
        on: false,
      }));
      db.query("UPDATE group_bans SET banned = 0, seq = ? WHERE group_id = ? AND user_id = ?").run(
        seq,
        op.scope,
        op.user,
      );
      return { seq, firstSeq: seq, state: false };
    }
    case Tag.Dm: {
      if (op.peer === 0 || op.peer === actor.wireId) return { error: AckError.Invalid };
      if (op.text.trim().length === 0) return { error: AckError.Invalid };
      // Media needs the upload pipeline (ADR 0011); accepting it here would silently drop it.
      if (op.media !== null) return { error: AckError.Unsupported };

      let scope = op.scope;
      let opening = false;

      if (scope === 0) {
        // A scope-0 op opens (or reuses) the one scope for this pair. Only the first message
        // of a pair is a new thread: replies and later messages never draw on that budget.
        if (!peerIsKnown(db, op.peer)) return { error: AckError.NotFound };
        const existing = dmScopeForPair(db, actor.wireId, op.peer);
        if (existing) scope = existing.id;
        else opening = true;
      } else {
        const dm = dmScopeById(db, scope);
        if (!dm) return { error: AckError.NotFound };
        if (dm.user_a !== actor.wireId && dm.user_b !== actor.wireId) return { error: AckError.Forbidden };
        const other = dm.user_a === actor.wireId ? dm.user_b : dm.user_a;
        if (other !== op.peer) return { error: AckError.Invalid };
      }

      if (opening) {
        // ADR 0012: an account younger than 24h cannot start a conversation, but it can
        // always answer one an older account started.
        if (now - actor.createdAt < limits.config.dmCooldownSeconds) return { error: AckError.Forbidden };
        if (!limits.allowsNewDmThread(actor.id, nowMs)) return { error: AckError.RateLimited };
      }
      if (!limits.allowsMessage(actor.id, nowMs)) {
        // A rejected op created no thread, so give the daily slot back.
        if (opening) limits.refundNewDmThread(actor.id, nowMs);
        return { error: AckError.RateLimited };
      }

      let firstSeq: number;
      let created = false;

      if (opening) {
        // The scope id is the seq of the dm_scope event, so the pair and the first message
        // share a log position.
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
    case Tag.Block: {
      // ADR 0012: a personal, silent block. It is stored as server state and the event is
      // visible only to the blocker, so the blocked account is never told.
      if (op.scope !== 0) return { error: AckError.Invalid };
      if (op.user === 0 || op.user === actor.wireId) return { error: AckError.Invalid };
      if (!peerIsKnown(db, op.user)) return { error: AckError.NotFound };
      const seq = insertEvent(db, (next) => ({
        tag: Tag.Block,
        seq: next,
        ts: now,
        author: actor.wireId,
        scope: 0,
        user: op.user,
        on: op.on,
      }));
      db.query("INSERT INTO private_events (seq, viewer) VALUES (?, ?)").run(seq, actor.wireId);
      if (op.on) {
        db.query("INSERT OR IGNORE INTO user_blocks (blocker, blocked, created_at) VALUES (?, ?, ?)").run(
          actor.wireId,
          op.user,
          now,
        );
      } else {
        db.query("DELETE FROM user_blocks WHERE blocker = ? AND blocked = ?").run(actor.wireId, op.user);
      }
      return { seq, firstSeq: seq, state: false };
    }
    default:
      // Unknown op tags were already turned into Unsupported by the decoder.
      return { error: AckError.Unsupported };
  }
}

/** Applies a whole outbox in one transaction: all of it, or none of it. */
export function applyOutbox(
  db: Database,
  actor: Actor,
  ops: readonly Op[],
  limits: AbuseLimiters,
  now = Math.floor(Date.now() / 1000),
): OutboxResult {
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

      const applied = applyOp(db, actor, op, now, limits);
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

// Six viewer placeholders: group membership, two DM participants, a pending scope_left, the
// private-event viewer, and the blocker. Callers bind the same viewer id six times. A private
// block event reaches only its author, and a blocked author's posts, replies, reactions and
// DMs stop reaching the blocker (ADR 0012). The scope_left branch is the exception that makes
// leaving work: a kicked user is no longer a member, so only that map can still reach them.
const VISIBLE_SQL = `
  (
    e.scope = 0
    OR (e.tag <> ${Tag.ScopeLeft} AND e.scope IN (SELECT group_id FROM group_members WHERE user_id = ?))
    OR e.scope IN (SELECT id FROM dm_scopes WHERE user_a = ? OR user_b = ?)
    OR (e.tag = ${Tag.GroupMeta} AND e.scope IN (SELECT id FROM chat_groups WHERE open = 1))
    OR e.seq IN (SELECT seq FROM scope_lefts WHERE user_id = ?)
  )
  AND NOT EXISTS (SELECT 1 FROM private_events p WHERE p.seq = e.seq AND p.viewer <> ?)
  AND NOT (
    e.tag IN (${Tag.Post}, ${Tag.Reply}, ${Tag.Dm}, ${Tag.Reaction}, ${Tag.DmScope})
    AND ${BLOCKED_AUTHOR_SQL}
  )
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

/** VISIBLE_SQL binds the viewer six times, in order. */
function viewerArgs(viewer: number): number[] {
  return [viewer, viewer, viewer, viewer, viewer, viewer];
}

interface GapCutoff {
  scope: number;
  /** The device's cursor when the catch-up started. */
  after: number;
  /** First content event this sync still sends; the gap covers everything older. */
  before: number;
  /** Content events in (after, before) that are not sent. */
  count: number;
  /** Seq and ts of the last omitted event, so the marker has a real log position. */
  seq: number;
  ts: number;
}

/**
 * One cutoff per scope that missed more than GAP_AFTER_MISSED_EVENTS content events. The
 * newest GAP_AFTER_MISSED_EVENTS are still sent; the excess becomes a gap the user fills with
 * /history (ADR 0009).
 */
function gapCutoffs(db: Database, viewer: number, cursor: number): GapCutoff[] {
  const counts = db
    .query(
      `SELECT e.scope AS scope, COUNT(*) AS n FROM events e
       WHERE e.seq > ? AND e.scope <> 0 AND e.tag IN (${GAP_TAG_LIST}) AND (${VISIBLE_SQL})
       GROUP BY e.scope
       HAVING COUNT(*) > ?`,
    )
    .all(cursor, ...viewerArgs(viewer), GAP_AFTER_MISSED_EVENTS) as { scope: number; n: number }[];

  const cuts: GapCutoff[] = [];
  for (const row of counts) {
    const scope = Number(row.scope);
    const missed = Number(row.n) - GAP_AFTER_MISSED_EVENTS;
    // The last omitted event and the first kept one are adjacent in this scope's content.
    const pair = db
      .query(
        `SELECT e.seq, e.ts FROM events e
         WHERE e.seq > ? AND e.scope = ? AND e.tag IN (${GAP_TAG_LIST}) AND (${VISIBLE_SQL})
         ORDER BY e.seq ASC
         LIMIT 2 OFFSET ?`,
      )
      .all(cursor, scope, ...viewerArgs(viewer), missed - 1) as { seq: number; ts: number }[];
    const last = pair[0];
    const first = pair[1];
    if (!last || !first) continue;
    cuts.push({
      scope,
      after: cursor,
      before: Number(first.seq),
      count: missed,
      seq: Number(last.seq),
      ts: Number(last.ts),
    });
  }
  return cuts;
}

/**
 * Rows after the cursor that this sync sends: everything visible, minus content older than a
 * gap cutoff. Control events inside a gap range still travel, so membership, bans and deletes
 * never go stale behind a gap.
 */
function visibleRows(db: Database, viewer: number, cursor: number, cuts: readonly GapCutoff[]): EventRow[] {
  const base = `SELECT e.seq, e.bytes FROM events e
    WHERE e.seq > ? AND (${VISIBLE_SQL})`;
  if (cuts.length === 0) {
    return db
      .query(`${base} ORDER BY e.seq ASC LIMIT ?`)
      .all(cursor, ...viewerArgs(viewer), MAX_SYNC_EVENTS + 1) as EventRow[];
  }
  const values = cuts.map(() => "(?, ?)").join(", ");
  const params = cuts.flatMap((cut) => [cut.scope, cut.before]);
  return db
    .query(
      `WITH gap_scope(scope, cutoff) AS (VALUES ${values})
       ${base}
         AND NOT EXISTS (
           SELECT 1 FROM gap_scope g
           WHERE g.scope = e.scope AND e.seq < g.cutoff AND e.tag IN (${GAP_TAG_LIST})
         )
       ORDER BY e.seq ASC
       LIMIT ?`,
    )
    .all(...params, cursor, ...viewerArgs(viewer), MAX_SYNC_EVENTS + 1) as EventRow[];
}

function gapEvent(cut: GapCutoff): Event {
  return {
    tag: Tag.Gap,
    seq: cut.seq,
    ts: cut.ts,
    author: 0,
    scope: cut.scope,
    after: cut.after,
    before: cut.before,
    count: cut.count,
  };
}

/** Events after `cursor` the viewer may see, oldest first, paged by count and bytes. */
export function visibleEvents(db: Database, viewer: number, cursor: number): VisiblePage {
  const cuts = gapCutoffs(db, viewer, cursor);
  const rows = visibleRows(db, viewer, cursor, cuts);

  // A synthesized gap marker costs about the same as a small delete event; the exact byte
  // count only matters for the page budget, so one estimate keeps the loop simple.
  const GAP_BYTES = 32;
  const entries: { event: Event; bytes: number }[] = [];
  for (const row of rows) {
    try {
      const event = decodeEventBytes(row.bytes);
      if (event) entries.push({ event, bytes: row.bytes.length });
    } catch {
      // A corrupt row is dropped, like an unknown tag: one bad event must not wedge sync.
    }
  }
  for (const cut of cuts) entries.push({ event: gapEvent(cut), bytes: GAP_BYTES });
  entries.sort((a, b) => a.event.seq - b.event.seq);

  const events: Event[] = [];
  let bytes = 0;
  // A row the decoder drops still occupies a LIMIT slot, so the extra row is the only proof
  // that this page is not the end.
  let more = rows.length > MAX_SYNC_EVENTS;
  for (const entry of entries) {
    if (events.length >= MAX_SYNC_EVENTS || (events.length > 0 && bytes + entry.bytes > MAX_SYNC_BYTES)) {
      more = true;
      break;
    }
    events.push(entry.event);
    bytes += entry.bytes;
  }

  const last = events.at(-1);
  return { events, more, cursor: more && last ? last.seq : headCursor(db) };
}

export interface HistoryPage {
  events: Event[];
  more: boolean;
}

/**
 * Older events in one visible scope, newest first. `more` means even older events exist.
 * The caller has already capped `limit` (1..100, docs/PROTOCOL.md).
 */
export function historyEvents(
  db: Database,
  viewer: number,
  scope: number,
  before: number,
  limit: number,
): HistoryPage {
  const rows = db
    .query(
      `SELECT e.seq, e.bytes FROM events e
       WHERE e.scope = ? AND e.seq < ? AND (${VISIBLE_SQL})
       ORDER BY e.seq DESC
       LIMIT ?`,
    )
    .all(scope, before, ...viewerArgs(viewer), limit + 1) as EventRow[];

  // Visibility is the access check: a scope the viewer cannot see yields no rows, and a
  // rotated or guessed id reveals nothing.
  return { events: decodeRows(rows.slice(0, limit)), more: rows.length > limit };
}

/** Events created by this batch that the viewer may see, regardless of their old cursor. */
export function visibleFrom(db: Database, viewer: number, firstSeq: number): Event[] {
  const rows = db
    .query(
      `SELECT e.seq, e.bytes FROM events e
       WHERE e.seq >= ? AND (${VISIBLE_SQL})
       ORDER BY e.seq ASC`,
    )
    .all(firstSeq, viewer, viewer, viewer, viewer, viewer, viewer) as EventRow[];
  return decodeRows(rows);
}

/**
 * Moderation events after the viewer's old cursor. A state snapshot jumps the cursor to the
 * head, and current state cannot express a tombstone (a deleted post) or an absence (a member
 * who left), so these events have to travel with it. A fresh device (cursor 0) has no cache
 * to reconcile and gets nothing.
 */
export interface ModerationDeltaPage {
  events: Event[];
  more: boolean;
  /** Last applied seq; the caller keeps the head cursor only when nothing is left. */
  cursor: number;
}

export function moderationDeltas(db: Database, viewer: number, cursor: number): ModerationDeltaPage {
  if (cursor <= 0) return { events: [], more: false, cursor };
  const rows = db
    .query(
      `SELECT e.seq, e.bytes FROM events e
       WHERE e.seq > ? AND e.tag IN (${Tag.Delete}, ${Tag.Ban}, ${Tag.Membership})
         AND (${VISIBLE_SQL})
       ORDER BY e.seq ASC
       LIMIT ?`,
    )
    .all(cursor, viewer, viewer, viewer, viewer, viewer, viewer, MAX_SYNC_EVENTS + 1) as EventRow[];

  const events: Event[] = [];
  let bytes = 0;
  // A row the decoder drops still occupies a LIMIT slot, so the extra row is the only proof
  // that this page is not the end, exactly like visibleEvents.
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
      continue;
    }
    if (!event) continue;
    events.push(event);
    bytes += row.bytes.length;
  }
  return { events, more, cursor: events.at(-1)?.seq ?? cursor };
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
         AND NOT (${BLOCKED_AUTHOR_SQL})
       ORDER BY e.seq ASC`,
    )
    .all(viewer, viewer, viewer) as EventRow[];
  // A fresh member sees who is currently banned, so moderation state survives a reinstall.
  const bans = db
    .query(
      `SELECT e.bytes FROM group_bans b JOIN events e ON e.seq = b.seq
       WHERE b.banned = 1
         AND b.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
       ORDER BY e.seq ASC`,
    )
    .all(viewer) as EventRow[];
  // A pending purge must survive a state snapshot too: joining another group, or retrying a
  // lost leave response, moves the cursor to the head without ever walking the event log.
  const lefts = db
    .query(
      `SELECT e.bytes FROM scope_lefts s JOIN events e ON e.seq = s.seq
       WHERE s.user_id = ?
       ORDER BY e.seq ASC`,
    )
    .all(viewer) as EventRow[];
  // A blocker's current list survives a reinstall: latest block per user, only those still on.
  const blockRows = db
    .query(
      `SELECT e.bytes FROM events e
       WHERE e.tag = ${Tag.Block} AND e.author = ?
       ORDER BY e.seq ASC`,
    )
    .all(viewer) as EventRow[];
  const latestBlocks = new Map<number, Extract<Event, { tag: typeof Tag.Block }>>();
  for (const event of decodeRows(blockRows)) {
    if (event.tag === Tag.Block) latestBlocks.set(event.user, event);
  }
  const blocks = [...latestBlocks.values()].filter((event) => event.on);
  const state = decodeRows([...profiles, ...groups, ...members, ...dms, ...bans, ...lefts]);
  return [...state, ...blocks].sort((a, b) => a.seq - b.seq);
}

/** Merges events by seq. State events can sit at or below the old cursor; the client applies them. */
export function mergeEvents(...lists: Event[][]): Event[] {
  const bySeq = new Map<number, Event>();
  for (const list of lists) for (const event of list) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
