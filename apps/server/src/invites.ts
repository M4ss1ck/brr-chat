// Invite-only group links (ADR 0010, ADR 0016). The group has one secret token; the link is
// just that token in a URL, so a QR code encodes the same URL. Tokens live in `chat_groups`
// and never in the event log, so members cannot read the link from a membership event.
import type { Database } from "bun:sqlite";
import { AckError, Role, Tag, decodeEventBytes, type Event } from "@brr-chat/protocol";
import { actorFor, applyOutbox, groupFor, groupForInviteToken, memberFor, newInviteToken } from "./events.ts";
import type { AuthInstance } from "./index.ts";
import type { AbuseLimiters } from "./limits.ts";
import { isRecoveryConfirmed } from "./recovery.ts";

/** The public path a link points at. The shell serves the app for this route. */
export const JOIN_PATH_PREFIX = "/join/";

interface GroupEventRow {
  bytes: Uint8Array;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function linkFor(baseURL: string, token: string): string {
  return new URL(`${JOIN_PATH_PREFIX}${token}`, baseURL).toString();
}

/** Latest group_meta event, decoded. The table only keeps the flags visibility needs. */
function groupMetaFor(db: Database, groupId: number): Event | null {
  const row = db
    .query("SELECT bytes FROM events WHERE tag = ? AND scope = ? ORDER BY seq DESC LIMIT 1")
    .get(Tag.GroupMeta, groupId) as GroupEventRow | null;
  if (!row) return null;
  try {
    return decodeEventBytes(new Uint8Array(row.bytes));
  } catch {
    return null;
  }
}

/** Replaces the token in one UPDATE; every old link stops working at that moment. */
function rotateToken(db: Database, groupId: number): string {
  // A 128-bit collision is vanishingly unlikely, but the unique index would turn it into a
  // 500. Retrying keeps rotation as reliable as generation.
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newInviteToken();
    try {
      db.query("UPDATE chat_groups SET invite_token = ? WHERE id = ?").run(token, groupId);
      return token;
    } catch (err) {
      if (!(err instanceof Error) || !/UNIQUE constraint failed/i.test(err.message)) throw err;
    }
  }
  throw new Error(`could not allocate an invite token for group ${groupId}`);
}

function currentToken(db: Database, groupId: number, existing: string | null): string {
  if (existing !== null) return existing;
  // A group created before invite links has no token. Give it one on first use rather than
  // migrating every row and invalidating nothing. The WHERE keeps two concurrent first reads
  // from handing out two different tokens.
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newInviteToken();
    try {
      const result = db
        .query("UPDATE chat_groups SET invite_token = ? WHERE id = ? AND invite_token IS NULL")
        .run(token, groupId);
      if (Number(result.changes) > 0) return token;
      break;
    } catch (err) {
      if (!(err instanceof Error) || !/UNIQUE constraint failed/i.test(err.message)) throw err;
    }
  }
  const row = db.query("SELECT invite_token FROM chat_groups WHERE id = ?").get(groupId) as {
    invite_token: string | null;
  } | null;
  if (row?.invite_token === null || row?.invite_token === undefined) {
    throw new Error(`could not allocate an invite token for group ${groupId}`);
  }
  return row.invite_token;
}

export interface InviteService {
  /** Handles every invite route. Null means "not mine". */
  handle(req: Request, pathname: string): Promise<Response | null>;
}

