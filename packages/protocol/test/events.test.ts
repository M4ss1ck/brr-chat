import { describe, expect, test } from "bun:test";
import {
  AckError,
  Tag,
  encodeEvent,
  decodeEvent,
  encodeOp,
  decodeOp,
  ProtocolError,
  type Event,
  type Op,
} from "../src/index.ts";
import { decode, encode } from "../src/cbor.ts";

const th = new Uint8Array(25).fill(7);
const cid = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const hdr = { seq: 1000, ts: 1_791_000_000, author: 42, scope: 7 };

// One sample per v1 event type. Adding a tag without a sample here fails the coverage test below.
export const samples: Event[] = [
  { ...hdr, tag: Tag.Post, text: "hola", media: { id: 9, w: 640, h: 480, thumbhash: th } },
  { ...hdr, tag: Tag.Post, text: "no media", media: null },
  { ...hdr, tag: Tag.Reply, parent: 999, text: "sí", media: null },
  { ...hdr, tag: Tag.Dm, peer: 43, text: "psst", media: null },
  { ...hdr, tag: Tag.Reaction, target: 999, emoji: 3, on: true },
  { ...hdr, tag: Tag.Delete, target: 999 },
  { ...hdr, scope: 0, tag: Tag.Profile, username: "ana", displayName: "Ana", bio: "" },
  { ...hdr, tag: Tag.GroupMeta, name: "Habana", about: "", open: true },
  { ...hdr, tag: Tag.Membership, user: 42, role: 2 },
  { ...hdr, tag: Tag.Ban, user: 66, on: true },
  { ...hdr, tag: Tag.ScopeLeft, purge: true },
  { ...hdr, author: 0, tag: Tag.Gap, after: 10, before: 900, count: 340 },
];

describe("events", () => {
  test("every tag has a sample", () => {
    const covered = new Set(samples.map((s) => s.tag));
    for (const t of Object.values(Tag)) expect(covered.has(t)).toBe(true);
  });

  test.each(samples.map((s) => [s.tag, s] as const))("tag %d round-trips", (_t, ev) => {
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  test("layout is positional: [tag, seq, ts, author, scope, ...fields]", () => {
    expect(encodeEvent({ ...hdr, tag: Tag.Delete, target: 5 })).toEqual([Tag.Delete, 1000, 1_791_000_000, 42, 7, 5]);
  });

  test("trailing null optionals are dropped on the wire and restored on decode", () => {
    const ev: Event = { ...hdr, tag: Tag.Post, text: "x", media: null };
    expect(encodeEvent(ev)).toEqual([Tag.Post, 1000, 1_791_000_000, 42, 7, "x"]);
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  test("unknown tags decode to null (skipped, not an error)", () => {
    expect(decodeEvent([99, 1, 2, 3, 4, "future"])).toBeNull();
    expect(decodeEvent([7, 1, 2, 3, 4])).toBeNull(); // 7 is reserved (was friend_state)
  });

  test("extra trailing fields from newer servers are ignored", () => {
    expect(decodeEvent([Tag.Delete, 1000, 1_791_000_000, 42, 7, 5, "new field", 123])).toEqual({
      ...hdr,
      tag: Tag.Delete,
      target: 5,
    });
  });

  test.each([
    ["not an array", 5],
    ["missing header", [Tag.Delete, 1]],
    ["missing required field", [Tag.Delete, 1, 2, 3, 4]],
    ["negative uint", [Tag.Delete, -1, 2, 3, 4, 5]],
    ["float uint", [Tag.Delete, 1.5, 2, 3, 4, 5]],
    ["text where uint expected", [Tag.Delete, 1, 2, 3, 4, "5"]],
    ["emoji out of palette", [Tag.Reaction, 1, 2, 3, 4, 5, 8, true]],
    ["role out of range", [Tag.Membership, 1, 2, 3, 4, 5, 4]],
    ["bad media", [Tag.Post, 1, 2, 3, 4, "x", [1, 2]]],
    ["thumbhash too long", [Tag.Post, 1, 2, 3, 4, "x", [1, 2, 3, new Uint8Array(41)]]],
    ["text too long", [Tag.Post, 1, 2, 3, 4, "é".repeat(2001)]],
  ])("rejects %s", (_name, raw) => {
    expect(() => decodeEvent(raw as never)).toThrow(ProtocolError);
  });
});

describe("ops (outbox items)", () => {
  const ops: Op[] = [
    { cid, scope: 7, tag: Tag.Post, text: "hola", media: null },
    { cid, scope: 0, tag: Tag.Dm, peer: 43, text: "new dm", media: null },
    { cid, scope: 7, tag: Tag.Reaction, target: 1, emoji: 0, on: false },
    { cid, scope: 0, tag: Tag.GroupMeta, name: "new group", about: "x", open: false },
  ];

  test.each(ops.map((o) => [o.tag, o] as const))("op tag %d round-trips", (_t, op) => {
    expect(decodeOp(encodeOp(op))).toEqual({ ok: true, op });
  });

  test("layout is positional: [cid, tag, scope, ...fields]", () => {
    expect(encodeOp({ cid, scope: 7, tag: Tag.Delete, target: 5 })).toEqual([cid, Tag.Delete, 7, 5]);
  });

  test("server-only tags cannot be sent as ops", () => {
    expect(decodeOp([cid, Tag.Gap, 7, 1, 2, 3])).toEqual({ ok: false, cid, error: AckError.Unsupported });
    expect(decodeOp([cid, Tag.ScopeLeft, 7, true])).toEqual({ ok: false, cid, error: AckError.Unsupported });
  });

  test("unknown op tag with a valid cid is reported so the server can nack it", () => {
    expect(decodeOp([cid, 99, 7, "x"])).toEqual({ ok: false, cid, error: AckError.Unsupported });
  });

  test("malformed op with a valid cid is nacked as Invalid, not thrown", () => {
    expect(decodeOp([cid, Tag.Delete, 7])).toEqual({ ok: false, cid, error: AckError.Invalid });
    expect(decodeOp([cid, Tag.Reaction, 7, 1, 99, true])).toEqual({ ok: false, cid, error: AckError.Invalid });
    expect(decodeOp([cid, "x", 7])).toEqual({ ok: false, cid, error: AckError.Invalid });
  });

  test("cid must be exactly 8 bytes", () => {
    expect(() => decodeOp([new Uint8Array(7), Tag.Delete, 7, 5])).toThrow(ProtocolError);
    expect(() => decodeOp(["abcdefgh", Tag.Delete, 7, 5])).toThrow(ProtocolError);
  });
});

describe("cbor seam", () => {
  test("rejects trailing bytes", () => {
    const bytes = new Uint8Array([...encode([1]), 0x00]);
    expect(() => decode(bytes)).toThrow(ProtocolError);
  });

  test("rejects truncated input", () => {
    expect(() => decode(new Uint8Array([0x83, 0x01]))).toThrow(ProtocolError);
  });

  test("rejects maps and floats in our schema-free subset", () => {
    expect(() => encode(1.5 as never)).toThrow(ProtocolError);
  });

  test("integers use the shortest form", () => {
    expect(encode(23)).toEqual(new Uint8Array([0x17]));
    expect(encode(24)).toEqual(new Uint8Array([0x18, 24]));
    expect(encode(300)).toEqual(new Uint8Array([0x19, 0x01, 0x2c]));
  });
});
