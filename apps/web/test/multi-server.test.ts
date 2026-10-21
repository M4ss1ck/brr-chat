// Issue #18, end to end: one client holding two servers that sync independently. The same
// username exists on both, on purpose: a cursor, an outbox and a cached group are per server,
// so nothing may leak between two logs that happen to use the same small ids.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { Tag } from "@brr-chat/protocol";
import { createApp, type ServerApp } from "@brr-chat/server";
import qrcode from "qrcode-generator";
import * as auth from "../src/auth.ts";
import { meter } from "../src/meter.ts";
import { decodeQr } from "../src/qr.ts";
import { parseServerLink, serverLabel } from "../src/servers.ts";
import {
  closeStore,
  enqueueOp,
  ensureServer,
  getActiveAccount,
  getCursor,
  getOutbox,
  getPendingInvite,
  getProfiles,
  getStoredCursor,
  listServers,
  setActiveServer,
  setPendingInvite,
  toWireOp,
  type Account,
} from "../src/store.ts";
import { syncAndPersist } from "../src/sync.ts";

interface Running {
  app: ServerApp;
  base: string;
  stop(): Promise<void>;
}

async function startServer(): Promise<Running> {
  // The invite links a server hands out are built from its baseURL, so the app needs the
  // port before it exists. Bind first, then create the app with the URL it is reachable at.
  let ready!: (app: ServerApp) => void;
  const pending = new Promise<ServerApp>((resolve) => {
    ready = resolve;
  });
  let app: ServerApp | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => (app ?? (await pending)).fetch(req),
  });
  const base = `http://127.0.0.1:${server.port}`;
  app = await createApp({
    dbPath: ":memory:",
    host: "127.0.0.1",
    baseURL: base,
    limits: { signupsPerHour: 100 },
  });
  ready(app);
  const started = app;
  return {
    app: started,
    base,
    async stop() {
      await server.stop(true);
      started.close();
    },
  };
}

const inviteLinks = new WeakMap<Running, Promise<string>>();

/** Set up once per server: a second call would need a second admin and a second link. */
function inviteOnlyServer(running: Running): Promise<string> {
  let pending = inviteLinks.get(running);
  if (pending === undefined) {
    pending = makeInviteOnly(running);
    inviteLinks.set(running, pending);
  }
  return pending;
}

