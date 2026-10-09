// Byte budgets from the product spec. These are CI gates: if one fails, the change
// costs users money on metered connections. Do not raise a budget without an ADR.
import { describe, expect, test } from "bun:test";
import { brotliCompressSync } from "node:zlib";
import { SUPPORTED, Tag, encodeMedia, encodeSyncRequest, encodeSyncResponse, type Event } from "../src/index.ts";
import { encode } from "../src/cbor.ts";

const KB = 1024;
const br = (b: Uint8Array) => brotliCompressSync(b).length;

// Deterministic, realistic-ish Spanish/English chat text, 20..220 chars.
const words = "hola que tal mañana vamos al malecón la guagua no llega otra vez se fue la luz alguien tiene datos the meeting moved to friday bring water photos later ok jaja dale nos vemos".split(" ");
function text(i: number): string {
  let s = "";
  let x = (i * 2654435761) >>> 0;
  const len = 20 + (x % 200);
  while (s.length < len) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += (s ? " " : "") + words[x % words.length];
  }
  return s;
}

function hundredPosts(): Event[] {
  return Array.from({ length: 100 }, (_, i) => ({
    tag: Tag.Post,
    seq: 1_000_000 + i,
    ts: 1_791_000_000 + i * 37,
    author: 100 + (i % 12),
    scope: 5 + (i % 4),
    text: text(i),
    media: null,
  }));
}

describe("byte budgets", () => {
  test("empty sync (request + response) <= 1 KB", () => {
    const req = encodeSyncRequest({ v: 1, cursor: 4_000_000_000, outbox: [] });
    const res = encodeSyncResponse({ range: SUPPORTED, cursor: 4_000_000_000, more: false, events: [], acks: [], skipped: 0 });
    const total = req.length + res.length;
    console.log(`empty sync payload: ${req.length} + ${res.length} = ${total} B`);
    // Payload only. HTTP headers and the bearer token are measured in apps/server.
    expect(total).toBeLessThanOrEqual(1 * KB);
    expect(total).toBeLessThanOrEqual(32); // tripwire: any growth here is a design change
  });

  test("100 text posts <= 20 KB uncompressed", () => {
    const posts = hundredPosts();
    const textBytes = posts.reduce((n, p) => n + Buffer.byteLength((p as { text: string }).text), 0);
    const bytes = encodeSyncResponse({ range: SUPPORTED, cursor: 1, more: false, events: posts, acks: [], skipped: 0 });
    const overhead = (bytes.length - textBytes) / 100;
    console.log(`100 posts: ${bytes.length} B raw, ${br(bytes)} B brotli, text ${textBytes} B, ${overhead.toFixed(1)} B/post overhead`);
    expect(bytes.length).toBeLessThanOrEqual(20 * KB);
    expect(overhead).toBeLessThanOrEqual(20); // framing per post: tag+seq+ts+author+scope+text header
  });

  test("image placeholder (whole media field, max-size thumbhash) <= 40 B", () => {
    const media = encode(encodeMedia({ id: 4_000_000_000, w: 4096, h: 4096, thumbhash: new Uint8Array(25).fill(255) }));
    console.log(`media placeholder: ${media.length} B`);
    expect(media.length).toBeLessThanOrEqual(40);
  });
});
