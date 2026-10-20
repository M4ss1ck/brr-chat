// Client side of POST /sync (docs/PROTOCOL.md): brotli is transparent to fetch, so the
// response body decodes straight from the wire, and only IndexedDB is touched locally.
import {
  PROTOCOL_VERSION,
  decodeSyncResponse,
  encodeSyncRequest,
  type Op,
  type ResponseError,
  type SyncResponse,
  type VersionRange,
} from "@brr-chat/protocol";
import { bearerHeader } from "./auth.ts";
import { applyEvents, getCursor, setCursor, setRange } from "./store.ts";

export const SYNC_PATH = "/sync";

/** A refused sync, carrying the HTTP status so the UI can explain 401 and 403 differently. */
export class SyncHttpError extends Error {
  constructor(readonly status: number) {
    super(`${SYNC_PATH} failed with status ${status}`);
    this.name = "SyncHttpError";
  }
}

export function buildSyncRequest(cursor: number, outbox: Op[] = [], v: number = PROTOCOL_VERSION): Uint8Array {
  return encodeSyncRequest({ v, cursor, outbox });
}

/** One request as it goes on the wire. Throws on any non-200, including 401. */
export async function postSyncRequest(base: string, token: string, body: Uint8Array): Promise<SyncResponse> {
  const res = await fetch(`${base}${SYNC_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
      "Accept-Encoding": "br",
      Authorization: bearerHeader(token),
    },
    // The DOM lib's BodyInit does not list Uint8Array; every runtime accepts it.
    body: body as unknown as BodyInit,
  });
  if (!res.ok) throw new SyncHttpError(res.status);
  return decodeSyncResponse(new Uint8Array(await res.arrayBuffer()));
}

export type SyncOutcome =
  | { kind: "ok"; response: SyncResponse }
  | { kind: "upgrade"; error: ResponseError; range: VersionRange };

/** Pure: an in-range response is applied; an out-of-range one only reports the server range. */
export function classifySyncResponse(response: SyncResponse): SyncOutcome {
  return response.error !== undefined
    ? { kind: "upgrade", error: response.error, range: response.range }
    : { kind: "ok", response };
}

/**
 * Syncs from the stored cursor, caches the server range either way, and advances the stored
 * cursor only for an in-range response. Events are applied before the cursor moves, so a
 * failed IndexedDB write cannot strand them behind an advanced cursor.
 */
export async function syncAndPersist(
  base: string,
  token: string,
  username: string,
  outbox: Op[] = [],
): Promise<SyncOutcome> {
  const cursor = await getCursor(username);
  const response = await postSyncRequest(base, token, buildSyncRequest(cursor, outbox));
  await setRange(response.range);
  const outcome = classifySyncResponse(response);
  if (outcome.kind === "ok") {
    await applyEvents(username, response.events);
    await setCursor(username, response.cursor);
  }
  return outcome;
}
