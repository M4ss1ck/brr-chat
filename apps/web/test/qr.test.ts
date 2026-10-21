// The QR code is only a rendering of the invite URL (ADR 0010): same value, no second
// credential, and an inline SVG so the shell makes no extra request.
import { describe, expect, test } from "bun:test";
import qrcode from "qrcode-generator";
import { decodeQr, qrSvg } from "../src/qr.ts";
import { parseServerLink } from "../src/servers.ts";

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

/** Paints the matrix the same generator draws in the SVG, so decoding is a real round trip. */
function rasterize(link: string, scale = 4, margin = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const code = qrcode(0, "M");
  code.addData(link);
  code.make();
  const modules = code.getModuleCount();
  const size = (modules + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!code.isDark(row, column)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const px = (margin + column) * scale + x;
          const py = (margin + row) * scale + y;
          const at = (py * size + px) * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
          data[at + 3] = 255;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

describe("QR scanning", () => {
  test("a server invite shown as a QR code decodes back to the same link", () => {
    const link = "https://chat.example/signup/abcdefghijklmnopqrstuv";
    const pixels = rasterize(link);
    expect(decodeQr(pixels.data, pixels.width, pixels.height)).toBe(link);
    expect(parseServerLink(decodeQr(pixels.data, pixels.width, pixels.height) ?? "")).toEqual({
      server: "https://chat.example",
      invite: { kind: "signup", token: "abcdefghijklmnopqrstuv" },
    });
  });

  test("an empty image decodes as nothing rather than throwing", () => {
    expect(decodeQr(new Uint8ClampedArray(16 * 16 * 4).fill(255), 16, 16)).toBeNull();
    expect(decodeQr(new Uint8ClampedArray(0), 0, 0)).toBeNull();
  });
});
