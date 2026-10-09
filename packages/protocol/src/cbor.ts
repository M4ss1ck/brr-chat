// The only file that touches the CBOR library. Swap libraries here and nowhere else.
import { decodePartialCBOR, encodeCBOR } from "@levischuck/tiny-cbor";
import { ProtocolError } from "./errors.ts";

/** The CBOR subset the protocol emits: no maps, no floats, no tags, no bigints. */
export type Wire = number | string | boolean | null | Uint8Array | Wire[];

function check(v: unknown, depth: number): void {
  if (depth > 8) throw new ProtocolError("nesting too deep");
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new ProtocolError("non-integer number");
  } else if (Array.isArray(v)) {
    for (const x of v) check(x, depth + 1);
  } else if (!(typeof v === "string" || typeof v === "boolean" || v === null || v instanceof Uint8Array)) {
    throw new ProtocolError(`unsupported CBOR value: ${typeof v}`);
  }
}

export function encode(v: Wire): Uint8Array {
  check(v, 0);
  return encodeCBOR(v);
}

/**
 * Decode any well-formed CBOR. Deliberately no subset check: content this version does not
 * understand (new fields, new event tags, even maps) must pass through so callers can skip it.
 * Field decoders validate every value they actually read.
 */
export function decode(bytes: Uint8Array): unknown {
  let value: unknown;
  let end: number;
  try {
    [value, end] = decodePartialCBOR(bytes, 0);
  } catch (e) {
    throw new ProtocolError(`invalid CBOR: ${(e as Error).message}`);
  }
  if (end !== bytes.length) throw new ProtocolError("trailing bytes after CBOR value");
  return value;
}
