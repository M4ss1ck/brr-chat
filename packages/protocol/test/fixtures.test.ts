// Compatibility gate. Every fixture from every past version must still decode to the same
// value. Current-version fixtures must also re-encode byte-for-byte (canonical encoding).
//
// .hex files are the wire contract: never edit them. .json files mirror the decoded TypeScript
// shape, so a pure API rename may update them by hand (reviewed). A changed VALUE never may.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, SUPPORTED } from "../src/index.ts";
import { fixtures } from "../scripts/fixtures.ts";
import { decodeFixture, toJson } from "./fixture-codec.ts";

const ROOT = join(import.meta.dir, "..", "fixtures");
const versions = readdirSync(ROOT).filter((d) => /^v\d+$/.test(d)).sort();

test("fixtures exist for the current version and every supported version", () => {
  for (let v = SUPPORTED.min; v <= PROTOCOL_VERSION; v++) expect(versions).toContain(`v${v}`);
});

test("every current fixture source is frozen (run `bun run freeze-fixtures`)", () => {
  const frozen = readdirSync(join(ROOT, `v${PROTOCOL_VERSION}`));
  for (const name of Object.keys(fixtures)) expect(frozen).toContain(`${name}.hex`);
});

for (const dir of versions) {
  describe(dir, () => {
    const names = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".hex")).map((f) => f.slice(0, -4));
    test.each(names)("%s decodes to its frozen value", (name) => {
      const bytes = Buffer.from(readFileSync(join(ROOT, dir, `${name}.hex`), "utf8").trim(), "hex");
      const expected = JSON.parse(readFileSync(join(ROOT, dir, `${name}.json`), "utf8"));
      expect(toJson(decodeFixture(name, new Uint8Array(bytes)))).toEqual(expected);
    });
    if (dir === `v${PROTOCOL_VERSION}`) {
      test.each(names.filter((n) => n in fixtures))("%s re-encodes byte-for-byte", (name) => {
        const frozen = readFileSync(join(ROOT, dir, `${name}.hex`), "utf8").trim();
        expect(Buffer.from(fixtures[name]!).toString("hex")).toBe(frozen);
      });
    }
  });
}
