// Events and ops are positional CBOR arrays described by one table (SCHEMA).
// Adding an event type = one Tag entry + one SCHEMA row + fixtures. See docs/PROTOCOL.md.
import type { Wire } from "./cbor.ts";
import { AckError, ProtocolError } from "./errors.ts";

export const Tag = {
  Post: 1,
  Reply: 2,
  Dm: 3,
  Reaction: 4,
  Delete: 5,
  Profile: 6,
  // 7 is reserved (friend_state, dropped before v1). Never reuse a tag.
  GroupMeta: 8,
  Membership: 9,
  Ban: 10,
  ScopeLeft: 11,
  Gap: 12,
} as const;
export type Tag = (typeof Tag)[keyof typeof Tag];

export const MAX_TEXT_BYTES = 4000;
export const MAX_THUMBHASH_BYTES = 32;
export const EMOJI_PALETTE_SIZE = 8;
export const Role = { None: 0, Member: 1, Moderator: 2, Admin: 3 } as const;

export interface Media {
  id: number;
  w: number;
  h: number;
  thumbhash: Uint8Array;
}

type Kind = "uint" | "text" | "bool" | "emoji" | "role" | "media?";
interface KindType {
  uint: number;
  text: string;
  bool: boolean;
  emoji: number;
  role: number;
  "media?": Media | null;
}

/**
 * Field layout per tag, after the header. Rules (docs/adr/0004):
 * fields are only ever appended; appended fields must be optional ("?").
 */
const SCHEMA = {
  [Tag.Post]: [["text", "text"], ["media", "media?"]],
  [Tag.Reply]: [["parent", "uint"], ["text", "text"], ["media", "media?"]],
  [Tag.Dm]: [["peer", "uint"], ["text", "text"], ["media", "media?"]],
  [Tag.Reaction]: [["target", "uint"], ["emoji", "emoji"], ["on", "bool"]],
  [Tag.Delete]: [["target", "uint"]],
  [Tag.Profile]: [["username", "text"], ["displayName", "text"], ["bio", "text"]],
  [Tag.GroupMeta]: [["name", "text"], ["about", "text"], ["open", "bool"]],
  [Tag.Membership]: [["user", "uint"], ["role", "role"]],
  [Tag.Ban]: [["user", "uint"], ["on", "bool"]],
  [Tag.ScopeLeft]: [["purge", "bool"]],
  [Tag.Gap]: [["after", "uint"], ["before", "uint"], ["count", "uint"]],
} as const satisfies Record<Tag, readonly (readonly [string, Kind])[]>;

/** Tags a client may send in its outbox. The rest are server-generated. */
const OP_TAGS: ReadonlySet<number> = new Set<Tag>([
  Tag.Post, Tag.Reply, Tag.Dm, Tag.Reaction, Tag.Delete, Tag.Profile, Tag.GroupMeta, Tag.Membership, Tag.Ban,
]);

type Fields<F> = F extends readonly (readonly [string, Kind])[]
  ? { [P in F[number] as P[0]]: KindType[P[1]] }
  : never;
type BodyOf<T extends Tag> = { tag: T } & Fields<(typeof SCHEMA)[T]>;
export type Body = { [T in Tag]: BodyOf<T> }[Tag];
export type OpTag = Exclude<Tag, typeof Tag.ScopeLeft | typeof Tag.Gap>;
export type OpBody = { [T in OpTag]: BodyOf<T> }[OpTag];

export interface Header {
  /** Position in the server log. Also the id of the thing this event creates. */
  seq: number;
  /** Unix seconds. */
  ts: number;
  /** Acting user id; 0 for server-generated events. */
  author: number;
  /** Group or DM scope id; 0 for server-wide events. */
  scope: number;
}
export type Event = Header & Body;

/** An outbox item. `cid` is 8 random bytes chosen by the device; retries reuse it. */
export type Op = { cid: Uint8Array; scope: number } & OpBody;

export type DecodedOp = { ok: true; op: Op } | { ok: false; cid: Uint8Array; error: AckError };

// ---- field codecs ----

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export function uint(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new ProtocolError(`${what}: expected uint`);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new ProtocolError(`${what}: expected bool`);
  return v;
}

export function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ProtocolError(`${what}: expected array`);
  return v;
}

export function encodeMedia(m: Media): Wire {
  return [m.id, m.w, m.h, m.thumbhash];
}

