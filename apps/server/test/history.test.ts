// Slice 8: history and gaps. A long-offline device catches up through /sync without paying
// for every missed post, sees a gap marker, and fills it only when the user taps "load older"
// through /history (ADR 0009).
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import {
  POSTS_BUDGET,
  PROTOCOL_VERSION,
  Role,
  Tag,
  decodeHistoryResponse,
  decodeSyncResponse,
  encodeHistoryRequest,
  encodeSyncRequest,
  type Event,
  type HistoryResponse,
  type Op,
  type SyncResponse,
} from "@brr-chat/protocol";
import { createApp, headCursor, type ServerApp } from "../src/index.ts";

interface Account {
  token: string;
  username: string;
}

interface Client {
  account: Account;
  wire: number;
  cursor: number;
}

let nextCid = 0;

function cid(): Uint8Array {
  nextCid += 1;
  return Uint8Array.from([4, 2, 4, 2, 4, 2, Math.floor(nextCid / 256) % 256, nextCid % 256]);
}

function profileOp(c: Uint8Array, username: string): Op {
  return { cid: c, tag: Tag.Profile, scope: 0, username, displayName: username, bio: "" };
}

function groupOp(c: Uint8Array, name: string, open = true): Op {
  return { cid: c, tag: Tag.GroupMeta, scope: 0, name, about: "", open };
}

function postOp(c: Uint8Array, scope: number, text: string): Op {
  return { cid: c, tag: Tag.Post, scope, text, media: null };
}

function joinOp(c: Uint8Array, scope: number, user: number): Op {
  return { cid: c, tag: Tag.Membership, scope, user, role: Role.Member };
}

