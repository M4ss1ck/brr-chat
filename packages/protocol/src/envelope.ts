// Request/response envelopes for POST /sync and POST /history. Positional arrays;
// new fields are appended and optional. See docs/PROTOCOL.md.
import { decode, encode, type Wire } from "./cbor.ts";
import { ProtocolError, type AckError, type ResponseError } from "./errors.ts";
import { CID_BYTES, arr, decodeEvent, decodeOp, encodeEvent, encodeOp, uint, type Event, type Op } from "./events.ts";
import type { VersionRange } from "./version.ts";

export const MAX_HISTORY_LIMIT = 100;

export type Ack = { cid: Uint8Array; seq: number } | { cid: Uint8Array; error: AckError };

export interface SyncRequest {
  v: number;
  /** Last seq the client has applied; 0 on a fresh device. */
  cursor: number;
  outbox: Op[];
}

export interface DecodedSyncRequest extends SyncRequest {
  /** Ops that could not be accepted (unknown tag or malformed). Send each back as a nack. */
  rejected: { cid: Uint8Array; error: AckError }[];
}

export interface SyncResponse {
  range: VersionRange;
  cursor: number;
  /** True when the server stopped early; the client should sync again right away. */
  more: boolean;
  events: Event[];
  acks: Ack[];
  /**
   * Decode-side only, not on the wire: events dropped because their tag is unknown or their
   * fields are malformed. Dropping beats throwing: one bad event must not wedge sync forever.
   */
  skipped: number;
  error?: ResponseError;
}

export interface HistoryRequest {
  v: number;
  scope: number;
  /** Return events with seq < before, newest first. */
  before: number;
  limit: number;
}

export interface HistoryResponse {
  range: VersionRange;
  events: Event[];
  more: boolean;
  skipped: number;
  error?: ResponseError;
}

/** Read only the version, so a server can answer "upgrade" to shapes it cannot parse. */
export function readVersion(bytes: Uint8Array): number {
  return uint(arr(decode(bytes), "request")[0], "v");
}

function decodeEvents(v: unknown): { events: Event[]; skipped: number } {
  const events: Event[] = [];
  let skipped = 0;
  for (const raw of arr(v, "events")) {
    let e: Event | null = null;
    try {
      e = decodeEvent(raw);
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
    }
    if (e) events.push(e);
    else skipped++;
  }
  return { events, skipped };
}

function optionalError(v: unknown): { error?: ResponseError } {
  return v === undefined || v === null ? {} : { error: uint(v, "error") as ResponseError };
}

// ---- /sync ----

export function encodeSyncRequest(r: SyncRequest): Uint8Array {
  return encode([r.v, r.cursor, r.outbox.map(encodeOp)]);
}

export function decodeSyncRequest(bytes: Uint8Array): DecodedSyncRequest {
  const a = arr(decode(bytes), "request");
  const outbox: Op[] = [];
  const rejected: DecodedSyncRequest["rejected"] = [];
  for (const raw of arr(a[2], "outbox")) {
    const d = decodeOp(raw);
    if (d.ok) outbox.push(d.op);
    else rejected.push({ cid: d.cid, error: d.error });
  }
  return { v: uint(a[0], "v"), cursor: uint(a[1], "cursor"), outbox, rejected };
}

export function encodeSyncResponse(r: SyncResponse): Uint8Array {
  const acks = r.acks.map((k): Wire => [k.cid, "seq" in k ? k.seq : -k.error]);
  const out: Wire[] = [r.range.min, r.range.max, r.cursor, r.more, r.events.map(encodeEvent), acks];
  if (r.error !== undefined) out.push(r.error);
  return encode(out);
}

function decodeAck(v: unknown): Ack {
  const a = arr(v, "ack");
  const cid = a[0];
  const n = a[1];
  if (!(cid instanceof Uint8Array) || cid.length !== CID_BYTES) throw new ProtocolError("ack.cid: expected 8 bytes");
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n === 0) throw new ProtocolError("ack: expected nonzero int");
  return n > 0 ? { cid, seq: n } : { cid, error: -n as AckError };
}

export function decodeSyncResponse(bytes: Uint8Array): SyncResponse {
  const a = arr(decode(bytes), "response");
  return {
    range: { min: uint(a[0], "vMin"), max: uint(a[1], "vMax") },
    cursor: uint(a[2], "cursor"),
    more: a[3] === true,
    ...decodeEvents(a[4]),
    acks: arr(a[5], "acks").map(decodeAck),
    ...optionalError(a[6]),
  };
}

// ---- /history ----

export function encodeHistoryRequest(r: HistoryRequest): Uint8Array {
  return encode([r.v, r.scope, r.before, r.limit]);
}

export function decodeHistoryRequest(bytes: Uint8Array): HistoryRequest {
  const a = arr(decode(bytes), "history");
  const limit = uint(a[3], "limit");
  if (limit < 1 || limit > MAX_HISTORY_LIMIT) throw new ProtocolError(`limit: must be 1..${MAX_HISTORY_LIMIT}`);
  return { v: uint(a[0], "v"), scope: uint(a[1], "scope"), before: uint(a[2], "before"), limit };
}

export function encodeHistoryResponse(r: HistoryResponse): Uint8Array {
  const out: Wire[] = [r.range.min, r.range.max, r.events.map(encodeEvent), r.more];
  if (r.error !== undefined) out.push(r.error);
  return encode(out);
}

export function decodeHistoryResponse(bytes: Uint8Array): HistoryResponse {
  const a = arr(decode(bytes), "history");
  return {
    range: { min: uint(a[0], "vMin"), max: uint(a[1], "vMax") },
    ...decodeEvents(a[2]),
    more: a[3] === true,
    ...optionalError(a[4]),
  };
}
