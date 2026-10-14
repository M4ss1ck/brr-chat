// CI wiring (issue #4): GitHub Actions must run the exact same gate as
// `.githooks/pre-commit` (`bun run check`), which typechecks every workspace and
// runs the byte-budget tests, with Bun pinned to the version in `.bun-version`.
// See ADR 0002 (Bun 1.4) and ADR 0005 (`bun run check` is the gate).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const PACKAGE_JSON = join(ROOT, "package.json");
const BUDGET_TEST = join(ROOT, "packages", "protocol", "test", "budget.test.ts");

// Explicit file argument only: this never discovers and re-runs ci.test.ts.
function runTest(file: string): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync({ cmd: ["bun", "test", file], cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
  };
}

describe("bun version pin", () => {
  test(".bun-version pins a semver 1.4.x release per ADR 0002", () => {
    const pinned = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
    expect(pinned).toMatch(/^1\.4\.\d+$/);
  });
});

describe("ci workflow", () => {
  const read = () => readFileSync(WORKFLOW, "utf8");

  test("triggers on push to main and on every pull request", () => {
    const yaml = read();
    expect(yaml).toMatch(/^on:/m);
    expect(yaml).toMatch(/^\s+push:/m);
    expect(yaml).toMatch(/^\s+pull_request:/m);
    expect(yaml).toMatch(/branches:\s*\[\s*main\s*\]/);
  });

  test("checks out the repo and sets Bun up from .bun-version", () => {
    const yaml = read();
    expect(yaml).toMatch(/actions\/checkout@v\d+/);
    expect(yaml).toMatch(/oven-sh\/setup-bun@v\d+/);
    expect(yaml).toMatch(/bun-version-file:\s*\.bun-version/);
  });

  test("installs frozen and runs the full check", () => {
    const yaml = read();
    expect(yaml).toContain("bun install --frozen-lockfile");
    expect(yaml).toContain("bun run check");
  });
});

describe("ci runs the full check:all gate", () => {
  test("CI invokes check:all, so the slow server tests run too", () => {
    expect(readFileSync(WORKFLOW, "utf8")).toMatch(/run:\s*bun run check:all\s*$/m);
  });

  test("check:all chains the fast check with the slow compile test", () => {
    const scripts = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).scripts;
    expect(scripts["check:all"]).toContain("bun run check");
    expect(scripts["check:all"]).toContain("bun run test:slow");
    expect(scripts["test:slow"]).toContain("BRR_SLOW=1");
    expect(scripts["test:slow"]).toContain("apps/server/test/compile.test.ts");
  });
});

describe("byte budgets are a CI gate", () => {
  test("budget numbers are printed to stdout, so they show in the job log", () => {
    const out = runTest(BUDGET_TEST);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("empty sync payload:");
    expect(out.stdout).toContain("100 posts:");
    expect(out.stdout).toContain("media placeholder:");
  });

  test("breaking a byte budget fails the run with a non-zero exit code", () => {
    // Reuse the real budget test, but tighten its 100-post ceiling to 1 byte so
    // the unchanged assertion fails. Rewrite the relative source imports to
    // absolute ones so the copy runs from a scratch directory.
    const source = readFileSync(BUDGET_TEST, "utf8");
    const broken = source
      .replaceAll('"../src/index.ts"', JSON.stringify(join(ROOT, "packages", "protocol", "src", "index.ts")))
      .replaceAll('"../src/cbor.ts"', JSON.stringify(join(ROOT, "packages", "protocol", "src", "cbor.ts")))
      .replace("toBeLessThanOrEqual(20 * KB)", "toBeLessThanOrEqual(1)");
    expect(broken).not.toBe(source);

    const dir = mkdtempSync(join(tmpdir(), "brr-ci-"));
    const file = join(dir, "budget.test.ts");
    try {
      writeFileSync(file, broken);
      expect(runTest(file).exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