function decodeMedia(v: unknown): Media | null {
  if (v === undefined || v === null) return null;
  const a = arr(v, "media");
  const thumbhash = a[3];
  if (!(thumbhash instanceof Uint8Array) || thumbhash.length > MAX_THUMBHASH_BYTES) {
    throw new ProtocolError("media.thumbhash: expected bytes");
  }
  return { id: uint(a[0], "media.id"), w: uint(a[1], "media.w"), h: uint(a[2], "media.h"), thumbhash };
}

function decodeField(kind: Kind, v: unknown, what: string): unknown {
  switch (kind) {
    case "uint":
      return uint(v, what);
    case "bool":
      return bool(v, what);
    case "text":
      if (typeof v !== "string") throw new ProtocolError(`${what}: expected text`);
      if (utf8Length(v) > MAX_TEXT_BYTES) throw new ProtocolError(`${what}: text too long`);
      return v;
    case "emoji": {
      const n = uint(v, what);
      if (n >= EMOJI_PALETTE_SIZE) throw new ProtocolError(`${what}: emoji out of palette`);
      return n;
    }
    case "role": {
      const n = uint(v, what);
      if (n > Role.Admin) throw new ProtocolError(`${what}: role out of range`);
      return n;
    }
    case "media?":
      return decodeMedia(v);
  }
}

function encodeFields(body: Body): Wire[] {
  const schema = SCHEMA[body.tag];
  const rec = body as unknown as Record<string, unknown>;
  const out: Wire[] = schema.map(([name, kind]) => {
    const v = rec[name];
    return kind === "media?" ? (v ? encodeMedia(v as Media) : null) : (v as Wire);
  });
  // Drop trailing nulls in optional slots: decoders treat a missing optional as null.
  for (let i = out.length - 1; i >= 0 && out[i] === null && schema[i]![1].endsWith("?"); i--) out.pop();
  return out;
}

/** Returns null for an unknown tag. Fields beyond the schema are ignored (newer peer). */
function decodeFields(tag: number, a: unknown[], from: number, what: string): Body | null {
  if (!Object.hasOwn(SCHEMA, tag)) return null;
  const schema = SCHEMA[tag as Tag];
  const body: Record<string, unknown> = { tag };
  schema.forEach(([name, kind], i) => {
    const v = a[from + i];
    if (v === undefined && !kind.endsWith("?")) throw new ProtocolError(`${what}.${name}: missing`);
    body[name] = decodeField(kind, v, `${what}.${name}`);
  });
  return body as Body;
}

// ---- events: [tag, seq, ts, author, scope, ...fields] ----

export function encodeEvent(e: Event): Wire[] {
  return [e.tag, e.seq, e.ts, e.author, e.scope, ...encodeFields(e)];
}

export function decodeEvent(v: unknown): Event | null {
  const a = arr(v, "event");
  const tag = uint(a[0], "event.tag");
  const header: Header = {
    seq: uint(a[1], "event.seq"),
    ts: uint(a[2], "event.ts"),
    author: uint(a[3], "event.author"),
    scope: uint(a[4], "event.scope"),
  };
  const body = decodeFields(tag, a, 5, "event");
  return body && { ...header, ...body };
}

// ---- ops: [cid, tag, scope, ...fields] ----

export const CID_BYTES = 8;

export function encodeOp(o: Op): Wire[] {
  return [o.cid, o.tag, o.scope, ...encodeFields(o)];
}

export function decodeOp(v: unknown): DecodedOp {
  const a = arr(v, "op");
  const cid = a[0];
  if (!(cid instanceof Uint8Array) || cid.length !== CID_BYTES) throw new ProtocolError("op.cid: expected 8 bytes");
  // Past this point the op is answerable: reject it with a nack instead of throwing, so one bad
  // op cannot fail the whole request and wedge the device's outbox forever.
  try {
    const tag = uint(a[1], "op.tag");
    const scope = uint(a[2], "op.scope");
    if (!OP_TAGS.has(tag)) return { ok: false, cid, error: AckError.Unsupported };
    const body = decodeFields(tag, a, 3, "op") as OpBody;
    return { ok: true, op: { cid, scope, ...body } };
  } catch (e) {
    if (e instanceof ProtocolError) return { ok: false, cid, error: AckError.Invalid };
    throw e;
  }
}
