// Writes fixtures for the current PROTOCOL_VERSION. Never overwrites an existing file:
// a frozen fixture is a promise to every client already in the field.
//   bun run freeze-fixtures
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../src/index.ts";
import { decodeFixture, toJson } from "../test/fixture-codec.ts";
import { fixtures } from "./fixtures.ts";

const dir = join(import.meta.dir, "..", "fixtures", `v${PROTOCOL_VERSION}`);
mkdirSync(dir, { recursive: true });
let wrote = 0;
for (const [name, bytes] of Object.entries(fixtures)) {
  const hexPath = join(dir, `${name}.hex`);
  if (existsSync(hexPath)) continue;
  writeFileSync(hexPath, Buffer.from(bytes).toString("hex") + "\n");
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(toJson(decodeFixture(name, bytes)), null, 2) + "\n");
  console.log(`froze v${PROTOCOL_VERSION}/${name} (${bytes.length} B)`);
  wrote++;
}
console.log(wrote ? `${wrote} new fixture(s)` : "nothing new; existing fixtures are frozen");