async function signUp(app: ServerApp, username: string): Promise<Account> {
  const res = await app.fetch(
    new Request("http://chat.local/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
      body: JSON.stringify({ username, password: "password1234" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; recoveryCode: string };
  const confirm = await app.fetch(
    new Request("http://chat.local/api/recovery/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ group: body.recoveryCode.slice(-5) }),
    }),
  );
  expect(confirm.status).toBe(200);
  return { token: body.token, username };
}

function setAge(app: ServerApp, username: string, hours: number): void {
  app.db
    .query("UPDATE user SET createdAt = ? WHERE username = ?")
    .run(new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(), username);
}

async function rawSync(app: ServerApp, token: string, cursor: number, outbox: Op[] = []): Promise<Uint8Array> {
  const res = await app.fetch(
    new Request("http://chat.local/sync", {
      method: "POST",
      headers: { "Content-Type": "application/cbor", Authorization: `Bearer ${token}` },
      body: encodeSyncRequest({ v: PROTOCOL_VERSION, cursor, outbox }),
    }),
  );
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

function decodeSyncBytes(bytes: Uint8Array): SyncResponse {
  return decodeSyncResponse(new Uint8Array(brotliDecompressSync(bytes)));
}

async function sync(app: ServerApp, token: string, cursor: number, outbox: Op[] = []): Promise<SyncResponse> {
  return decodeSyncBytes(await rawSync(app, token, cursor, outbox));
}

async function rawHistory(
  app: ServerApp,
  token: string,
  scope: number,
  before: number,
  limit: number,
): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await app.fetch(
    new Request("http://chat.local/history", {
      method: "POST",
      headers: { "Content-Type": "application/cbor", Authorization: `Bearer ${token}` },
      body: encodeHistoryRequest({ v: PROTOCOL_VERSION, scope, before, limit }),
    }),
  );
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function history(
  app: ServerApp,
  token: string,
  scope: number,
  before: number,
  limit = 100,
): Promise<HistoryResponse> {
  const { status, bytes } = await rawHistory(app, token, scope, before, limit);
  expect(status).toBe(200);
  return decodeHistoryResponse(new Uint8Array(brotliDecompressSync(bytes)));
}

function ack(response: SyncResponse, c: Uint8Array): { seq: number } | { error: number } {
  const row = response.acks.find((candidate) => candidate.cid.every((byte, i) => byte === c[i]));
  expect(row).toBeDefined();
  if (!row) throw new Error("no ack");
  return "seq" in row ? { seq: row.seq } : { error: row.error };
}

function seqOf(response: SyncResponse, c: Uint8Array): number {
  const result = ack(response, c);
  if (!("seq" in result)) throw new Error(`expected a seq, got error ${result.error}`);
  return result.seq;
}

function postEvents(events: Event[]): Extract<Event, { tag: typeof Tag.Post }>[] {
  return events.filter((event): event is Extract<Event, { tag: typeof Tag.Post }> => event.tag === Tag.Post);
}

function gapEvents(events: Event[]): Extract<Event, { tag: typeof Tag.Gap }>[] {
  return events.filter((event): event is Extract<Event, { tag: typeof Tag.Gap }> => event.tag === Tag.Gap);
}

/** Publishes a profile, then reads the wire id the server assigned to this account. */
async function identify(app: ServerApp, account: Account): Promise<{ wire: number; cursor: number }> {
  const response = await sync(app, account.token, 0, [profileOp(cid(), account.username)]);
  const profile = response.events.find(
    (event) => event.tag === Tag.Profile && "username" in event && event.username === account.username,
  );
  expect(profile).toBeDefined();
  if (!profile) throw new Error("profile event missing from the state snapshot");
  return { wire: profile.author, cursor: response.cursor };
}

async function client(app: ServerApp, username: string, ageHours = 25): Promise<Client> {
  const account = await signUp(app, username);
  setAge(app, username, ageHours);
  const identity = await identify(app, account);
  return { account, wire: identity.wire, cursor: identity.cursor };
}

async function groupFor(app: ServerApp, owner: Client, name: string): Promise<{ groupId: number; cursor: number }> {
  const createCid = cid();
  const created = await sync(app, owner.account.token, owner.cursor, [groupOp(createCid, name)]);
  return { groupId: seqOf(created, createCid), cursor: created.cursor };
}

describe("Slice 8: history", () => {
  test("only visible events, newest first, with a cap of 100", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", limits: { messagesPerMinute: 1000 } });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const { groupId, cursor } = await groupFor(app, alice, "Historia");
      await sync(app, alice.account.token, cursor, [
        postOp(cid(), groupId, "uno"),
        postOp(cid(), groupId, "dos"),
        postOp(cid(), groupId, "tres"),
      ]);
      // A post in another group must never leak into this scope's history.
      const other = await groupFor(app, alice, "Otra");
      await sync(app, alice.account.token, headCursor(app.db), [postOp(cid(), other.groupId, "ajena")]);

      const newest = await history(app, alice.account.token, groupId, headCursor(app.db) + 1, 2);
      expect(newest.events.map((event) => (event.tag === Tag.Post ? event.text : ""))).toEqual(["tres", "dos"]);
      expect(newest.more).toBe(true);

      const beforeDos = newest.events.at(-1)?.seq ?? 0;
      const oldest = await history(app, alice.account.token, groupId, beforeDos, 100);
      expect(postEvents(oldest.events).map((event) => event.text)).toEqual(["uno"]);
      expect(oldest.more).toBe(false);

      // Bob is not a member: the open group's metadata is visible, its posts are not.
      const outsider = await history(app, bob.account.token, groupId, headCursor(app.db) + 1, 100);
      expect(postEvents(outsider.events)).toEqual([]);

      // The server refuses a limit above the protocol cap instead of silently clamping it.
      const tooMany = await rawHistory(app, alice.account.token, groupId, headCursor(app.db) + 1, 101);
      expect(tooMany.status).toBe(400);

      // History needs the same session /sync needs.
      const anonymous = await app.fetch(
        new Request("http://chat.local/history", {
          method: "POST",
          headers: { "Content-Type": "application/cbor" },
          body: new Uint8Array(),
        }),
      );
      expect(anonymous.status).toBe(401);
    } finally {
      app.close();
    }
  });

  test("a group member sees posts, and a DM participant sees the thread", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", limits: { messagesPerMinute: 1000 } });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const { groupId, cursor } = await groupFor(app, alice, "Miembros");

      const joined = await sync(app, bob.account.token, bob.cursor, [joinOp(cid(), groupId, bob.wire)]);
      await sync(app, alice.account.token, cursor, [postOp(cid(), groupId, "para bob")]);

      const seen = await history(app, bob.account.token, groupId, headCursor(app.db) + 1);
      expect(postEvents(seen.events).map((event) => event.text)).toEqual(["para bob"]);
      expect(joined.acks).toHaveLength(1);

      const dmCid = cid();
      const opened = await sync(app, alice.account.token, headCursor(app.db), [
        { cid: dmCid, tag: Tag.Dm, scope: 0, peer: bob.wire, text: "hola bob", media: null },
      ]);
      const dmScope = opened.events.find(
        (event): event is Extract<Event, { tag: typeof Tag.DmScope }> => event.tag === Tag.DmScope,
      );
      expect(dmScope).toBeDefined();
      if (!dmScope) throw new Error("dm scope missing");

      const thread = await history(app, bob.account.token, dmScope.scope, headCursor(app.db) + 1);
      expect(thread.events.map((event) => (event.tag === Tag.Dm ? event.text : ""))).toContain("hola bob");

      // The id names a DM Bob is not part of.
      const carol = await client(app, "carol");
      const foreign = await history(app, carol.account.token, dmScope.scope, headCursor(app.db) + 1);
      expect(foreign.events).toEqual([]);
    } finally {
      app.close();
    }
  });
});

