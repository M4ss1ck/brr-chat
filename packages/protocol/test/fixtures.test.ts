// Compatibility gate. Every fixture from every past version must still decode to the same
// value. Current-version fixtures must also re-encode byte-for-byte (canonical encoding).
//
// .hex files are the wire contract: never edit them. .json files mirror the decoded TypeScript
// shape, so a pure API rename may update them by hand (reviewed). A changed VALUE never may.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, SUPPORTED, Tag, decodeEvent, decodeSyncResponse, type Event } from "../src/index.ts";
import { decode } from "../src/cbor.ts";
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

// The tag numbers a v1 client shipped with, frozen as literals before tag 15 existed. This is
// the check ADR 0004 promises: a client that predates a new tag skips it and still applies
// every event it already understands. The server's delete_author op expands into that shape.
const V1_TAGS = new Set<number>([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]);

test("a v1 client skips the new delete_author marker and applies its delete events", () => {
  const file = join(ROOT, "v1", "sync-response-delete-author");
  const bytes = new Uint8Array(Buffer.from(readFileSync(`${file}.hex`, "utf8").trim(), "hex"));
  const envelope = decode(bytes);
  if (!Array.isArray(envelope) || !Array.isArray(envelope[4])) throw new Error("fixture is not a sync response");
  let skipped = 0;
  const applied: Event[] = [];
  for (const raw of envelope[4] as unknown[]) {
    const tag = Array.isArray(raw) ? (raw[0] as number) : -1;
    if (!V1_TAGS.has(tag)) {
      skipped += 1;
      continue;
    }
    const event = decodeEvent(raw);
    expect(event).not.toBeNull();
    if (event) applied.push(event);
  }
  expect(skipped).toBe(1);
  expect(applied.map((event) => event.tag)).toEqual([Tag.Delete, Tag.Delete]);

  // The current client knows the marker, so the envelope decoder keeps it and skips nothing.
  const current = decodeSyncResponse(bytes);
  expect(current.skipped).toBe(0);
  expect(current.events.map((event) => event.tag)).toEqual([Tag.DeleteAuthor, Tag.Delete, Tag.Delete]);
});