/** A friend's server in invite mode, with one admin and its live signup link. */
async function makeInviteOnly(running: Running): Promise<string> {
  const signup = await running.app.fetch(
    new Request(`${running.base}/api/recovery/sign-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://client.example" },
      body: JSON.stringify({ username: "admin", password: "password1234" }),
    }),
  );
  expect(signup.status).toBe(200);
  const created = (await signup.json()) as { token: string; recoveryCode: string };
  const confirm = await running.app.fetch(
    new Request(`${running.base}/api/recovery/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ group: created.recoveryCode.slice(-5) }),
    }),
  );
  expect(confirm.status).toBe(200);

  // Switching to invite mode issues the link in the same call (ADR 0012, ADR 0017).
  const settings = await running.app.fetch(
    new Request(`${running.base}/api/server/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ mode: "invite" }),
    }),
  );
  expect(settings.status).toBe(200);
  const body = (await settings.json()) as { invite: { link: string } | null };
  if (body.invite === null) throw new Error("invite mode issued no link");
  return body.invite.link;
}

/** Paints a QR matrix into RGBA, the same way the shell reads a screenshot or camera frame. */
function rasterize(link: string, scale = 4, margin = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const code = qrcode(0, "M");
  code.addData(link);
  code.make();
  const modules = code.getModuleCount();
  const size = (modules + margin * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!code.isDark(row, column)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const at = (((margin + row) * scale + y) * size + (margin + column) * scale + x) * 4;
          data[at] = 0;
          data[at + 1] = 0;
          data[at + 2] = 0;
          data[at + 3] = 255;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

async function confirmedAccount(base: string, username: string, invite?: string): Promise<Account> {
  const { session, recoveryCode } = await auth.signUp(base, username, "password1234", invite);
  await auth.confirmRecovery(base, recoveryCode.slice(-5));
  return { server: session.server, token: session.token, username: session.username };
}

describe("one client, two servers", () => {
  const originalIndexedDB = globalThis.indexedDB;
  let first: Running;
  let second: Running;
  /** A third server, only for the invite-mode add flows: its first account is its admin. */
  let invitee: Running;

  beforeAll(async () => {
    first = await startServer();
    second = await startServer();
    invitee = await startServer();
  });

  afterAll(async () => {
    await first?.stop();
    await second?.stop();
    await invitee?.stop();
    globalThis.indexedDB = originalIndexedDB;
  });

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(async () => {
    await closeStore();
  });

  test("the same username on two servers has one cursor, one outbox and one cache each", async () => {
    const a = await confirmedAccount(first.base, "alice");
    const b = await confirmedAccount(second.base, "alice");

    await setActiveServer(first.base);
    await syncAndPersist(a);
    await setActiveServer(second.base);
    await syncAndPersist(b);
    expect(await getCursor(a)).toBe(0);
    expect(await getCursor(b)).toBe(0);
    expect((await getActiveAccount())?.server).toBe(second.base);

    // One profile update on the first server must move only that server's cursor.
    const op = await enqueueOp(a, {
      tag: Tag.Profile,
      scope: 0,
      username: "alice",
      displayName: "Alice on A",
      bio: "",
    });
    const pushed = await syncAndPersist(a, [toWireOp(op)]);
    expect(pushed.kind).toBe("ok");
    expect(await getCursor(a)).toBe(1);
    expect(await getStoredCursor(b)).toBe(0);

    const onA = [...(await getProfiles(a)).values()].find((profile) => profile.username === "alice");
    expect(onA?.displayName).toBe("Alice on A");
    // The second server never received that event, so its cache stays empty.
    expect(await getProfiles(b)).toEqual(new Map());

    // And the queue is per account: nothing queued on A can drain through B.
    await enqueueOp(a, { tag: Tag.Post, scope: 10, text: "still queued" });
    expect(await getOutbox(b)).toEqual([]);
    expect(await getCursor(b)).toBe(0);
  });

  test("adding a server by its invite link creates that account on that server", async () => {
    const link = await inviteOnlyServer(invitee);
    const parsed = parseServerLink(link);
    expect(parsed).not.toBeNull();
    if (parsed === null || parsed.invite === null) throw new Error("invite link did not parse");

    await ensureServer(parsed.server);
    await setPendingInvite(parsed.server, parsed.invite);
    await setActiveServer(parsed.server);
    expect(await getPendingInvite(parsed.server)).toEqual(parsed.invite);

    const account = await confirmedAccount(parsed.server, "bob", parsed.invite.token);
    expect(account.server).toBe(parsed.server);
    const pushed = await syncAndPersist(account);
    expect(pushed.kind).toBe("ok");

    const listed = await listServers();
    expect(listed.map((row) => row.id)).toContain(parsed.server);
    expect(listed.find((row) => row.id === parsed.server)?.session?.username).toBe("bob");
    expect(serverLabel(parsed.server)).toContain("127.0.0.1");
  });

  test("adding a server by scanning its QR code takes the same path", async () => {
    const link = await inviteOnlyServer(invitee);
    const pixels = rasterize(link);
    const decoded = decodeQr(pixels.data, pixels.width, pixels.height);
    expect(decoded).toBe(link);

    const parsed = parseServerLink(decoded ?? "");
    if (parsed === null || parsed.invite === null) throw new Error("QR did not yield a server invite");
    await ensureServer(parsed.server);
    await setPendingInvite(parsed.server, parsed.invite);
    expect((await listServers()).map((row) => row.id)).toContain(parsed.server);
    expect((await getPendingInvite(parsed.server))?.kind).toBe("signup");
  });

  test("the data meter attributes the bytes of both servers, and its totals are the sum", async () => {
    const a = await confirmedAccount(first.base, "dave");
    const b = await confirmedAccount(second.base, "dave");
    await meter.load();
    await syncAndPersist(a);
    await syncAndPersist(b);
    await meter.flush();

    const rows = meter.servers();
    const meterA = rows.find((row) => row.server === first.base);
    const meterB = rows.find((row) => row.server === second.base);
    expect(meterA?.monthBytes).toBeGreaterThan(0);
    expect(meterB?.monthBytes).toBeGreaterThan(0);
    // Every bucket (including the invite-only server used above) adds up to the headline.
    const sum = rows.reduce((total, row) => total + row.monthBytes, 0);
    expect(meter.totals().monthBytes).toBe(sum);
  });
});
