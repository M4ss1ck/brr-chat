import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import {
  AckError,
  PROTOCOL_VERSION,
  ResponseError,
  SUPPORTED,
  decodeSyncResponse,
  encodeSyncRequest,
} from "@brr-chat/protocol";
import { createApp, type ServerApp } from "../src/index.ts";

async function signUpAlice(app: ServerApp): Promise<string> {
  const res = await app.fetch(
    new Request("http://chat.local/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://chat.local",
      },
      body: JSON.stringify({ username: "alice", password: "password1234" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  expect(body.token).toHaveLength(32);
  return body.token;
}

describe("Slice 2: POST /sync", () => {
  describe("authentication required", () => {
    test("POST /sync without Authorization header returns 401", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const reqBytes = encodeSyncRequest({ v: PROTOCOL_VERSION, cursor: 0, outbox: [] });
        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: { "Content-Type": "application/cbor" },
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(401);
      } finally {
        app.close();
      }
    });

    test("POST /sync with an invalid bearer token returns 401", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const reqBytes = encodeSyncRequest({ v: PROTOCOL_VERSION, cursor: 0, outbox: [] });
        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: "Bearer invalidtoken01234567890123456789",
            },
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(401);
      } finally {
        app.close();
      }
    });

    test("POST /sync with a bare 32-char token after /api/auth/sign-out returns 401", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const token = await signUpAlice(app);

        const signOutRes = await app.fetch(
          new Request("http://chat.local/api/auth/sign-out", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Origin: "http://chat.local",
            },
          }),
        );
        expect(signOutRes.status).toBe(200);

        const reqBytes = encodeSyncRequest({ v: PROTOCOL_VERSION, cursor: 0, outbox: [] });
        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: `Bearer ${token}`,
            },
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(401);
      } finally {
        app.close();
      }
    });

    test("POST /sync for a banned user returns 401", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const token = await signUpAlice(app);
        app.db.query("UPDATE user SET banned = 1 WHERE username = 'alice'").run();

        const reqBytes = encodeSyncRequest({ v: PROTOCOL_VERSION, cursor: 0, outbox: [] });
        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: `Bearer ${token}`,
            },
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(401);
      } finally {
        app.close();
      }
    });
  });

  describe("version handshake (readVersion before full decode, ADR 0004)", () => {
    test("POST /sync with v = 0 returns 200 with ClientTooOld (1)", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const token = await signUpAlice(app);
        const reqBytes = encodeSyncRequest({ v: 0, cursor: 0, outbox: [] });
        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: `Bearer ${token}`,
            },
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/cbor");
        expect(res.headers.get("content-encoding")).toBe("br");

        const rawBody = new Uint8Array(await res.arrayBuffer());
        const decompressed = new Uint8Array(brotliDecompressSync(rawBody));
        const decoded = decodeSyncResponse(decompressed);
        expect(decoded).toEqual({
          range: SUPPORTED,
          cursor: 0,
          more: false,
          events: [],
          acks: [],
          skipped: 0,
          error: ResponseError.ClientTooOld,
        });
      } finally {
        app.close();
      }
    });

    test("POST /sync with v = 99 and unparseable future trailing shape returns 200 with ClientTooNew (2)", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const token = await signUpAlice(app);
        // Raw CBOR: [99, "not-a-uint-cursor", {"future": "map"}]
        // 0x83 = array(3), 0x18 0x63 = uint 99, 0x71 ... = text(17) "not-a-uint-cursor",
        // 0xa1 = map(1), 0x66 "future" : 0x63 "map"
        const reqBytes = Uint8Array.from([
          0x83,
          0x18, 0x63,
          0x71, ...Buffer.from("not-a-uint-cursor"),
          0xa1, 0x66, ...Buffer.from("future"), 0x63, ...Buffer.from("map"),
        ]);
        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: `Bearer ${token}`,
            },
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/cbor");
        expect(res.headers.get("content-encoding")).toBe("br");

        const rawBody = new Uint8Array(await res.arrayBuffer());
        const decompressed = new Uint8Array(brotliDecompressSync(rawBody));
        const decoded = decodeSyncResponse(decompressed);
        expect(decoded).toEqual({
          range: SUPPORTED,
          cursor: 0,
          more: false,
          events: [],
          acks: [],
          skipped: 0,
          error: ResponseError.ClientTooNew,
        });
      } finally {
        app.close();
      }
    });

    test("POST /sync with malformed CBOR or non-array request returns 400", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const token = await signUpAlice(app);

        // Malformed CBOR bytes
        const badRes = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: `Bearer ${token}`,
            },
            body: new Uint8Array([0xff, 0xff]),
          }),
        );
        expect(badRes.status).toBe(400);

        // In-range version (v = 1) with invalid cursor ("not-a-uint")
        const badInRangeBytes = Uint8Array.from([
          0x83,
          PROTOCOL_VERSION,
          0x6a, ...Buffer.from("not-a-uint"),
          0x80,
        ]);
        const badInRangeRes = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: `Bearer ${token}`,
            },
            body: badInRangeBytes,
          }),
        );
        expect(badInRangeRes.status).toBe(400);
      } finally {
        app.close();
      }
    });
  });

  describe("in-range empty sync response with brotli", () => {
    test("returns valid brotli-compressed SyncResponse for empty sync", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const token = await signUpAlice(app);
        const reqBytes = encodeSyncRequest({ v: PROTOCOL_VERSION, cursor: 0, outbox: [] });
        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: `Bearer ${token}`,
            },
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/cbor");
        expect(res.headers.get("content-encoding")).toBe("br");

        const rawBody = new Uint8Array(await res.arrayBuffer());
        const decompressed = new Uint8Array(brotliDecompressSync(rawBody));
        const decoded = decodeSyncResponse(decompressed);
        expect(decoded).toEqual({
          range: SUPPORTED,
          cursor: 0,
          more: false,
          events: [],
          acks: [],
          skipped: 0,
        });
        expect(decoded.error).toBeUndefined();
      } finally {
        app.close();
      }
    });

    test("returns AckError.Unsupported for rejected ops in outbox without failing the request", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const token = await signUpAlice(app);
        const cid = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        // Raw CBOR: [1, 0, [[cid(8B), 99, 0, "future-op"]]]
        // 0x83 = array(3), 0x01 = v(1), 0x00 = cursor(0), 0x81 = outbox array(1),
        // 0x84 = op array(4), 0x48 + 8 bytes cid, 0x18 0x63 = tag 99, 0x00 = scope 0, 0x69 + "future-op"
        const reqBytes = Uint8Array.from([
          0x83,
          PROTOCOL_VERSION,
          0x00,
          0x81,
          0x84,
          0x48, ...cid,
          0x18, 0x63,
          0x00,
          0x69, ...Buffer.from("future-op"),
        ]);
        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/cbor",
              Authorization: `Bearer ${token}`,
            },
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/cbor");
        expect(res.headers.get("content-encoding")).toBe("br");

        const rawBody = new Uint8Array(await res.arrayBuffer());
        const decompressed = new Uint8Array(brotliDecompressSync(rawBody));
        const decoded = decodeSyncResponse(decompressed);
        expect(decoded).toEqual({
          range: SUPPORTED,
          cursor: 0,
          more: false,
          events: [],
          acks: [{ cid, error: AckError.Unsupported }],
          skipped: 0,
        });
      } finally {
        app.close();
      }
    });
  });

  describe("byte budget including bearer header", () => {
    test("total wire bytes of empty /sync request + response <= 1024 B (1 KB)", async () => {
      const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
      try {
        const token = await signUpAlice(app);
        const reqBytes = encodeSyncRequest({ v: PROTOCOL_VERSION, cursor: 0, outbox: [] });

        const reqHeaders = new Headers({
          Host: "chat.local",
          "Content-Type": "application/cbor",
          "Accept-Encoding": "br",
          Authorization: `Bearer ${token}`,
          "Content-Length": String(reqBytes.byteLength),
        });

        const res = await app.fetch(
          new Request("http://chat.local/sync", {
            method: "POST",
            headers: reqHeaders,
            body: reqBytes,
          }),
        );
        expect(res.status).toBe(200);

        const resBody = new Uint8Array(await res.arrayBuffer());

        let reqHeaderLines = "POST /sync HTTP/1.1\r\n";
        reqHeaders.forEach((value, key) => {
          reqHeaderLines += `${key}: ${value}\r\n`;
        });
        reqHeaderLines += "\r\n";
        const reqWireBytes = Buffer.byteLength(reqHeaderLines) + reqBytes.byteLength;

        let resHeaderLines = `HTTP/1.1 ${res.status} ${res.statusText || "OK"}\r\n`;
        res.headers.forEach((value, key) => {
          resHeaderLines += `${key}: ${value}\r\n`;
        });
        resHeaderLines += "\r\n";
        const resWireBytes = Buffer.byteLength(resHeaderLines) + resBody.byteLength;

        const totalWireBytes = reqWireBytes + resWireBytes;
        console.log(
          `empty /sync wire budget: req ${reqWireBytes} B (body ${reqBytes.byteLength} B) + res ${resWireBytes} B (body ${resBody.byteLength} B) = ${totalWireBytes} B`,
        );

        expect(totalWireBytes).toBeLessThanOrEqual(1024);
      } finally {
        app.close();
      }
    });
  });
});
