// Lint rule: packages/protocol/src stays pure. It may import only its own files and
// the CBOR library. No apps/, no DOM, no Bun, no Node. The tsconfig (lib ES2022,
// types []) catches globals; this catches imports.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");
const ALLOWED = new Set(["@levischuck/tiny-cbor"]);
const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;

test("protocol src imports only relative files and allowed packages", () => {
  const bad: string[] = [];
  for (const f of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const code = readFileSync(join(SRC, f), "utf8");
    for (const m of code.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
      if (spec.startsWith("./") || spec.startsWith("../")) {
        if (spec.includes("apps/")) bad.push(`${f}: ${spec}`);
        continue;
      }
      if (!ALLOWED.has(spec)) bad.push(`${f}: ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});

test("the import scanner itself catches violations", () => {
  const sample = `import x from "bun:sqlite"; export { y } from "../../apps/server/x"; const z = await import("node:fs"); import "bun:sqlite";`;
  const specs = [...sample.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
  expect(specs).toEqual(["bun:sqlite", "../../apps/server/x", "node:fs", "bun:sqlite"]);
});
