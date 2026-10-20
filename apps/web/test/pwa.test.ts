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
import { buildSyncRequest, classifySyncResponse, postSyncRequest, syncAndPersist } from "../src/sync.ts";
import { closeStore, getCursor, getRange, getSession, getStoredCursor } from "../src/store.ts";

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
  app = await createApp({ dbPath, host: "127.0.0.1", baseURL: "http://127.0.0.1", secret: TEST_SECRET });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app!.fetch(req) });
  base = `http://127.0.0.1:${server.port}`;
}

function username(): string {
  return `alice${++account}`;
}
let account = 0;

/** Sign up, then finish the type-back so the account can sync (ADR 0006). */
async function signUpConfirmed(): Promise<{ session: NonNullable<Awaited<ReturnType<typeof getSession>>>; recoveryCode: string }> {
  const exchange = await auth.signUp(base, username(), "password1234");
  await auth.confirmRecovery(base, exchange.recoveryCode.slice(-5));
  const session = await getSession();
  if (!session) throw new Error("signup confirmed without a stored session");
  return { session, recoveryCode: exchange.recoveryCode };
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
    expect(await getSession()).toEqual(session);
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
    expect(await getSession()).toBeNull();
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
    expect(await getSession()).toBeNull();

    await expect(postSyncRequest(base, session.token, buildSyncRequest(0))).rejects.toThrow("status 401");
    const again = await auth.signIn(base, session.username, "password1234");
    expect(again.token).not.toBe(session.token);
    const outcome = await syncAndPersist(base, again.token);
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
      await expect(auth.signOut(`http://127.0.0.1:${refusing.port}`)).rejects.toThrow("failed with status 500");
      expect(await getSession()).toEqual(session);
    } finally {
      await refusing.stop(true);
    }
  });

  test("syncs an empty server: cursor 0 stored, cached range, no events", async () => {
    const { session } = await signUpConfirmed();
    const outcome = await syncAndPersist(base, session.token);

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.response.cursor).toBe(0);
    expect(outcome.response.events).toEqual([]);
    expect(outcome.response.more).toBe(false);
    expect(await getStoredCursor()).toBe(0);
    expect(await getCursor()).toBe(0);
    expect(await getRange()).toEqual({ min: PROTOCOL_VERSION, max: PROTOCOL_VERSION });
  });

  test("an out-of-range version answers with the upgrade error and moves no cursor", async () => {
    const { session } = await signUpConfirmed();
    expect(await getStoredCursor()).toBeNull();

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

    expect(await getStoredCursor()).toBeNull();
  });

  test("a server that moved on: the range is cached and the cursor is not advanced", async () => {
    const { session } = await signUpConfirmed();
    const first = await syncAndPersist(base, session.token);
    expect(first.kind).toBe("ok");
    expect(await getCursor()).toBe(0);

    // Stand-in for the next server build: it accepts v2..v2, so this client is too old.
    const moved = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          cborBody(encodeSyncResponse({ range: { min: 2, max: 2 }, cursor: 99, more: false, events: [], acks: [], skipped: 0, error: ResponseError.ClientTooNew })),
        ),
    });
    try {
      const outcome = await syncAndPersist(`http://127.0.0.1:${moved.port}`, session.token);
      expect(outcome).toEqual({ kind: "upgrade", error: ResponseError.ClientTooNew, range: { min: 2, max: 2 } });
    } finally {
      await moved.stop(true);
    }

    // The cached range is what lets the UI say "update available" before the server
    // stops answering, and the local cursor must not move on a rejected response.
    expect(await getRange()).toEqual({ min: 2, max: 2 });
    expect(await getCursor()).toBe(0);
  });

  test("an unauthenticated sync throws instead of writing a cursor", async () => {
    await expect(postSyncRequest(base, "nope".repeat(8), buildSyncRequest(0))).rejects.toThrow("status 401");
    expect(await getStoredCursor()).toBeNull();
  });

  test("a request without a token throws", async () => {
    await expect(postSyncRequest(base, "", buildSyncRequest(0))).rejects.toThrow();
  });

  test("recovery: confirm finishes signup, regenerate rotates, redeem signs back in", async () => {
    const account = username();
    const { session: pending, recoveryCode } = await auth.signUp(base, account, "password1234");
    expect(pending.recoveryPending).toBe(true);
    await expect(postSyncRequest(base, pending.token, buildSyncRequest(0))).rejects.toThrow("status 403");

    await auth.confirmRecovery(base, recoveryCode.slice(-5));
    expect((await getSession())?.recoveryPending).toBeUndefined();
    expect((await syncAndPersist(base, pending.token)).kind).toBe("ok");

    const next = await auth.regenerateRecovery(base);
    expect(next).not.toBe(recoveryCode);

    // A lost device comes back with the newest code only.
    await closeStore();
    globalThis.indexedDB = new IDBFactory();
    await expect(auth.redeemRecovery(base, account, recoveryCode)).rejects.toThrow(/invalid/);
    const redeemed = await auth.redeemRecovery(base, account, next);
    expect(redeemed.session.username).toBe(account);
    expect(await getSession()).toEqual(redeemed.session);
    expect((await syncAndPersist(base, redeemed.session.token)).kind).toBe("ok");
  });

  test("the empty sync round trip stays under 1 KB on the wire, bearer header included", async () => {
    const { session } = await signUpConfirmed();
    const counter = await startWireCounter();
    try {
      const outcome = await syncAndPersist(counter.base, session.token);
      expect(outcome.kind).toBe("ok");
      const wireBytes = counter.totals();
      console.log(`empty sync wire bytes (client->server->client, real socket): ${wireBytes} B`);
      expect(wireBytes).toBeLessThanOrEqual(1024);
    } finally {
      counter.stop();
    }
  });
});
