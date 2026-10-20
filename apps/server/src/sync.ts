import type { Database } from "bun:sqlite";
import { brotliCompressSync } from "node:zlib";
import {
  ProtocolError,
  SUPPORTED,
  decodeSyncRequest,
  encodeSyncResponse,
  negotiate,
  readVersion,
  type Ack,
  type Event,
  type SyncResponse,
} from "@brr-chat/protocol";
import { headCursor } from "./db.ts";
import {
  actorFor,
  applyOutbox,
  mergeEvents,
  moderationDeltas,
  stateEvents,
  visibleEvents,
  visibleFrom,
} from "./events.ts";
import type { AuthInstance } from "./index.ts";
import type { AbuseLimiters } from "./limits.ts";
import { isRecoveryConfirmed } from "./recovery.ts";

function respondCborBrotli(res: SyncResponse): Response {
  const encoded = encodeSyncResponse(res);
  const compressed = new Uint8Array(brotliCompressSync(encoded));
  return new Response(compressed, {
    status: 200,
    headers: {
      "Content-Type": "application/cbor",
      "Content-Encoding": "br",
    },
  });
}

export async function handleSync(
  req: Request,
  db: Database,
  auth: AuthInstance,
  limits: AbuseLimiters,
): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session || session.user.banned) {
    return new Response("Unauthorized", { status: 401 });
  }
  // Signup is not finished until the recovery code's last group is typed back (ADR 0006).
  if (!isRecoveryConfirmed(db, session.user.id)) {
    return new Response("Recovery code not confirmed", { status: 403 });
  }

  const bytes = new Uint8Array(await req.arrayBuffer());

  let v: number;
  try {
    v = readVersion(bytes);
  } catch (err) {
    if (err instanceof ProtocolError) {
      return new Response("Bad Request", { status: 400 });
    }
    throw err;
  }

  const versionError = negotiate(v, SUPPORTED);
  if (versionError !== null) {
    return respondCborBrotli({
      range: SUPPORTED,
      cursor: 0,
      more: false,
      events: [],
      acks: [],
      skipped: 0,
      error: versionError,
    });
  }

  let decoded: ReturnType<typeof decodeSyncRequest>;
  try {
    decoded = decodeSyncRequest(bytes);
  } catch (err) {
    if (err instanceof ProtocolError) {
      return new Response("Bad Request", { status: 400 });
    }
    throw err;
  }

  const actor = actorFor(db, session.user.id);

  // Ops are all-or-nothing; a malformed op was already turned into a nack by decodeSyncRequest.
  const applied = applyOutbox(db, actor, decoded.outbox, limits);
  const acks: Ack[] = [...decoded.rejected.map((r) => ({ cid: r.cid, error: r.error })), ...applied.acks];

  let events: Event[];
  let cursor: number;
  let more = false;

  if (decoded.cursor === 0 || applied.state) {
    // Fresh device or a join/create in this batch: current state (profiles, groups, DM scopes)
    // and the head, never old posts or DM messages (ADR 0009). Events created by this batch
    // still come back, so the actor sees what it just did. Moderation tombstones since the
    // old cursor ride along, because a state snapshot cannot express "this is gone".
    const fresh = applied.firstSeq === null ? [] : visibleFrom(db, actor.wireId, applied.firstSeq);
    const deltas = moderationDeltas(db, actor.wireId, decoded.cursor);
    events = mergeEvents(stateEvents(db, actor.wireId), deltas.events, fresh);
    // Keep the cursor at the last delivered delta when more remain; jumping to the head
    // would silently drop the rest. The next call is a normal paged catch-up.
    cursor = deltas.more ? deltas.cursor : headCursor(db);
    more = deltas.more;
  } else {
    const page = visibleEvents(db, actor.wireId, decoded.cursor);
    events = page.events;
    cursor = page.cursor;
    more = page.more;
  }

  return respondCborBrotli({
    range: SUPPORTED,
    cursor,
    more,
    events,
    acks,
    skipped: 0,
  });
}
