// Client side of POST /history (docs/PROTOCOL.md): older events in one scope, fetched only
// when the user taps "load older". The response is applied to the same IndexedDB cache as
// /sync, so an older page and a gap marker converge on one thread (ADR 0009).
import {
  MAX_HISTORY_LIMIT,
  PROTOCOL_VERSION,
  decodeHistoryResponse,
  encodeHistoryRequest,
  isGapCoveredTag,
  type HistoryResponse,
  type ResponseError,
  type VersionRange,
} from "@brr-chat/protocol";
import { bearerHeader } from "./auth.ts";
import { applyEvents, type StoredGap } from "./store.ts";

export const HISTORY_PATH = "/history";

/** A refused history request, carrying the HTTP status so the UI can tell 401 from 400. */
export class HistoryHttpError extends Error {
  constructor(readonly status: number) {
    super(`${HISTORY_PATH} failed with status ${status}`);
    this.name = "HistoryHttpError";
  }
}

export function buildHistoryRequest(
  scope: number,
  before: number,
  limit: number = MAX_HISTORY_LIMIT,
  v: number = PROTOCOL_VERSION,
): Uint8Array {
  return encodeHistoryRequest({ v, scope, before, limit });
}

/** One request as it goes on the wire. Throws on any non-200, including 401. */
export async function postHistoryRequest(
  base: string,
  token: string,
  body: Uint8Array,
): Promise<HistoryResponse> {
  const res = await fetch(`${base}${HISTORY_PATH}`, {
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
  if (!res.ok) throw new HistoryHttpError(res.status);
  return decodeHistoryResponse(new Uint8Array(await res.arrayBuffer()));
}

export type HistoryOutcome =
  | { kind: "ok"; response: HistoryResponse }
  | { kind: "upgrade"; error: ResponseError; range: VersionRange };

/** Pure: an in-range response is applied; an out-of-range one only reports the server range. */
export function classifyHistoryResponse(response: HistoryResponse): HistoryOutcome {
  return response.error !== undefined
    ? { kind: "upgrade", error: response.error, range: response.range }
    : { kind: "ok", response };
}

/**
 * Fetches one page older than `before` and caches it. `more` on the result says the user may
 * tap again; the stored sync cursor never moves, because history is not catch-up progress.
 */
export async function loadHistory(
  base: string,
  token: string,
  username: string,
  scope: number,
  before: number,
  limit: number = MAX_HISTORY_LIMIT,
): Promise<HistoryOutcome> {
  const response = await postHistoryRequest(base, token, buildHistoryRequest(scope, before, limit));
  const outcome = classifyHistoryResponse(response);
  if (outcome.kind === "ok") await applyEvents(username, response.events);
  return outcome;
}

/**
 * Consumes the hole a history page was filling. A page that reaches the hole's bottom, or
 * reports no older events, closes it; otherwise the hole shrinks to the oldest seq returned,
 * so the next tap continues downward instead of asking for the same range again.
 */
export function advanceGaps(gaps: readonly StoredGap[], response: HistoryResponse): StoredGap[] {
  const active = gaps[0];
  if (!active) return [...gaps];
  const rest = gaps.slice(1);
  const oldest = response.events.at(-1)?.seq;
  if (!response.more || oldest === undefined || oldest <= active.after) return rest;

  const filled = response.events.filter(
    (event) => isGapCoveredTag(event.tag) && event.seq > active.after && event.seq < active.before,
  ).length;
  const count = Math.max(0, active.count - filled);
  return count === 0 ? rest : [{ ...active, before: oldest, count }, ...rest];
}
