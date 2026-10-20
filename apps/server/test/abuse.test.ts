// Slice 6: open servers stay usable (ADR 0012). Rate limits are per-op acks, new accounts
// wait 24h before opening a DM, and a personal block is silent on the wire. Two bearer
// tokens and one event log are the only way to prove any of it end to end.
import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import {
  AckError,
  PROTOCOL_VERSION,
  Role,
  Tag,
  decodeSyncResponse,
  encodeSyncRequest,
  type Event,
  type Op,
  type SyncResponse,
} from "@brr-chat/protocol";
import { createApp, type ServerApp } from "../src/index.ts";
import { DEFAULT_ABUSE_LIMITS } from "../src/limits.ts";

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
  return Uint8Array.from([6, 6, 6, 6, 6, 6, Math.floor(nextCid / 256) % 256, nextCid % 256]);
}

function profileOp(c: Uint8Array, username: string): Op {
  return { cid: c, tag: Tag.Profile, scope: 0, username, displayName: username, bio: "" };
}

function groupOp(c: Uint8Array, name: string, open = true): Op {
  return { cid: c, tag: Tag.GroupMeta, scope: 0, name, about: "", open };
}

function joinOp(c: Uint8Array, group: number, user: number): Op {
  return { cid: c, tag: Tag.Membership, scope: group, user, role: Role.Member };
}

function postOp(c: Uint8Array, group: number, text: string): Op {
  return { cid: c, tag: Tag.Post, scope: group, text, media: null };
}

function dmOp(c: Uint8Array, scope: number, peer: number, text: string): Op {
  return { cid: c, tag: Tag.Dm, scope, peer, text, media: null };
}

function blockOp(c: Uint8Array, user: number, on: boolean): Op {
  return { cid: c, tag: Tag.Block, scope: 0, user, on };
}

async function signUp(app: ServerApp, username: string, ip?: string): Promise<Account> {
  const res = await app.fetch(
    new Request("http://chat.local/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
      body: JSON.stringify({ username, password: "password1234" }),
    }),
    ip,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; recoveryCode: string };
  const confirm = await app.fetch(
    new Request("http://chat.local/api/recovery/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ group: body.recoveryCode.slice(-5) }),
    }),
    ip,
  );
  expect(confirm.status).toBe(200);
  return { token: body.token, username };
}

function setAge(app: ServerApp, username: string, hours: number): void {
  app.db
    .query("UPDATE user SET createdAt = ? WHERE username = ?")
    .run(new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(), username);
}

