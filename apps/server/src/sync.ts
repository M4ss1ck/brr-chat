import type { Database } from "bun:sqlite";
import { brotliCompressSync } from "node:zlib";
import {
  ProtocolError,
  SUPPORTED,
  decodeSyncRequest,
  encodeSyncResponse,
  negotiate,
  readVersion,
  type SyncResponse,
} from "@brr-chat/protocol";
import { headCursor } from "./db.ts";
import type { AuthInstance } from "./index.ts";
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

export async function handleSync(req: Request, db: Database, auth: AuthInstance): Promise<Response> {
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

  const acks = decoded.rejected.map((r) => ({ cid: r.cid, error: r.error }));
  const cursor = headCursor(db);

  return respondCborBrotli({
    range: SUPPORTED,
    cursor,
    more: false,
    events: [],
    acks,
    skipped: 0,
  });
}
