// The QR code is only a rendering of the invite URL (ADR 0010): same value, no second
// credential, and an inline SVG so the shell makes no extra request.
import { describe, expect, test } from "bun:test";
import { qrSvg } from "../src/qr.ts";

describe("invite QR", () => {
  test("renders an inline SVG and is deterministic for the same link", () => {
    const link = "http://chat.local/join/abcdefghijklmnopqrstuv";
    const svg = qrSvg(link);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).not.toContain("<image");
    expect(qrSvg(link)).toBe(svg);
  });

  test("a different link changes the code", () => {
    expect(qrSvg("http://chat.local/join/one")).not.toBe(qrSvg("http://chat.local/join/two"));
  });
});
