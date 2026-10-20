import { describe, expect, test } from "bun:test";
import { identicon } from "../src/identicon.ts";

function svg(dataUrl: string): string {
  expect(dataUrl.startsWith("data:image/svg+xml,")).toBe(true);
  return decodeURIComponent(dataUrl.slice("data:image/svg+xml,".length));
}

describe("identicon", () => {
  test("is deterministic for one wire id", () => {
    expect(identicon(42)).toBe(identicon(42));
  });

  test("different wire ids draw different patterns", () => {
    expect(identicon(1)).not.toBe(identicon(2));
    expect(svg(identicon(1))).not.toBe(svg(identicon(2)));
  });

  test("is a self-contained 40x40 svg with at least one cell", () => {
    const markup = svg(identicon(7));
    expect(markup).toContain('viewBox="0 0 40 40"');
    expect(markup).toContain("<svg");
    expect(markup).toContain("<rect");
    expect(markup).not.toContain("http://www.w3.org/2000/svg\"/>");
  });

  test("mirrors every cell so the avatar has a face-like axis", () => {
    const markup = svg(identicon(9));
    const xs = [...markup.matchAll(/<rect x="(\d+)"/g)].map((match) => Number(match[1]));
    const mirrored = xs.filter((x) => x !== 16).map((x) => 32 - x);
    expect(new Set(xs)).toEqual(new Set([...xs.filter((x) => x === 16), ...mirrored]));
    expect(xs.length % 2 === 0 || xs.includes(16)).toBe(true);
  });
});
