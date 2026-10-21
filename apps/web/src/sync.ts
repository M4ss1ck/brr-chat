// Client side of POST /sync (docs/PROTOCOL.md): brotli is transparent to fetch, so the
// response body decodes straight from the wire, and only IndexedDB is touched locally.
import {
  PROTOCOL_VERSION,
  decodeSyncResponse,
  encodeSyncRequest,
  type Event,
  type Op,
  type ResponseError,
  type SyncResponse,
  type VersionRange,
} from "@brr-chat/protocol";
import { bearerHeader } from "./auth.ts";
import { meteredFetch } from "./meter.ts";
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
  const res = await meteredFetch(`${base}${SYNC_PATH}`, {
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
 * Syncs from the stored cursor until `more` is false, caching the server range and applying
 * each page before its cursor moves. Pages after the first send an empty outbox: the server
 * already acked every op in the first request, and resending them would only cost bytes.
 *
 * The returned response is the whole catch-up: final cursor, every ack, and the events from
 * every page, so callers keep talking to one response.
 */
export async function syncAndPersist(
  base: string,
  token: string,
  username: string,
  outbox: Op[] = [],
): Promise<SyncOutcome> {
  let cursor = await getCursor(username);
  let pending = outbox;
  const events: Event[] = [];
  const acks: SyncResponse["acks"] = [];
  let skipped = 0;

  for (;;) {
    const response = await postSyncRequest(base, token, buildSyncRequest(cursor, pending));
    await setRange(response.range);
    const outcome = classifySyncResponse(response);
    if (outcome.kind === "upgrade") return outcome;

    await applyEvents(username, response.events);
    const previous = cursor;
    cursor = response.cursor;
    // Events first, cursor second: a failed IndexedDB write cannot strand them behind it.
    await setCursor(username, cursor);
    events.push(...response.events);
    acks.push(...response.acks);
    skipped += response.skipped;

    const whole: SyncResponse = { ...response, cursor, events, acks, skipped };
    if (!response.more) return { kind: "ok", response: whole };

    // No progress with more to come would loop forever. Fail loudly instead of claiming
    // "in sync" while still behind.
    if (cursor <= previous) {
      throw new Error("sync stalled: the server said more without advancing the cursor");
    }
    pending = [];
  }
}
