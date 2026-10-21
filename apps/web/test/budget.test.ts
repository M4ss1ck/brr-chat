// The app shell budget from docs/PROTOCOL.md, measured on the real build output: brotli is
// what the user downloads. The build also regenerates the module the server embeds, so a stale
// embedded shell fails here instead of shipping.
import { beforeAll, describe, expect, test } from "bun:test";
import { brotliCompressSync } from "node:zlib";
import { APP_SHELL_BUDGET } from "@brr-chat/protocol";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const DIST = resolve(WEB_ROOT, "dist");
const EMBEDDED = resolve(WEB_ROOT, "..", "server", "src", "pwa-assets.generated.ts");
const SHELL_FILES = ["index.html", "app.js", "sw.js", "manifest.webmanifest", "icon.svg", "qr-scan.js", "passkey.js"] as const;
/** Fetched on demand, never at install, so it does not affect first load (ADR 0014, 0021). */
const LAZY_FILES = ["qr-scan.js", "passkey.js"] as const;

function buildShell(): void {
  const proc = Bun.spawnSync({ cmd: [process.execPath, "scripts/build.ts"], cwd: WEB_ROOT, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`apps/web build failed:\n${proc.stderr.toString()}`);
}

/** Route list the server embeds. The drift test below keeps the generated file honest. */
function shellRoutes(): string[] {
  const source = readFileSync(EMBEDDED, "utf8");
  const block = source.slice(source.indexOf("export const SHELL_ROUTES"));
  const routes = [...block.matchAll(/^ {2}"([^"]+)": "[^"]+",$/gm)].map((m) => m[1] ?? "");
  // An empty list would make the route checks below pass on nothing, so it must not be empty.
  expect(routes.length).toBeGreaterThan(0);
  return routes;
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
    let firstLoad = 0;
    for (const file of SHELL_FILES) {
      const body = readFileSync(resolve(DIST, file));
      const compressed = brotliCompressSync(body).length;
      total += compressed;
      if (!(LAZY_FILES as readonly string[]).includes(file)) firstLoad += compressed;
      console.log(`app shell ${file}: ${body.byteLength} B raw, ${compressed} B brotli`);
    }
    console.log(`app shell first load: ${firstLoad} B, all files: ${total} B of ${APP_SHELL_BUDGET} B budget`);
    // A lazy chunk is only paid for by the person who uses that screen; the gate still
    // counts every file, as it does for the QR scanner (ADR 0014, ADR 0021).
    expect(firstLoad).toBeLessThanOrEqual(total);
    expect(total).toBeLessThanOrEqual(APP_SHELL_BUDGET);
  });

  test("the WebAuthn library is in its lazy chunk, not in the first load", () => {
    const app = readFileSync(resolve(DIST, "app.js"), "utf8");
    expect(app).not.toContain("startRegistration");
    expect(app).not.toContain("navigator.credentials");
    expect(app).toContain("/passkey.js");

    const chunk = readFileSync(resolve(DIST, "passkey.js"), "utf8");
    expect(chunk).toContain("navigator.credentials");

    // The worker caches a lazy chunk on first use but must not precache it at install.
    const sw = readFileSync(resolve(DIST, "sw.js"), "utf8");
    for (const file of LAZY_FILES) expect(sw).toContain(JSON.stringify(`/${file}`));
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
      // "/" is a navigation target, answered from the cached document by the navigation branch.
      if (route === "/") continue;
      expect(sw).toContain(JSON.stringify(route));
    }
  });

  test("the embedded shell the server embeds matches this build and is not left unstaged", () => {
    const generated = resolve(WEB_ROOT, "..", "server", "src", "pwa-assets.generated.ts");
    if (Bun.which("git") === null) {
      console.log("git is unavailable: the embedded shell freshness check is skipped");
      return;
    }
    // Git commands run from the repository root: during a pre-commit hook Git may export a
    // relative GIT_INDEX_FILE, which breaks when the child process changes directory.
    const repoRoot = resolve(WEB_ROOT, "..", "..");
    const relativePath = relative(repoRoot, generated);
    const tracked = Bun.spawnSync({ cmd: ["git", "ls-files", "--error-unmatch", "--", relativePath], cwd: repoRoot });
    expect(tracked.exitCode).toBe(0);

    // The build above just rewrote the file. It is honest when git has nothing fresh to say:
    // either it is already committed, or it is staged for the commit being made right now.
    // An unstaged modification or an untracked file means the build never made it into a
    // commit, which is what this gate is for.
    const status = Bun.spawnSync({ cmd: ["git", "status", "--porcelain", "--", relativePath], cwd: repoRoot });
    const line = status.stdout.toString().trim();
    if (line.length > 0) {
      expect(line.startsWith("M ") || line.startsWith("A ")).toBe(true);
    }
  });
});
