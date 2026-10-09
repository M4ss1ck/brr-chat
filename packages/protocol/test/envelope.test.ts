import { describe, expect, test } from "bun:test";
import {
  AckError,
  ProtocolError,
  ResponseError,
  SUPPORTED,
  Tag,
  decodeHistoryRequest,
  decodeHistoryResponse,
  decodeSyncRequest,
  decodeSyncResponse,
  encodeHistoryRequest,
  encodeHistoryResponse,
  encodeSyncRequest,
  encodeSyncResponse,
  readVersion,
  type SyncResponse,
} from "../src/index.ts";
import { decode, encode } from "../src/cbor.ts";
import { encodeCBOR } from "@levischuck/tiny-cbor";

const cid = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
const cid2 = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);

describe("sync request", () => {
  test("round-trips", () => {
    const req = { v: 1, cursor: 55, outbox: [{ cid, scope: 3, tag: Tag.Delete, target: 9 } as const] };
    expect(decodeSyncRequest(encodeSyncRequest(req))).toEqual({ ...req, rejected: [] });
  });

  test("wire shape is [v, cursor, outbox]", () => {
    expect(decode(encodeSyncRequest({ v: 1, cursor: 0, outbox: [] }))).toEqual([1, 0, []]);
  });

  test("unknown and malformed ops are collected for nacking; the rest of the batch survives", () => {
    const cid3 = new Uint8Array(8).fill(3);
    const bytes = encode([1, 0, [[cid, 99, 3, "future op"], [cid2, Tag.Delete, 3, 1], [cid3, Tag.Delete, 3, "bad"]]]);
    const req = decodeSyncRequest(bytes);
    expect(req.rejected).toEqual([
      { cid, error: AckError.Unsupported },
      { cid: cid3, error: AckError.Invalid },
    ]);
    expect(req.outbox).toHaveLength(1);
  });

  test("readVersion works on any array whose head is a uint, even with an unknown shape", () => {
    expect(readVersion(encodeCBOR([9, "whatever", new Map([["future", true]])]))).toBe(9);
    expect(() => readVersion(encode("nope"))).toThrow(ProtocolError);
  });
});

describe("sync response", () => {
  const res: SyncResponse = {
    range: SUPPORTED,
    cursor: 1001,
    more: false,
    events: [{ tag: Tag.Delete, seq: 1001, ts: 1, author: 2, scope: 3, target: 4 }],
    acks: [
      { cid, seq: 1001 },
      { cid: cid2, error: AckError.Forbidden },
    ],
    skipped: 0,
  };

  test("round-trips", () => {
    expect(decodeSyncResponse(encodeSyncResponse(res))).toEqual(res);
  });

  test("wire shape is [vMin, vMax, cursor, more, events, acks] with errors as negative ints", () => {
    expect(decode(encodeSyncResponse(res))).toEqual([1, 1, 1001, false, [[Tag.Delete, 1001, 1, 2, 3, 4]], [[cid, 1001], [cid2, -AckError.Forbidden]]]);
  });

  test("upgrade error is a trailing field and carries no events", () => {
    const up: SyncResponse = { range: SUPPORTED, cursor: 0, more: false, events: [], acks: [], skipped: 0, error: ResponseError.ClientTooOld };
    expect(decode(encodeSyncResponse(up))).toEqual([1, 1, 0, false, [], [], ResponseError.ClientTooOld]);
    expect(decodeSyncResponse(encodeSyncResponse(up))).toEqual(up);
  });

  test("unknown events are skipped and counted", () => {
    const bytes = encode([1, 2, 10, true, [[99, 1, 1, 1, 1, "x"], [Tag.Delete, 2, 1, 1, 1, 4]], [], null, "future"]);
    const out = decodeSyncResponse(bytes);
    expect(out.events).toHaveLength(1);
    expect(out.skipped).toBe(1);
    expect(out.range).toEqual({ min: 1, max: 2 });
    expect(out.more).toBe(true);
  });

  test("a malformed known event is skipped, not fatal (no sync wedge)", () => {
    const bytes = encode([1, 1, 10, false, [[Tag.Delete, 1, 1, 1, 1, "bad"], [Tag.Delete, 2, 1, 1, 1, 4]], []]);
    const out = decodeSyncResponse(bytes);
    expect(out.events.map((e) => e.seq)).toEqual([2]);
    expect(out.skipped).toBe(1);
  });

  test("ack with seq 0 is malformed", () => {
    expect(() => decodeSyncResponse(encode([1, 1, 0, false, [], [[cid, 0]]]))).toThrow(ProtocolError);
  });
});

describe("history", () => {
  test("request round-trips with shape [v, scope, before, limit]", () => {
    const req = { v: 1, scope: 3, before: 500, limit: 30 };
    expect(decode(encodeHistoryRequest(req))).toEqual([1, 3, 500, 30]);
    expect(decodeHistoryRequest(encodeHistoryRequest(req))).toEqual(req);
  });

  test("response round-trips with shape [vMin, vMax, events, more]", () => {
    const res = {
      range: SUPPORTED,
      events: [{ tag: Tag.Post, seq: 4, ts: 1, author: 2, scope: 3, text: "old", media: null } as const],
      more: true,
      skipped: 0,
    };
    expect(decode(encodeHistoryResponse(res))).toEqual([1, 1, [[Tag.Post, 4, 1, 2, 3, "old"]], true]);
    expect(decodeHistoryResponse(encodeHistoryResponse(res))).toEqual(res);
  });

  test("limit is capped", () => {
    expect(() => decodeHistoryRequest(encode([1, 3, 500, 101]))).toThrow(ProtocolError);
    expect(() => decodeHistoryRequest(encode([1, 3, 500, 0]))).toThrow(ProtocolError);
  });
});