describe("Slice 8: gaps", () => {
  test("no gap at exactly 100 missed content events, a gap at 101", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", limits: { messagesPerMinute: 1000 } });
    try {
      const alice = await client(app, "alice");
      const { groupId, cursor } = await groupFor(app, alice, "Cien");

      const exactly = await sync(
        app,
        alice.account.token,
        cursor,
        Array.from({ length: 100 }, (_, i) => postOp(cid(), groupId, `p${i}`)),
      );
      expect(gapEvents(exactly.events)).toEqual([]);
      expect(postEvents(exactly.events)).toHaveLength(100);

      const afterHundred = exactly.cursor;
      const over = await sync(
        app,
        alice.account.token,
        afterHundred,
        Array.from({ length: 101 }, (_, i) => postOp(cid(), groupId, `q${i}`)),
      );
      const gaps = gapEvents(over.events);
      expect(gaps).toHaveLength(1);
      const gap = gaps[0]!;
      expect(gap).toMatchObject({ after: afterHundred, count: 1 });
      // The newest 100 still arrive; only the first of the 101 is behind the gap.
      expect(postEvents(over.events)).toHaveLength(100);
      expect(postEvents(over.events)[0]?.text).toBe("q1");
      expect(gap.before).toBe(postEvents(over.events)[0]?.seq ?? 0);
    } finally {
      app.close();
    }
  });

  test("the gap fills only on tap, without re-downloading what sync already delivered", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", limits: { messagesPerMinute: 2000 } });
    try {
      const alice = await client(app, "alice");
      const { groupId, cursor } = await groupFor(app, alice, "Lejos");

      const posted = await sync(
        app,
        alice.account.token,
        cursor,
        Array.from({ length: 150 }, (_, i) => postOp(cid(), groupId, `d${i}`)),
      );
      const gap = gapEvents(posted.events)[0];
      expect(gap).toBeDefined();
      if (!gap) throw new Error("gap missing");
      expect(gap).toMatchObject({ after: cursor, count: 50 });

      const delivered = postEvents(posted.events);
      expect(delivered).toHaveLength(100);
      expect(delivered.at(0)?.text).toBe("d50");
      expect(gap.before).toBe(delivered[0]?.seq ?? 0);

      // Tapping "load older" asks for what is older than the first delivered post.
      const filled = await history(app, alice.account.token, groupId, gap.before, 100);
      expect(postEvents(filled.events).map((event) => event.text)).toEqual(
        Array.from({ length: 50 }, (_, i) => `d${49 - i}`),
      );
      expect(filled.more).toBe(false);

      // The page after the gap does not repeat the 100 posts already delivered.
      const next = await sync(app, alice.account.token, posted.cursor, []);
      expect(next.events).toEqual([]);
      expect(next.more).toBe(false);
      expect(next.cursor).toBe(headCursor(app.db));
    } finally {
      app.close();
    }
  });

  test("each flooded scope gets its own gap in one response", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", limits: { messagesPerMinute: 1000 } });
    try {
      const alice = await client(app, "alice");
      const first = await groupFor(app, alice, "Uno");
      const second = await groupFor(app, alice, "Dos");

      const posted = await sync(app, alice.account.token, second.cursor, [
        ...Array.from({ length: 150 }, (_, i) => postOp(cid(), first.groupId, `a${i}`)),
        ...Array.from({ length: 150 }, (_, i) => postOp(cid(), second.groupId, `b${i}`)),
      ]);
      const gaps = gapEvents(posted.events);
      expect(gaps.map((gap) => gap.scope).sort((a, b) => a - b)).toEqual(
        [first.groupId, second.groupId].sort((a, b) => a - b),
      );
      expect(gaps.every((gap) => gap.count === 50)).toBe(true);
      expect(postEvents(posted.events)).toHaveLength(200);
    } finally {
      app.close();
    }
  });

  test("a 3-week-offline catch-up is capped and its byte cost measured", async () => {
    // 40 posts/day for 21 days in one group: the flood a metered connection must not pay for.
    const DAYS = 21;
    const PER_DAY = 40;
    const total = DAYS * PER_DAY;
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      limits: { messagesPerMinute: total + 100 },
    });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const { groupId, cursor } = await groupFor(app, alice, "Tres semanas");

      const joined = await sync(app, bob.account.token, bob.cursor, [joinOp(cid(), groupId, bob.wire)]);
      // Bob's cursor is where his device went offline: after joining, before any post.
      const offlineCursor = joined.cursor;

      const ops: Op[] = [];
      for (let day = 0; day < DAYS; day++) {
        for (let post = 0; post < PER_DAY; post++) ops.push(postOp(cid(), groupId, `d${day} p${post}`));
      }
      const posted = await sync(app, alice.account.token, cursor, ops);
      expect(posted.acks).toHaveLength(total);

      const compressed = await rawSync(app, bob.account.token, offlineCursor);
      const uncompressed = new Uint8Array(brotliDecompressSync(compressed));
      const decoded = decodeSyncResponse(uncompressed);

      console.log(
        `3-week catch-up: ${total} missed posts -> ${decoded.events.length} events, ` +
          `${uncompressed.byteLength} B uncompressed, ${compressed.byteLength} B on the wire`,
      );

      expect(gapEvents(decoded.events)).toHaveLength(1);
      expect(postEvents(decoded.events)).toHaveLength(100);
      expect(decoded.more).toBe(false);
      // One response, inside the 100-post budget, instead of the whole three weeks.
      expect(uncompressed.byteLength).toBeLessThanOrEqual(POSTS_BUDGET);
      expect(compressed.byteLength).toBeLessThanOrEqual(POSTS_BUDGET);

      const gap = gapEvents(decoded.events)[0]!;
      expect(gap.count).toBe(total - 100);

      // Only a tap pays for the rest, one page at a time.
      const page = await history(app, bob.account.token, groupId, gap.before, 100);
      expect(page.events).toHaveLength(100);
      expect(page.more).toBe(true);
    } finally {
      app.close();
    }
  });
});
