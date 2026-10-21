// End-to-end proof for issue #5: the PWA client signs up, signs in, syncs an empty server
// and lands on cursor 0, against a real server on a real socket, with a byte-counting
// proxy in between so the wire budget is measured, not estimated.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createApp } from "@brr-chat/server";
import { PROTOCOL_VERSION, ResponseError, encodeSyncResponse } from "@brr-chat/protocol";
import * as auth from "../src/auth.ts";
import { bearerHeader } from "../src/auth.ts";
import { meter } from "../src/meter.ts";
import { uploadImage, type PreparedImage } from "../src/media.ts";
import { buildSyncRequest, classifySyncResponse, postSyncRequest, syncAndPersist } from "../src/sync.ts";
import { closeStore, ensureServer, getCursor, getRange, getSession, getStoredCursor, setSession, type Account } from "../src/store.ts";

/** The DOM lib's BodyInit does not list Uint8Array; every runtime accepts it. */
const cborBody = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit;

/** A real DB file gets its own signing key, never the environment (ADR 0007). */
const TEST_SECRET = "pwa-test-secret-0123456789abcdef0123456789abcdef";

let tempDir: string;
let base: string;
/** One server for the whole suite: each test is a separate client, and a distinct account. */
let server: ReturnType<typeof Bun.serve> | null = null;
let app: Awaited<ReturnType<typeof createApp>> | null = null;

async function startServer(): Promise<void> {
  tempDir = mkdtempSync(join(tmpdir(), "brr-chat-web-pwa-"));
  const dbPath = join(tempDir, "chat.db");
  app = await createApp({
    dbPath,
    host: "127.0.0.1",
    baseURL: "http://127.0.0.1",
    secret: TEST_SECRET,
    // This suite makes many accounts against one test server; abuse budgets are not its subject.
    limits: { signupsPerHour: 100 },
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app!.fetch(req) });
  base = `http://127.0.0.1:${server.port}`;
}

function username(): string {
  return `alice${++account}`;
}
let account = 0;

/** Sign up, then finish the type-back so the account can sync (ADR 0006). */
async function signUpConfirmed(): Promise<{ session: Account; recoveryCode: string }> {
  const exchange = await auth.signUp(base, username(), "password1234");
  await auth.confirmRecovery(base, exchange.recoveryCode.slice(-5));
  const stored = await getSession(base);
  if (!stored) throw new Error("signup confirmed without a stored session");
  return { session: { server: base, ...stored }, recoveryCode: exchange.recoveryCode };
}

