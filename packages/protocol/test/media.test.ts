import { describe, expect, test } from "bun:test";
import {
  MAX_THUMBHASH_BYTES,
  MEDIA_FULL_EDGE,
  MEDIA_PREVIEW_EDGE,
  MEDIA_THUMBHASH_MAX_BYTES,
  encodeMedia,
  snapMediaWidth,
} from "../src/index.ts";
import { encode } from "../src/cbor.ts";

describe("media variants", () => {
  test("the preview and full edges are the ADR 0011 numbers", () => {
    expect(MEDIA_PREVIEW_EDGE).toBe(320);
    expect(MEDIA_FULL_EDGE).toBe(1280);
  });

  test("the product placeholder cap is inside the wire cap and the 40 B budget", () => {
    expect(MEDIA_THUMBHASH_MAX_BYTES).toBeLessThanOrEqual(MAX_THUMBHASH_BYTES);
    const field = encode(
      encodeMedia({
        id: 4_000_000_000,
        w: 4096,
        h: 4096,
        thumbhash: new Uint8Array(MEDIA_THUMBHASH_MAX_BYTES).fill(255),
      }),
    );
    expect(field.length).toBeLessThanOrEqual(40);
  });

  test("a missing or unusable width asks for the data-saving preview", () => {
    expect(snapMediaWidth(null)).toBe(320);
    expect(snapMediaWidth(undefined)).toBe(320);
    expect(snapMediaWidth(0)).toBe(320);
    expect(snapMediaWidth(-40)).toBe(320);
    expect(snapMediaWidth(Number.NaN)).toBe(320);
    expect(snapMediaWidth(Number.POSITIVE_INFINITY)).toBe(320);
  });

  test("a width snaps to the nearer variant", () => {
    expect(snapMediaWidth(64)).toBe(320);
    expect(snapMediaWidth(320)).toBe(320);
    expect(snapMediaWidth(799)).toBe(320);
    expect(snapMediaWidth(801)).toBe(1280);
    expect(snapMediaWidth(1000)).toBe(1280);
    expect(snapMediaWidth(4096)).toBe(1280);
  });

  test("an exact tie goes to the cheaper preview", () => {
    expect(snapMediaWidth(800)).toBe(320);
  });
});
