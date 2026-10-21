// POST /history: older events in one scope, on explicit user request only (ADR 0009).
// The same session, recovery and version rules as /sync apply, and visibility is decided by
// the same SQL filter, so history can never reach past a group or DM the viewer cannot see.
import type { Database } from "bun:sqlite";
import { brotliCompressSync } from "node:zlib";
import {
  ProtocolError,
  SUPPORTED,
  decodeHistoryRequest,
  encodeHistoryResponse,
  negotiate,
  readVersion,
  type HistoryResponse,
} from "@brr-chat/protocol";
import { actorFor, historyEvents } from "./events.ts";
import type { AuthInstance } from "./index.ts";
import { isRecoveryConfirmed } from "./recovery.ts";

function respondCborBrotli(res: HistoryResponse): Response {
  const encoded = encodeHistoryResponse(res);
  const compressed = new Uint8Array(brotliCompressSync(encoded));
  return new Response(compressed, {
    status: 200,
    headers: {
      "Content-Type": "application/cbor",
      "Content-Encoding": "br",
    },
  });
}

export async function handleHistory(req: Request, db: Database, auth: AuthInstance): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session || session.user.banned) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!isRecoveryConfirmed(db, session.user.id)) {
    return new Response("Recovery code not confirmed", { status: 403 });
  }

  const bytes = new Uint8Array(await req.arrayBuffer());

  let v: number;
  try {
    v = readVersion(bytes);
  } catch (err) {
    if (err instanceof ProtocolError) return new Response("Bad Request", { status: 400 });
    throw err;
  }

  const versionError = negotiate(v, SUPPORTED);
  if (versionError !== null) {
    return respondCborBrotli({
      range: SUPPORTED,
      events: [],
      more: false,
      skipped: 0,
      error: versionError,
    });
  }

  let decoded: ReturnType<typeof decodeHistoryRequest>;
  try {
    decoded = decodeHistoryRequest(bytes);
  } catch (err) {
    if (err instanceof ProtocolError) return new Response("Bad Request", { status: 400 });
    throw err;
  }

  const actor = actorFor(db, session.user.id);
  const page = historyEvents(db, actor.wireId, decoded.scope, decoded.before, decoded.limit);
  return respondCborBrotli({
    range: SUPPORTED,
    events: page.events,
    more: page.more,
    skipped: 0,
  });
}
