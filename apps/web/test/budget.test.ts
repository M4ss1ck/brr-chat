// The app shell budget from docs/PROTOCOL.md, measured on the real build output: brotli is
// what the user downloads. The build also regenerates the module the server embeds, so a stale
// embedded shell fails here instead of shipping.
import { beforeAll, describe, expect, test } from "bun:test";
import { brotliCompressSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const KB = 1024;
/** docs/PROTOCOL.md: "App shell, compressed | 150 KB". Do not raise without an ADR. */
const APP_SHELL_BUDGET = 150 * KB;

const WEB_ROOT = resolve(import.meta.dir, "..");
const DIST = resolve(WEB_ROOT, "dist");
const EMBEDDED = resolve(WEB_ROOT, "..", "server", "src", "pwa-assets.generated.ts");
const SHELL_FILES = ["index.html", "app.js", "sw.js", "manifest.webmanifest", "icon.svg"] as const;

function buildShell(): void {
  const proc = Bun.spawnSync({ cmd: [process.execPath, "scripts/build.ts"], cwd: WEB_ROOT, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`apps/web build failed:\n${proc.stderr.toString()}`);
}

/** Route list the server embeds. The drift test below keeps the generated file honest. */
function shellRoutes(): string[] {
  const source = readFileSync(EMBEDDED, "utf8");
  const block = source.slice(source.indexOf("export const SHELL_ROUTES"));
  return [...block.matchAll(/^ {2}"([^"]+)": "[^"]+",$/gm)].map((m) => m[1] ?? "");
}

describe("app shell budget", () => {
  beforeAll(buildShell);

  test("every shell asset exists", () => {
    for (const file of SHELL_FILES) {
      expect(existsSync(resolve(DIST, file))).toBe(true);
    }
  });

  test("the shell stays at or below 150 KB compressed", () => {
    let total = 0;
    for (const file of SHELL_FILES) {
      const body = readFileSync(resolve(DIST, file));
      const compressed = brotliCompressSync(body).length;
      total += compressed;
      console.log(`app shell ${file}: ${body.byteLength} B raw, ${compressed} B brotli`);
    }
    console.log(`app shell compressed: ${total} B of ${APP_SHELL_BUDGET} B budget`);
    expect(total).toBeLessThanOrEqual(APP_SHELL_BUDGET);
  });

  test("the document loads the bundle, the manifest and the service worker", () => {
    const html = readFileSync(resolve(DIST, "index.html"), "utf8");
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    const sw = readFileSync(resolve(DIST, "sw.js"), "utf8");
    expect(sw).toContain("/app.js");
  });

  test("every shell route the server serves is precached by the service worker", () => {
    const sw = readFileSync(resolve(DIST, "sw.js"), "utf8");
    for (const route of shellRoutes()) {
      if (route === "/") continue;
      // "/" is a navigation target, served from the cache by the navigation branch.
      expect(sw).toContain(JSON.stringify(route));
    }
  });

  test("the embedded shell the server embeds matches this build", () => {
    const generated = "../server/src/pwa-assets.generated.ts";
    const tracked = Bun.spawnSync({ cmd: ["git", "ls-files", "--error-unmatch", "--", generated], cwd: WEB_ROOT });
    if (tracked.exitCode === null) return; // no git available: freshness cannot be checked here
    expect(tracked.exitCode).toBe(0);

    const diff = Bun.spawnSync({ cmd: ["git", "diff", "--quiet", "--exit-code", "--", generated], cwd: WEB_ROOT });
    expect(diff.exitCode).toBe(0);
  });
});
