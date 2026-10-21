// Issue #21: /sync responses use RFC 9842 dictionary-compressed zstd (dcz) when the client
// has the shared dictionary, and brotli otherwise. The benchmark is the protocol's own
// 100-post fixture (packages/protocol/test/posts.ts), measured through the same compressor
// the handler uses.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, zstdDecompressSync } from "node:zlib";
import {
  PROTOCOL_VERSION,
  SUPPORTED,
  Tag,
  decodeSyncResponse,
  encodeSyncRequest,
  encodeSyncResponse,
  type Op,
  type SyncResponse,
} from "@brr-chat/protocol";
import { createApp, type ServerApp } from "../src/index.ts";
import {
  DCZ_HEADER_BYTES,
  DCZ_MAGIC,
  DICTIONARY_VARY,
  SYNC_DICTIONARY,
  SYNC_DICTIONARY_HASH_B64,
  SYNC_DICTIONARY_ID,
  SYNC_DICTIONARY_PATH,
  dczCompress,
} from "../src/dictionary.ts";
import { hundredPosts, sampleText } from "@brr-chat/protocol/sample-corpus";

const ORIGIN = "http://chat.local";

/** The 100-post batches below exceed the production 30 messages/minute budget on purpose. */
function testApp(): Promise<ServerApp> {
  return createApp({ dbPath: ":memory:", host: "chat.local", limits: { messagesPerMinute: 200 } });
}

