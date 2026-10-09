import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, SUPPORTED, negotiate, ResponseError } from "../src/index.ts";

describe("version handshake", () => {
  test("current version is inside the supported range", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(SUPPORTED.min);
    expect(PROTOCOL_VERSION).toBeLessThanOrEqual(SUPPORTED.max);
  });

  test("in range is accepted", () => {
    expect(negotiate(2, { min: 1, max: 3 })).toBeNull();
    expect(negotiate(1, { min: 1, max: 1 })).toBeNull();
  });

  test("below range means the client must update", () => {
    expect(negotiate(1, { min: 2, max: 3 })).toBe(ResponseError.ClientTooOld);
  });

  test("above range means the server is older than the client", () => {
    expect(negotiate(4, { min: 2, max: 3 })).toBe(ResponseError.ClientTooNew);
  });

  test("garbage versions are treated as too old", () => {
    expect(negotiate(0, SUPPORTED)).toBe(ResponseError.ClientTooOld);
    expect(negotiate(-1, SUPPORTED)).toBe(ResponseError.ClientTooOld);
    expect(negotiate(1.5, SUPPORTED)).toBe(ResponseError.ClientTooOld);
  });
});