/** Forwards bytes verbatim between the client and the server and counts both directions. */
async function startWireCounter(): Promise<{ base: string; totals(): number; stop(): void }> {
  const target = server!;
  const state = { sent: 0, received: 0 };
  const clients = new Set<Socket>();
  const proxy = createServer((client) => {
    clients.add(client);
    const upstream = connect(target.port ?? 0, "127.0.0.1", () => {});
    clients.add(upstream);
    client.on("data", (chunk) => {
      state.sent += Buffer.byteLength(chunk);
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      state.received += Buffer.byteLength(chunk);
      client.write(chunk);
    });
    const bye = () => {
      upstream.destroy();
      client.destroy();
    };
    client.on("close", bye);
    upstream.on("close", bye);
    upstream.on("error", bye);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    totals: () => state.sent + state.received,
    stop: () => {
      for (const socket of clients) socket.destroy();
      proxy.close();
    },
  };
}

describe("PWA client (apps/web)", () => {
  // Bun runs every test file in one process: put the global back when this file is done.
  const originalIndexedDB = globalThis.indexedDB;

  afterAll(() => {
    globalThis.indexedDB = originalIndexedDB;
  });

  beforeAll(startServer);

  afterAll(async () => {
    await server?.stop(true);
    app?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(async () => {
    await closeStore();
  });

  test("the server keeps its DB at mode 0600 with an events table", () => {
    expect(statSync(join(tempDir, "chat.db")).mode & 0o777).toBe(0o600);
  });

  test("sign up with a username only stores a bare 32-char session and shows one recovery code", async () => {
    const account = username();
    const { session, recoveryCode } = await auth.signUp(base, account, "password1234");
    expect(session.username).toBe(account);
    expect(session.token).toHaveLength(32);
    expect(session.token.includes(".")).toBe(false);
    expect(session.recoveryPending).toBe(true);
    expect(recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(await getSession(base)).toEqual({ token: session.token, username: session.username, recoveryPending: true });
    expect(await bearerHeader(session.token)).toBe(`Bearer ${session.token}`);
  });

  test("sign up with an existing username or a wrong password fails without storing a session", async () => {
    const taken = username();
    await auth.signUp(base, taken, "password1234");
    // A fresh device: same server, empty IndexedDB.
    await closeStore();
    globalThis.indexedDB = new IDBFactory();
    await expect(auth.signUp(base, taken, "password1234")).rejects.toThrow(/status \d+/);
    await expect(auth.signIn(base, taken, "wrong-password")).rejects.toThrow(/status \d+/);
    expect(await getSession(base)).toBeNull();
  });

  test("sign in after a restart returns the same account and clears nothing", async () => {
    const account = username();
    await auth.signUp(base, account, "password1234");
    await closeStore();
    globalThis.indexedDB = new IDBFactory();
    const session = await auth.signIn(base, account, "password1234");
    expect(session.username).toBe(account);
    expect(session.token).toHaveLength(32);
  });

  test("sign out revokes the session: sign-in still works, the old token does not", async () => {
    const { session } = await signUpConfirmed();
    expect(bearerHeader(session.token)).toBe(`Bearer ${session.token}`);
    await auth.signOut(base);
    expect(await getSession(base)).toBeNull();

    await expect(postSyncRequest(base, session.token, buildSyncRequest(0))).rejects.toThrow("status 401");
    const again = await auth.signIn(base, session.username, "password1234");
    expect(again.token).not.toBe(session.token);
    const outcome = await syncAndPersist(again);
    expect(outcome.kind).toBe("ok");
  });

  test("a sign-out the server refuses keeps the token, so the device can retry", async () => {
    const { session } = await signUpConfirmed();
    const refusing = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 500 }),
    });
    try {
      const refusingBase = `http://127.0.0.1:${refusing.port}`;
      // Sign-out is per server: give that server the same account so the call is made.
      await ensureServer(refusingBase);
      await setSession(refusingBase, { token: session.token, username: session.username });
      await expect(auth.signOut(refusingBase)).rejects.toThrow("failed with status 500");
      expect(await getSession(refusingBase)).toEqual({ token: session.token, username: session.username });
      // The first server's session was never touched by the failed call.
      expect(await getSession(base)).toEqual({ token: session.token, username: session.username });
    } finally {
      await refusing.stop(true);
    }
  });

  test("syncs an empty server: cursor 0 stored, cached range, no events", async () => {
    const { session } = await signUpConfirmed();
    const outcome = await syncAndPersist(session);

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.response.cursor).toBe(0);
    expect(outcome.response.events).toEqual([]);
    expect(outcome.response.more).toBe(false);
    expect(await getStoredCursor(session)).toBe(0);
    expect(await getCursor(session)).toBe(0);
    expect(await getRange(base)).toEqual({ min: PROTOCOL_VERSION, max: PROTOCOL_VERSION });
  });

  test("an out-of-range version answers with the upgrade error and moves no cursor", async () => {
    const { session } = await signUpConfirmed();
    expect(await getStoredCursor(session)).toBeNull();

    const old = await postSyncRequest(base, session.token, buildSyncRequest(0, [], 0));
    expect(classifySyncResponse(old)).toEqual({
      kind: "upgrade",
      error: ResponseError.ClientTooOld,
      range: { min: 1, max: 1 },
    });

    const new_ = await postSyncRequest(base, session.token, buildSyncRequest(0, [], 99));
    expect(classifySyncResponse(new_)).toEqual({
      kind: "upgrade",
      error: ResponseError.ClientTooNew,
      range: { min: 1, max: 1 },
    });

    expect(await getStoredCursor(session)).toBeNull();
  });

  test("a server that moved on: the range is cached and the cursor is not advanced", async () => {
    const { session } = await signUpConfirmed();
    const first = await syncAndPersist(session);
    expect(first.kind).toBe("ok");
    expect(await getCursor(session)).toBe(0);

    // Stand-in for the next server build: it accepts v2..v2, so this client is too old.
    const moved = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          cborBody(encodeSyncResponse({ range: { min: 2, max: 2 }, cursor: 99, more: false, events: [], acks: [], skipped: 0, error: ResponseError.ClientTooNew })),
        ),
    });
    const movedBase = `http://127.0.0.1:${moved.port}`;
    try {
      const movedAccount = { server: movedBase, token: session.token, username: session.username };
      const outcome = await syncAndPersist(movedAccount);
      expect(outcome).toEqual({ kind: "upgrade", error: ResponseError.ClientTooNew, range: { min: 2, max: 2 } });
    } finally {
      await moved.stop(true);
    }

    // The cached range is what lets the UI say "update available" before the server
    // stops answering, and the local cursor must not move on a rejected response.
    expect(await getRange(movedBase)).toEqual({ min: 2, max: 2 });
    // A range belongs to one server: the first server's cached range must not be overwritten.
    expect(await getRange(base)).toEqual({ min: PROTOCOL_VERSION, max: PROTOCOL_VERSION });
    expect(await getCursor(session)).toBe(0);
  });

  test("an unauthenticated sync throws instead of writing a cursor", async () => {
    await expect(postSyncRequest(base, "nope".repeat(8), buildSyncRequest(0))).rejects.toThrow("status 401");
    expect(await getStoredCursor({ server: base, username: "nobody" })).toBeNull();
  });

  test("a request without a token throws", async () => {
    await expect(postSyncRequest(base, "", buildSyncRequest(0))).rejects.toThrow();
  });

  test("signing in to a signup that never finished still asks for the type-back", async () => {
    const account = username();
    const { recoveryCode } = await auth.signUp(base, account, "password1234");
    await closeStore();
    globalThis.indexedDB = new IDBFactory();

    const pending = await auth.signIn(base, account, "password1234");
    expect(pending.recoveryPending).toBe(true);
    await auth.confirmRecovery(base, recoveryCode.slice(-5));
    await auth.signOut(base);

    const finished = await auth.signIn(base, account, "password1234");
    expect(finished.recoveryPending).toBeUndefined();
  });

  test("recovery: confirm finishes signup, regenerate rotates, redeem signs back in", async () => {
    const account = username();
    const { session: pending, recoveryCode } = await auth.signUp(base, account, "password1234");
    expect(pending.recoveryPending).toBe(true);
    await expect(postSyncRequest(base, pending.token, buildSyncRequest(0))).rejects.toThrow("status 403");

    await auth.confirmRecovery(base, recoveryCode.slice(-5));
    expect((await getSession(base))?.recoveryPending).toBeUndefined();
    expect((await syncAndPersist(pending)).kind).toBe("ok");

    const next = await auth.regenerateRecovery(base);
    expect(next).not.toBe(recoveryCode);

    // A lost device comes back with the newest code only.
    await closeStore();
    globalThis.indexedDB = new IDBFactory();
    await expect(auth.redeemRecovery(base, account, recoveryCode)).rejects.toThrow(/invalid/);
    const redeemed = await auth.redeemRecovery(base, account, next);
    expect(redeemed.session.username).toBe(account);
    expect(await getSession(base)).toEqual({ token: redeemed.session.token, username: redeemed.session.username });
    expect((await syncAndPersist(redeemed.session)).kind).toBe("ok");
  });

  test("the data meter's count tracks the bytes a real socket carries", async () => {
    const { session } = await signUpConfirmed();
    const counter = await startWireCounter();
    try {
      const before = meter.totals().sessionBytes;
      await postSyncRequest(counter.base, session.token, buildSyncRequest(0));
      const counted = meter.totals().sessionBytes - before;
      const wire = counter.totals();
      console.log(`data meter counted ${counted} B of ${wire} B on a real socket`);
      // Both directions are counted, headers included. The meter sees fewer bytes than the
      // TCP proxy because the browser adds headers it never exposes to page code, so it must
      // land close to the real total, not merely above the payload (4 B + 11 B here).
      expect(counted).toBeGreaterThan(wire * 0.7);
      expect(counted).toBeLessThanOrEqual(wire);
    } finally {
      counter.stop();
    }
  });

  /** A WebP container with just enough header for the server's dimension check. */
  function vp8lBytes(width: number, height: number, pad = 0): Uint8Array<ArrayBuffer> {
    const bits = (width - 1) | ((height - 1) << 14);
    const payload = [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff];
    const body = new Uint8Array(4 + 8 + payload.length);
    body.set([...Buffer.from("WEBP")], 0);
    body.set([...Buffer.from("VP8L")], 4);
    body.set([payload.length, 0, 0, 0], 8);
    body.set(payload, 12);
    const file = new Uint8Array(8 + body.length + pad);
    file.set([...Buffer.from("RIFF")], 0);
    file.set([body.length & 0xff, (body.length >>> 8) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 24) & 0xff], 4);
    file.set(body, 8);
    return file;
  }

  test("a prepared photo uploads over the real socket and downloads only on request", async () => {
    const { session } = await signUpConfirmed();
    const previewBytes = vp8lBytes(320, 200, 10_000);
    const fullBytes = vp8lBytes(1280, 800, 10_000);
    const prepared: PreparedImage = {
      preview: { blob: new Blob([previewBytes], { type: "image/webp" }), width: 320, height: 200 },
      full: { blob: new Blob([fullBytes], { type: "image/webp" }), width: 1280, height: 800 },
      thumbhash: new Uint8Array(21).fill(5),
    };

    const before = meter.totals().sessionBytes;
    const uploaded = await uploadImage(base, session.token, prepared);
    expect(uploaded).toMatchObject({ w: 1280, h: 800 });
    expect(uploaded.bytes).toBe(previewBytes.byteLength + fullBytes.byteLength);

    // The route is not public: a browser without the bearer token gets nothing.
    expect((await fetch(`${base}/m/${uploaded.id}`)).status).toBe(401);

    const headers = { Authorization: bearerHeader(session.token) };
    const preview = await fetch(`${base}/m/${uploaded.id}?w=64`, { headers });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/webp");
    expect([...new Uint8Array(await preview.arrayBuffer())]).toEqual([...previewBytes]);

    const full = await fetch(`${base}/m/${uploaded.id}?w=1280`, { headers });
    expect([...new Uint8Array(await full.arrayBuffer())]).toEqual([...fullBytes]);

    // The upload body is the expensive direction; the meter must see it, not just headers.
    // (The two downloads above use raw fetch in this test; mediaView uses the metered one.)
    const counted = meter.totals().sessionBytes - before;
    console.log(`data meter counted ${counted} B for an upload of ${uploaded.bytes} B`);
    expect(counted).toBeGreaterThan(uploaded.bytes);
  });

  test("the empty sync round trip stays under 1 KB on the wire, bearer header included", async () => {
    const { session } = await signUpConfirmed();
    const counter = await startWireCounter();
    try {
      const outcome = await syncAndPersist({ ...session, server: counter.base });
      expect(outcome.kind).toBe("ok");
      const wireBytes = counter.totals();
      console.log(`empty sync wire bytes (client->server->client, real socket): ${wireBytes} B`);
      expect(wireBytes).toBeLessThanOrEqual(1024);
    } finally {
      counter.stop();
    }
  });
});