async function sync(app: ServerApp, token: string, cursor: number, outbox: Op[] = []): Promise<SyncResponse> {
  const res = await app.fetch(
    new Request("http://chat.local/sync", {
      method: "POST",
      headers: { "Content-Type": "application/cbor", Authorization: `Bearer ${token}` },
      body: encodeSyncRequest({ v: PROTOCOL_VERSION, cursor, outbox }),
    }),
  );
  expect(res.status).toBe(200);
  const decompressed = new Uint8Array(brotliDecompressSync(new Uint8Array(await res.arrayBuffer())));
  return decodeSyncResponse(decompressed);
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

/** Default age 25h: past both the group and the DM cooldown (ADR 0010, ADR 0012). */
async function client(app: ServerApp, username: string, ageHours = 25): Promise<Client> {
  const account = await signUp(app, username);
  setAge(app, username, ageHours);
  const identity = await identify(app, account);
  return { account, wire: identity.wire, cursor: identity.cursor };
}

function posts(events: Event[]): string[] {
  return events.flatMap((event) => (event.tag === Tag.Post && "text" in event ? [event.text] : []));
}

function dmMessages(events: Event[]): Extract<Event, { tag: typeof Tag.Dm }>[] {
  return events.filter((event): event is Extract<Event, { tag: typeof Tag.Dm }> => event.tag === Tag.Dm);
}

function dmScopeEvents(events: Event[]): Extract<Event, { tag: typeof Tag.DmScope }>[] {
  return events.filter((event): event is Extract<Event, { tag: typeof Tag.DmScope }> => event.tag === Tag.DmScope);
}

function tableCount(app: ServerApp, table: string): number {
  const row = app.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

/** Creates an open group and returns its id, so posts and joins have somewhere to land. */
async function openGroup(app: ServerApp, owner: Client): Promise<number> {
  const c = cid();
  const response = await sync(app, owner.account.token, owner.cursor, [groupOp(c, "Plaza")]);
  owner.cursor = response.cursor;
  return seqOf(response, c);
}

describe("Slice 6: abuse controls", () => {
  test("the defaults match ADR 0012", () => {
    expect(DEFAULT_ABUSE_LIMITS).toEqual({
      messagesPerMinute: 30,
      newDmThreadsPerDay: 10,
      signupsPerHour: 3,
      dmCooldownSeconds: 24 * 60 * 60,
    });
  });

  test("posts and DMs share a 30-per-minute budget and over-budget ops get RateLimited acks", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const group = await openGroup(app, alice);

      const batch = Array.from({ length: 31 }, () => cid());
      const response = await sync(
        app,
        alice.account.token,
        alice.cursor,
        batch.map((c, i) => postOp(c, group, `post ${i}`)),
      );

      for (const c of batch.slice(0, 30)) expect(ack(response, c)).toHaveProperty("seq");
      expect(ack(response, batch[30]!)).toEqual({ error: AckError.RateLimited });
      expect(tableCount(app, "events WHERE tag = 1")).toBe(30);
      expect(posts(response.events)).toHaveLength(30);

      // The rest of a budget shared with DMs is visible from the DM side too.
      const dmC = cid();
      const dm = await sync(app, alice.account.token, response.cursor, [dmOp(dmC, 0, bob.wire, "one too many")]);
      expect(ack(dm, dmC)).toEqual({ error: AckError.RateLimited });
      expect(tableCount(app, "events WHERE tag = 3")).toBe(0);

      // The budget is per account: Bob still has his own.
      const bobC = cid();
      const bobDm = await sync(app, bob.account.token, bob.cursor, [dmOp(bobC, 0, alice.wire, "my own budget")]);
      expect(ack(bobDm, bobC)).toHaveProperty("seq");
    } finally {
      app.close();
    }
  });

  test("a new DM thread is one of ten per day, and only new threads count", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      limits: { signupsPerHour: 100 },
    });
    try {
      const alice = await client(app, "alice");
      const peers = await Promise.all(Array.from({ length: 11 }, (_, i) => client(app, `peer${i}`)));

      const threads = peers.map(() => cid());
      const opened = await sync(
        app,
        alice.account.token,
        alice.cursor,
        peers.map((peer, i) => dmOp(threads[i]!, 0, peer.wire, "hola")),
      );
      for (const c of threads.slice(0, 10)) expect(ack(opened, c)).toHaveProperty("seq");
      expect(ack(opened, threads[10]!)).toEqual({ error: AckError.RateLimited });
      expect(tableCount(app, "dm_scopes")).toBe(10);

      // A reply in an existing thread is not a new thread and stays inside the budget.
      const scope = dmScopeEvents(opened.events)[0]!.scope;
      const replyC = cid();
      const reply = await sync(app, alice.account.token, opened.cursor, [dmOp(replyC, scope, peers[0]!.wire, "again")]);
      expect(ack(reply, replyC)).toHaveProperty("seq");
    } finally {
      app.close();
    }
  });

  test("an account younger than 24h cannot open a DM, but can reply in one opened for it", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const young = await client(app, "young", 0);

      const deniedC = cid();
      const denied = await sync(app, young.account.token, young.cursor, [
        dmOp(deniedC, 0, alice.wire, "let me in"),
      ]);
      expect(ack(denied, deniedC)).toEqual({ error: AckError.Forbidden });
      expect(tableCount(app, "dm_scopes")).toBe(0);

      const invitedC = cid();
      const invited = await sync(app, alice.account.token, alice.cursor, [
        dmOp(invitedC, 0, young.wire, "hola, joven"),
      ]);
      const scope = dmScopeEvents(invited.events)[0]!.scope;

      const replyC = cid();
      const replied = await sync(app, young.account.token, young.cursor, [dmOp(replyC, scope, alice.wire, "hola")]);
      expect(ack(replied, replyC)).toHaveProperty("seq");

      // Reusing the thread's scope id is still a reply, not a new thread.
      const reuseC = cid();
      const reused = await sync(app, young.account.token, replied.cursor, [
        dmOp(reuseC, scope, alice.wire, "otra vez"),
      ]);
      expect(ack(reused, reuseC)).toHaveProperty("seq");
      expect(tableCount(app, "dm_scopes")).toBe(1);
    } finally {
      app.close();
    }
  });

  test("signups are limited to three per hour per IP", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      for (const username of ["alice", "bob", "carol"]) {
        await signUp(app, username, "203.0.113.7");
      }

      const limited = await app.fetch(
        new Request("http://chat.local/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
          body: JSON.stringify({ username: "dave", password: "password1234" }),
        }),
        "203.0.113.7",
      );
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

      // Another address has its own budget.
      const other = await app.fetch(
        new Request("http://chat.local/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
          body: JSON.stringify({ username: "erin", password: "password1234" }),
        }),
        "203.0.113.8",
      );
      expect(other.status).toBe(200);
    } finally {
      app.close();
    }
  });

  test("a burst of concurrent signups cannot exceed the per-IP budget", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const ip = "203.0.113.20";
      const responses = await Promise.all(
        ["ana", "bea", "carla", "dora", "eva"].map((username) =>
          app.fetch(
            new Request("http://chat.local/api/auth/sign-up/email", {
              method: "POST",
              headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
              body: JSON.stringify({ username, password: "password1234" }),
            }),
            ip,
          ),
        ),
      );
      const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      expect(tableCount(app, "user")).toBe(3);
    } finally {
      app.close();
    }
  });

  test("a failed signup does not spend one of the IP's three slots", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const ip = "203.0.113.30";
      await signUp(app, "alice", ip);

      // The same username again fails upstream; the reservation goes back.
      const duplicate = await app.fetch(
        new Request("http://chat.local/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://chat.local" },
          body: JSON.stringify({ username: "alice", password: "password1234" }),
        }),
        ip,
      );
      expect(duplicate.status).not.toBe(200);

      await signUp(app, "bob", ip);
      await signUp(app, "carol", ip);
      expect(tableCount(app, "user")).toBe(3);
    } finally {
      app.close();
    }
  });

  test("a block hides the blocked user's posts and DMs while both sides see normal acks", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice");
      const bob = await client(app, "bob");
      const carol = await client(app, "carol");
      const group = await openGroup(app, alice);

      const joinBob = cid();
      const joined = await sync(app, bob.account.token, bob.cursor, [joinOp(joinBob, group, bob.wire)]);
      bob.cursor = joined.cursor;
      const joinCarol = cid();
      const joinedCarol = await sync(app, carol.account.token, carol.cursor, [joinOp(joinCarol, group, carol.wire)]);
      carol.cursor = joinedCarol.cursor;

      const beforeC = cid();
      const before = await sync(app, bob.account.token, bob.cursor, [postOp(beforeC, group, "before the block")]);
      bob.cursor = before.cursor;
      expect(ack(before, beforeC)).toHaveProperty("seq");

      const earlier = await sync(app, alice.account.token, alice.cursor);
      alice.cursor = earlier.cursor;
      expect(posts(earlier.events)).toEqual(["before the block"]);

      const blockC = cid();
      const blocked = await sync(app, alice.account.token, alice.cursor, [blockOp(blockC, bob.wire, true)]);
      alice.cursor = blocked.cursor;
      expect(ack(blocked, blockC)).toHaveProperty("seq");
      expect(tableCount(app, "user_blocks")).toBe(1);

      // A reinstall still knows whom it blocked; the blocked account never sees the event.
      const aliceFresh = await sync(app, alice.account.token, 0, []);
      expect(aliceFresh.events.find((event) => event.tag === Tag.Block)).toMatchObject({
        user: bob.wire,
        on: true,
      });
      const bobFresh = await sync(app, bob.account.token, 0, []);
      expect(bobFresh.events.some((event) => event.tag === Tag.Block)).toBe(false);

      // Bob made the post; he still sees it, and never learns about the block.
      const bobPostC = cid();
      const bobPosted = await sync(app, bob.account.token, bob.cursor, [postOp(bobPostC, group, "after the block")]);
      bob.cursor = bobPosted.cursor;
      const bobPostSeq = seqOf(bobPosted, bobPostC);
      expect(posts(bobPosted.events)).toEqual(["after the block"]);
      expect(bobPosted.events.some((event) => event.tag === Tag.Block)).toBe(false);

      // Alice does not see it; Carol, who blocked nobody, does.
      const aliceAfter = await sync(app, alice.account.token, alice.cursor);
      alice.cursor = aliceAfter.cursor;
      expect(posts(aliceAfter.events)).toEqual([]);
      expect(aliceAfter.cursor).toBeGreaterThanOrEqual(bobPostSeq);

      const carolAfter = await sync(app, carol.account.token, carol.cursor);
      carol.cursor = carolAfter.cursor;
      expect(posts(carolAfter.events)).toContain("after the block");

      // A DM to Alice is acked as delivered but never reaches her.
      const dmC = cid();
      const bobDm = await sync(app, bob.account.token, bob.cursor, [dmOp(dmC, 0, alice.wire, "psst")]);
      bob.cursor = bobDm.cursor;
      const dmSeq = seqOf(bobDm, dmC);
      expect(dmMessages(bobDm.events).map((event) => event.text)).toEqual(["psst"]);

      const aliceDm = await sync(app, alice.account.token, alice.cursor);
      alice.cursor = aliceDm.cursor;
      expect(aliceDm.events.some((event) => event.seq === dmSeq)).toBe(false);
      expect(dmScopeEvents(aliceDm.events)).toEqual([]);
      expect(dmMessages(aliceDm.events)).toEqual([]);

      // Unblocking is also silent, and restores delivery of new posts and DMs.
      const unblockC = cid();
      const unblocked = await sync(app, alice.account.token, alice.cursor, [blockOp(unblockC, bob.wire, false)]);
      alice.cursor = unblocked.cursor;
      expect(ack(unblocked, unblockC)).toHaveProperty("seq");
      expect(tableCount(app, "user_blocks")).toBe(0);

      const afterUnblockC = cid();
      const afterUnblock = await sync(app, bob.account.token, bob.cursor, [
        postOp(afterUnblockC, group, "visible again"),
      ]);
      bob.cursor = afterUnblock.cursor;

      const aliceSees = await sync(app, alice.account.token, alice.cursor);
      expect(posts(aliceSees.events)).toEqual(["visible again"]);

      const dmAgainC = cid();
      const dmAgain = await sync(app, bob.account.token, bob.cursor, [dmOp(dmAgainC, 0, alice.wire, "back")]);
      const dmAgainSeq = seqOf(dmAgain, dmAgainC);
      const aliceReceives = await sync(app, alice.account.token, aliceSees.cursor);
      expect(aliceReceives.events.some((event) => event.seq === dmAgainSeq)).toBe(true);
    } finally {
      app.close();
    }
  });
});
