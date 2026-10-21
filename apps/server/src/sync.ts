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
import { DICTIONARY_VARY, DICTIONARY_VARY_BYTES, dczCompress, wantsDictionary } from "./dictionary.ts";
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

/**
 * The request's best encoding of one encoded response. `dcz` is only chosen when it is
 * smaller *after* the Vary header it needs, so a dictionary never costs bytes on a small
 * response and an unsupported client always gets brotli (issue #21, ADR 0021).
 */
export function respondCbor(req: Request, res: SyncResponse): Response {
  const encoded = encodeSyncResponse(res);
  const brotli = new Uint8Array(brotliCompressSync(encoded)) as Uint8Array<ArrayBuffer>;
  let body: Uint8Array<ArrayBuffer> = brotli;
  let encoding = "br";
  let dictionary = false;
  if (wantsDictionary(req)) {
    const dcz = dczCompress(encoded);
    // Vary plus the one-byte-longer "dcz" value; header names are the same either way.
    if (dcz.byteLength + DICTIONARY_VARY_BYTES + 1 < brotli.byteLength) {
      body = dcz;
      encoding = "dcz";
      dictionary = true;
    }
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/cbor",
    "Content-Encoding": encoding,
    // The compressed size, so the client's data meter can count the bytes actually
    // downloaded instead of the decompressed body (ADR 0018).
    "Content-Length": String(body.byteLength),
  };
  // RFC 9842 §6.2: a cacheable dictionary-compressed response must vary on both. /sync is a
  // POST with no freshness, so the brotli branch owes no Vary and saves the header bytes.
  if (dictionary) headers.Vary = DICTIONARY_VARY;
  return new Response(body, { status: 200, headers });
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
    return respondCbor(req, {
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

  return respondCbor(req, {
    range: SUPPORTED,
    cursor,
    more,
    events,
    acks,
    skipped: 0,
  });
}