async function signUpAlice(app: ServerApp): Promise<string> {
  const res = await app.fetch(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ username: "alice", password: "password1234" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; recoveryCode: string };
  const confirm = await app.fetch(
    new Request(`${ORIGIN}/api/recovery/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ group: body.recoveryCode.slice(-5) }),
    }),
  );
  expect(confirm.status).toBe(200);
  return body.token;
}

const DICTIONARY_HEADERS = {
  "Available-Dictionary": `:${SYNC_DICTIONARY_HASH_B64}:`,
  "Dictionary-ID": `"${SYNC_DICTIONARY_ID}"`,
};

function sync(app: ServerApp, token: string, headers: Record<string, string>, cursor = 0, outbox: Op[] = []): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: encodeSyncRequest({ v: PROTOCOL_VERSION, cursor, outbox }),
    }),
  );
}

function cid(n: number): Uint8Array {
  return Uint8Array.from([9, 9, 9, 9, 9, 9, Math.floor(n / 256) % 256, n % 256]);
}

/** Alice owns an open group and is at the cursor that delivered its creation. */
async function aliceWithGroup(app: ServerApp): Promise<{ token: string; cursor: number; group: number }> {
  const token = await signUpAlice(app);
  // Group creation needs an account older than 24h (ADR 0012).
  app.db
    .query("UPDATE user SET createdAt = ? WHERE username = 'alice'")
    .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());

  const created = await sync(app, token, { "Accept-Encoding": "br" }, 0, [
    { cid: cid(1), scope: 0, tag: Tag.GroupMeta, name: "La Habana", about: "Grupo abierto", open: true },
  ]);
  const createdBody = await decode(created);
  const ack = createdBody.acks[0];
  if (ack === undefined || !("seq" in ack)) throw new Error("group create was not acked");
  return { token, cursor: createdBody.cursor, group: ack.seq };
}

/** 100 posts in one outbox: the response is big enough that dcz wins on the wire. */
function postBatch(group: number): Op[] {
  return Array.from({ length: 100 }, (_, i) => ({
    cid: cid(100 + i),
    scope: group,
    tag: Tag.Post,
    text: sampleText(2000 + i),
    media: null,
  }));
}

function dczPayload(body: Uint8Array): Uint8Array {
  return body.subarray(DCZ_HEADER_BYTES);
}

async function decode(res: Response): Promise<SyncResponse> {
  const body = new Uint8Array(await res.arrayBuffer());
  const encoding = res.headers.get("content-encoding");
  if (encoding === "br") return decodeSyncResponse(new Uint8Array(brotliDecompressSync(body)));
  if (encoding === "dcz") return decodeSyncResponse(new Uint8Array(zstdDecompressSync(dczPayload(body), { dictionary: SYNC_DICTIONARY })));
  return decodeSyncResponse(body);
}

describe("shared dictionary transport (issue #21)", () => {
  describe("GET /sync-dict/<id>", () => {
    test("serves the dictionary with Use-As-Dictionary, freshness and a hash clients can send", async () => {
      const app = await testApp();
      try {
        const res = await app.fetch(new Request(`${ORIGIN}${SYNC_DICTIONARY_PATH}`, { headers: { "Accept-Encoding": "br" } }));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/octet-stream");
        expect(res.headers.get("use-as-dictionary")).toBe(`match="/sync", id="${SYNC_DICTIONARY_ID}"`);
        expect(res.headers.get("cache-control")).toContain("max-age=31536000");
        expect(res.headers.get("cache-control")).toContain("immutable");
        expect(res.headers.get("vary")).toBe("Accept-Encoding");
        expect(res.headers.get("content-encoding")).toBe("br");

        const compressed = new Uint8Array(await res.arrayBuffer());
        expect(res.headers.get("content-length")).toBe(String(compressed.byteLength));
        const dictionary = new Uint8Array(brotliDecompressSync(compressed));
        expect(dictionary).toEqual(SYNC_DICTIONARY);

        // The value in Available-Dictionary is the SHA-256 of these decoded bytes.
        const hash = createHash("sha256").update(dictionary).digest("base64");
        expect(hash).toBe(SYNC_DICTIONARY_HASH_B64);
      } finally {
        app.close();
      }
    });

    test("serves the raw dictionary when the client does not accept brotli", async () => {
      const app = await testApp();
      try {
        const res = await app.fetch(new Request(`${ORIGIN}${SYNC_DICTIONARY_PATH}`));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(res.headers.get("content-length")).toBe(String(SYNC_DICTIONARY.byteLength));
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(SYNC_DICTIONARY);
      } finally {
        app.close();
      }
    });

    test("HEAD answers the same headers with no body", async () => {
      const app = await testApp();
      try {
        const res = await app.fetch(
          new Request(`${ORIGIN}${SYNC_DICTIONARY_PATH}`, { method: "HEAD", headers: { "Accept-Encoding": "br" } }),
        );
        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
        expect(res.headers.get("content-length")).toBe(String(brotliCompressSync(SYNC_DICTIONARY).byteLength));
      } finally {
        app.close();
      }
    });

    test("only GET and HEAD are allowed", async () => {
      const app = await testApp();
      try {
        const res = await app.fetch(new Request(`${ORIGIN}${SYNC_DICTIONARY_PATH}`, { method: "POST" }));
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
      } finally {
        app.close();
      }
    });

    test("the shell points the browser at the dictionary, and only the document does", async () => {
      const app = await testApp();
      try {
        const document = await app.fetch(new Request(`${ORIGIN}/`));
        expect(document.headers.get("link")).toBe(`<${SYNC_DICTIONARY_PATH}>; rel="compression-dictionary"`);
        const script = await app.fetch(new Request(`${ORIGIN}/app.js`));
        expect(script.headers.get("link")).toBeNull();
      } finally {
        app.close();
      }
    });
  });

  describe("POST /sync negotiation", () => {
    /** Alice posts 100 varied posts; `before` is the cursor that will read them back. */
    async function catchUp(app: ServerApp): Promise<{ token: string; before: number }> {
      const { token, cursor, group } = await aliceWithGroup(app);
      const applied = await sync(app, token, { "Accept-Encoding": "br" }, cursor, postBatch(group));
      const body = await decode(applied);
      expect(body.events.filter((event) => event.tag === Tag.Post)).toHaveLength(100);
      return { token, before: cursor };
    }

    test("uses dcz with the RFC 9842 40-byte header when the client has this dictionary", async () => {
      const app = await testApp();
      try {
        const { token, before } = await catchUp(app);
        const res = await sync(
          app,
          token,
          { "Accept-Encoding": "gzip, br, dcz", Origin: "http://client.example", ...DICTIONARY_HEADERS },
          before,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/cbor");
        expect(res.headers.get("content-encoding")).toBe("dcz");
        // RFC 9842 §9.3.2: a cross-origin dictionary-compressed response must be readable.
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("vary")).toBe(DICTIONARY_VARY);

        const body = new Uint8Array(await res.clone().arrayBuffer());
        expect(res.headers.get("content-length")).toBe(String(body.byteLength));
        expect(body.byteLength).toBeGreaterThan(DCZ_HEADER_BYTES);
        expect([...body.subarray(0, DCZ_MAGIC.byteLength)]).toEqual([...DCZ_MAGIC]);
        expect(Buffer.from(body.subarray(DCZ_MAGIC.byteLength, DCZ_HEADER_BYTES)).toString("base64")).toBe(
          SYNC_DICTIONARY_HASH_B64,
        );

        // The zstd stream genuinely needs the dictionary: without it, decoding fails.
        expect(() => zstdDecompressSync(dczPayload(body))).toThrow();

        const plain = await decode(res);
        // The same 100 posts at the same cursor, brotli only: decoding dcz must not change
        // a single event or the cursor.
        const brotliOnly = await sync(app, token, { "Accept-Encoding": "br" }, before);
        expect(brotliOnly.headers.get("content-encoding")).toBe("br");
        const brotliPlain = await decode(brotliOnly);
        expect(plain.cursor).toBe(brotliPlain.cursor);
        expect(plain.events).toEqual(brotliPlain.events);
        expect(plain.events.length).toBeGreaterThanOrEqual(100);
      } finally {
        app.close();
      }
    });

    test("keeps brotli for clients without dcz support", async () => {
      const app = await testApp();
      try {
        const { token, before } = await catchUp(app);
        for (const headers of [
          {},
          { "Accept-Encoding": "gzip, deflate, br" },
          { "Accept-Encoding": "br, dcz;q=0" },
        ]) {
          const res = await sync(app, token, headers, before);
          expect(res.headers.get("content-encoding")).toBe("br");
          expect(res.headers.get("vary")).toBeNull();
          expect((await decode(res)).events.length).toBeGreaterThanOrEqual(100);
        }
      } finally {
        app.close();
      }
    });

    test("keeps brotli when the offered hash or id is not this dictionary", async () => {
      const app = await testApp();
      try {
        const { token, before } = await catchUp(app);
        const cases: Array<Record<string, string>> = [
          { "Accept-Encoding": "br, dcz" },
          { "Accept-Encoding": "br, dcz", "Available-Dictionary": `:${Buffer.alloc(32).toString("base64")}:` },
          { "Accept-Encoding": "br, dcz", "Available-Dictionary": "not-a-structured-field" },
          {
            "Accept-Encoding": "br, dcz",
            "Available-Dictionary": `:${SYNC_DICTIONARY_HASH_B64}:`,
            "Dictionary-ID": '"some-other-dictionary"',
          },
        ];
        for (const headers of cases) {
          const res = await sync(app, token, headers, before);
          expect(res.headers.get("content-encoding")).toBe("br");
        }
      } finally {
        app.close();
      }
    });

    test("accepts the right hash without Dictionary-ID (the hash is the authority)", async () => {
      const app = await testApp();
      try {
        const { token, before } = await catchUp(app);
        const res = await sync(
          app,
          token,
          { "Accept-Encoding": "br, dcz", "Available-Dictionary": `:${SYNC_DICTIONARY_HASH_B64}:` },
          before,
        );
        expect(res.headers.get("content-encoding")).toBe("dcz");
      } finally {
        app.close();
      }
    });

    test("never makes a small response bigger: dcz is skipped when the header and Vary cost more", async () => {
      const app = await testApp();
      try {
        const { token } = await aliceWithGroup(app);
        // Nothing after this cursor: the response is a few bytes, so the 40-byte dcz header
        // alone would make it bigger. Brotli wins, and negotiation falls back to it.
        const res = await sync(app, token, { "Accept-Encoding": "br, dcz", ...DICTIONARY_HEADERS }, 10_000_000);
        expect(res.headers.get("content-encoding")).toBe("br");
      } finally {
        app.close();
      }
    });
  });

  describe("measured saving", () => {
    test("the dictionary is content-pinned: new bytes need a new id and path", () => {
      // The response is immutable for a year and the id is in its URL. If the generator
      // changes, bump SYNC_DICTIONARY_ID (and therefore SYNC_DICTIONARY_PATH) and this hash
      // in the same commit; an old browser must never keep old bytes under a fresh URL.
      expect(SYNC_DICTIONARY_HASH_B64).toBe("K8LVlf784a4I4+fETxN6Nzk7Y3ZQ/D1reU1Ls3WEY/g=");
    });

    test("dcz is at least 10% smaller than brotli on the 100-posts fixture", () => {
      const fixture = encodeSyncResponse({
        range: SUPPORTED,
        cursor: 1,
        more: false,
        events: hundredPosts(),
        acks: [],
        skipped: 0,
      });
      const brotli = brotliCompressSync(fixture).byteLength;
      const dczBody = dczCompress(fixture).byteLength;
      // What the response actually costs: the body plus the headers that differ. Header names
      // are identical, and the Content-Length digits match at these sizes.
      const brWire = brotli + Buffer.byteLength("Content-Encoding: br\r\n");
      const dczWire = dczBody + Buffer.byteLength(`Content-Encoding: dcz\r\nVary: ${DICTIONARY_VARY}\r\n`);
      const dictionaryWireBytes = brotliCompressSync(SYNC_DICTIONARY).byteLength;
      console.log(
        `100 posts: ${fixture.byteLength} B raw, ${brotli} B brotli body, ${dczBody} B dcz body; ` +
          `with response headers ${brWire} B vs ${dczWire} B (${(100 * (1 - dczWire / brWire)).toFixed(1)}% saved, ` +
          `${(100 * (1 - dczBody / brotli)).toFixed(1)}% body only); dictionary ` +
          `${SYNC_DICTIONARY.byteLength} B raw, ${dictionaryWireBytes} B brotli, pays back after ` +
          `${Math.ceil(dictionaryWireBytes / (brWire - dczWire))} responses`,
      );
      expect(dczWire).toBeLessThan(brWire);
      expect(dczWire).toBeLessThanOrEqual(Math.floor(brWire * 0.9));
    });
  });
});
