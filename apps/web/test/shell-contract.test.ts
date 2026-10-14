// The shell has two halves written in different languages: the document (built by
// scripts/build.ts) and the bundle that looks up its element ids (src/main.ts). This is the
// contract between them, so a rename in one place fails here instead of failing in a browser.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const DIST = resolve(WEB_ROOT, "dist");

/** Ids main.ts wires up: elements that must exist in the document. */
const ELEMENT_IDS = [
  "username",
  "password",
  "sign-up",
  "sign-in",
  "sign-out",
  "sync",
  "signed-out",
  "signed-in",
  "account",
  "token",
  "cursor",
  "range",
  "empty",
  "status",
] as const;

function read(file: string): string {
  return readFileSync(resolve(DIST, file), "utf8");
}

describe("shell contract", () => {
  beforeAll(() => {
    const proc = Bun.spawnSync({ cmd: [process.execPath, "scripts/build.ts"], cwd: WEB_ROOT, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`apps/web build failed:\n${proc.stderr.toString()}`);
  });

  test("the document declares every element the app looks up", () => {
    const html = read("index.html");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    for (const id of ELEMENT_IDS) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("the bundle looks up every element it declares", () => {
    const bundle = read("app.js");
    for (const id of ELEMENT_IDS) {
      expect(bundle).toContain(JSON.stringify(id));
    }
  });

  test("the document loads the bundle and the manifest, and the service worker path", () => {
    const html = read("index.html");
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
    expect(read("app.js")).toContain("/sw.js");
    expect(read("sw.js")).toContain("/manifest.webmanifest");
  });

  test("the manifest is a valid install target", () => {
    const manifest = JSON.parse(read("manifest.webmanifest")) as Record<string, unknown>;
    expect(manifest.name).toBe("brr chat");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    const icons = manifest.icons as { src: string; type: string; purpose: string }[];
    expect(icons).toHaveLength(1);
    expect(icons[0]?.src).toBe("/icon.svg");
    expect(icons[0]?.purpose).toContain("maskable");
  });

  test("no shell asset needs a request the shell does not name", () => {
    // Nothing in the document points outside the built shell: every URL is a route the
    // server embeds, so first load is one visit, not a cascade.
    const html = read("index.html");
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("/")).toBe(true);
      expect(url).not.toMatch(/^https?:/);
    }
  });
});