export function createInviteService(
  db: Database,
  auth: AuthInstance,
  baseURL: string,
  limits: AbuseLimiters,
): InviteService {
  async function sessionAccount(req: Request): Promise<{ userId: string; wireId: number } | Response> {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session || session.user.banned) return json(401, { error: "sign in first" });
    if (!isRecoveryConfirmed(db, session.user.id)) {
      return json(403, { error: "finish signup first" });
    }
    const actor = actorFor(db, session.user.id);
    return { userId: session.user.id, wireId: actor.wireId };
  }

  function invitePayload(groupId: number, token: string): Record<string, unknown> {
    const link = linkFor(baseURL, token);
    return { group: groupId, token, link, qr: link };
  }

  /** GET returns the current link; POST rotates it and returns the new one. */
  async function manage(req: Request, groupId: number, rotate: boolean): Promise<Response> {
    const session = await sessionAccount(req);
    if (session instanceof Response) return session;

    const group = groupFor(db, groupId);
    const member = group ? memberFor(db, groupId, session.wireId) : null;
    // A non-member of an invite-only group learns nothing about it, not even that it exists.
    if (!group || !member) return json(404, { error: "group not found" });
    if (group.open === 1) return json(404, { error: "open groups have no invite link" });
    if (member.role < Role.Admin) return json(403, { error: "group admins only" });
    if (rotate && req.method !== "POST") return json(405, { error: "rotate needs POST" });
    if (!rotate && req.method !== "GET" && req.method !== "POST") return json(405, { error: "use GET or POST" });

    const token = rotate ? rotateToken(db, groupId) : currentToken(db, groupId, group.invite_token);
    return json(200, invitePayload(groupId, token));
  }

  /** Group basics for someone holding a link, before they join. */
  async function resolve(req: Request, token: string): Promise<Response> {
    const session = await sessionAccount(req);
    if (session instanceof Response) return session;
    const group = groupForInviteToken(db, token);
    if (!group) return json(404, { error: "invalid or rotated invite" });

    const meta = groupMetaFor(db, group.id);
    const counts = db.query("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?").get(group.id) as { n: number };
    const member = memberFor(db, group.id, session.wireId);
    const name = meta && meta.tag === Tag.GroupMeta ? meta.name : `group #${group.id}`;
    const about = meta && meta.tag === Tag.GroupMeta ? meta.about : "";
    return json(200, {
      group: group.id,
      name,
      about,
      open: group.open === 1,
      members: Number(counts.n),
      joined: member !== null,
    });
  }

  /**
   * One-call join for clients that are already online. The PWA instead sends a membership op
   * with `invite`, so the join and the state snapshot arrive in the same sync response.
   */
  async function join(req: Request, token: string): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "join needs POST" });
    const session = await sessionAccount(req);
    if (session instanceof Response) return session;
    const group = groupForInviteToken(db, token);
    if (!group) return json(404, { error: "invalid or rotated invite" });

    const existing = memberFor(db, group.id, session.wireId);
    if (existing) return json(200, { group: group.id, seq: Number(existing.seq), joined: true });

    const cid = crypto.getRandomValues(new Uint8Array(8));
    const result = applyOutbox(db, actorFor(db, session.userId), [
      { cid, tag: Tag.Membership, scope: group.id, user: session.wireId, role: Role.Member, invite: token },
    ], limits);
    const ack = result.acks[0];
    if (!ack || "error" in ack) {
      const error = ack && "error" in ack ? ack.error : AckError.Forbidden;
      return json(403, { error: error === AckError.NotFound ? "group not found" : "cannot join this group" });
    }
    return json(200, { group: group.id, seq: ack.seq, joined: true });
  }

  return {
    async handle(req, pathname): Promise<Response | null> {
      const group = /^\/api\/groups\/(\d+)\/invite(\/rotate)?$/.exec(pathname);
      if (group) {
        const groupId = Number(group[1]);
        if (!Number.isSafeInteger(groupId) || groupId <= 0) return json(404, { error: "group not found" });
        // POST /invite is a shorthand for POST /invite/rotate.
        return manage(req, groupId, group[2] !== undefined || req.method === "POST");
      }

      const invite = /^\/api\/invites\/([A-Za-z0-9_-]+)(\/join)?$/.exec(pathname);
      if (invite) {
        const token = invite[1] ?? "";
        return invite[2] === undefined ? resolve(req, token) : join(req, token);
      }
      return null;
    },
  };
}
