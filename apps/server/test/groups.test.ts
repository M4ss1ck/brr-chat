// Slice 4: create an open group, post, and let a second account join and sync. The server is
// the only place this can be proven end to end: two bearer tokens, one event log.
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
  return Uint8Array.from([7, 7, 7, 7, 7, 7, Math.floor(nextCid / 256) % 256, nextCid % 256]);
}

function groupOp(c: Uint8Array, name: string, open = true, about = ""): Op {
  return { cid: c, tag: Tag.GroupMeta, scope: 0, name, about, open };
}

function profileOp(c: Uint8Array, username: string): Op {
  return { cid: c, tag: Tag.Profile, scope: 0, username, displayName: username, bio: "" };
}

function joinOp(c: Uint8Array, group: number, user: number, role: number = Role.Member): Op {
  return { cid: c, tag: Tag.Membership, scope: group, user, role };
}

function postOp(c: Uint8Array, group: number, text: string): Op {
  return { cid: c, tag: Tag.Post, scope: group, text, media: null };
}

function replyOp(c: Uint8Array, group: number, parent: number, text: string): Op {
  return { cid: c, tag: Tag.Reply, scope: group, parent, text, media: null };
}

function reactionOp(c: Uint8Array, group: number, target: number, emoji: number, on: boolean): Op {
  return { cid: c, tag: Tag.Reaction, scope: group, target, emoji, on };
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

function posts(events: Event[]): string[] {
  return events.flatMap((event) => (event.tag === Tag.Post && "text" in event ? [event.text] : []));
}

/** Publishes a profile, then reads the wire id the server assigned to this account. */
async function identify(app: ServerApp, account: Account): Promise<{ wire: number; cursor: number }> {
  const c = cid();
  const response = await sync(app, account.token, 0, [profileOp(c, account.username)]);
  const profile = response.events.find(
    (event) => event.tag === Tag.Profile && "username" in event && event.username === account.username,
  );
  expect(profile).toBeDefined();
  if (!profile) throw new Error("profile event missing from the state snapshot");
  return { wire: profile.author, cursor: response.cursor };
}

async function client(app: ServerApp, username: string, ageHours?: number): Promise<Client> {
  const account = await signUp(app, username);
  if (ageHours !== undefined) setAge(app, username, ageHours);
  const identity = await identify(app, account);
  return { account, wire: identity.wire, cursor: identity.cursor };
}

describe("Slice 4: groups, posts and visibility", () => {
  test("an account younger than 24h gets Forbidden on group creation", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await signUp(app, "alice");
      const c = cid();
      const response = await sync(app, alice.token, 0, [groupOp(c, "Too soon")]);
      expect(ack(response, c)).toEqual({ error: AckError.Forbidden });
      const count = app.db.query("SELECT COUNT(*) AS n FROM chat_groups").get() as { n: number };
      expect(Number(count.n)).toBe(0);
    } finally {
      app.close();
    }
  });

  test("creating an open group returns its seq as the id and delivers owner state", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const c = cid();
      const response = await sync(app, alice.account.token, alice.cursor, [groupOp(c, "La Habana", true, "Grupo abierto")]);
      const groupId = seqOf(response, c);
      expect(groupId).toBeGreaterThan(0);

      const meta = response.events.find((event) => event.tag === Tag.GroupMeta && event.scope === groupId);
      expect(meta).toMatchObject({ name: "La Habana", about: "Grupo abierto", open: true });
      const owner = response.events.find(
        (event) => event.tag === Tag.Membership && event.scope === groupId && event.user === alice.wire,
      );
      expect(owner).toMatchObject({ role: Role.Owner });
      expect(posts(response.events)).toEqual([]);
    } finally {
      app.close();
    }
  });

  test("retrying the same cid never duplicates a group or a post", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Once")]);
      const groupId = seqOf(created, createCid);

      const retried = await sync(app, alice.account.token, created.cursor, [groupOp(createCid, "Once")]);
      expect(seqOf(retried, createCid)).toBe(groupId);
      // A retry lost its first response: it still gets the state snapshot, not a bare ack.
      expect(retried.events.some((event) => event.tag === Tag.GroupMeta && event.scope === groupId)).toBe(true);
      const groupCount = app.db.query("SELECT COUNT(*) AS n FROM events WHERE tag = ? AND scope = ?").get(Tag.GroupMeta, groupId) as {
        n: number;
      };
      expect(Number(groupCount.n)).toBe(1);
      const ownerCount = app.db
        .query("SELECT COUNT(*) AS n FROM events WHERE tag = ? AND scope = ? AND author = ?")
        .get(Tag.Membership, groupId, alice.wire) as { n: number };
      expect(Number(ownerCount.n)).toBe(1);

      const postCid = cid();
      const first = await sync(app, alice.account.token, retried.cursor, [postOp(postCid, groupId, "only once")]);
      const postSeq = seqOf(first, postCid);
      const second = await sync(app, alice.account.token, first.cursor, [postOp(postCid, groupId, "only once")]);
      expect(seqOf(second, postCid)).toBe(postSeq);
      const postCount = app.db
        .query("SELECT COUNT(*) AS n FROM events WHERE tag = ? AND scope = ?")
        .get(Tag.Post, groupId) as { n: number };
      expect(Number(postCount.n)).toBe(1);
    } finally {
      app.close();
    }
  });

  test("a non-member gets open metadata but no posts or memberships from the group", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const openCid = cid();
      const openCreated = await sync(app, alice.account.token, alice.cursor, [groupOp(openCid, "Open", true)]);
      const openGroup = seqOf(openCreated, openCid);

      const closedCid = cid();
      const closedCreated = await sync(app, alice.account.token, openCreated.cursor, [
        groupOp(closedCid, "Closed", false),
      ]);
      const closedGroup = seqOf(closedCreated, closedCid);

      const afterPost = await sync(app, alice.account.token, closedCreated.cursor, [
        postOp(cid(), openGroup, "members only"),
        postOp(cid(), closedGroup, "closed group post"),
      ]);
      expect(afterPost.events.length).toBeGreaterThan(0);

      const fromBob = await sync(app, bob.account.token, bob.cursor, []);
      expect(fromBob.events.some((event) => event.tag === Tag.GroupMeta && event.scope === openGroup)).toBe(true);
      expect(fromBob.events.some((event) => event.scope === openGroup && event.tag !== Tag.GroupMeta)).toBe(false);
      expect(fromBob.events.some((event) => event.scope === closedGroup)).toBe(false);
      expect(posts(fromBob.events)).toEqual([]);
    } finally {
      app.close();
    }
  });

  test("two clients: create, post, list, join, then see only new posts", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");

      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Habana", true, "Bienvenidos")]);
      const groupId = seqOf(created, createCid);

      const beforeCid = cid();
      const beforeJoin = await sync(app, alice.account.token, created.cursor, [postOp(beforeCid, groupId, "before bob")]);
      expect(seqOf(beforeJoin, beforeCid)).toBeGreaterThan(groupId);

      // Bob finds it in the open list, with no post history.
      const listing = await sync(app, bob.account.token, bob.cursor, []);
      expect(listing.events.some((event) => event.tag === Tag.GroupMeta && event.scope === groupId)).toBe(true);
      expect(posts(listing.events)).toEqual([]);

      // One-tap join: group state and a head cursor, still zero old posts.
      const joinCid = cid();
      const joined = await sync(app, bob.account.token, listing.cursor, [joinOp(joinCid, groupId, bob.wire)]);
      expect(seqOf(joined, joinCid)).toBeGreaterThan(groupId);
      expect(joined.cursor).toBe(headCursor(app.db));
      expect(joined.events.some((event) => event.tag === Tag.GroupMeta && event.scope === groupId)).toBe(true);
      expect(
        joined.events.some((event) => event.tag === Tag.Membership && event.scope === groupId && event.user === bob.wire),
      ).toBe(true);
      expect(posts(joined.events)).toEqual([]);

      // A retried join with the same cid returns state again, still with zero old posts.
      const retriedJoin = await sync(app, bob.account.token, joined.cursor, [joinOp(joinCid, groupId, bob.wire)]);
      expect(seqOf(retriedJoin, joinCid)).toBe(joined.cursor);
      expect(retriedJoin.events.some((event) => event.tag === Tag.GroupMeta && event.scope === groupId)).toBe(true);
      expect(posts(retriedJoin.events)).toEqual([]);

      // A new post after the join is delivered; the one before it never is.
      const afterCid = cid();
      const afterJoin = await sync(app, alice.account.token, beforeJoin.cursor, [postOp(afterCid, groupId, "after bob")]);
      expect(seqOf(afterJoin, afterCid)).toBeGreaterThan(joined.cursor);

      const delivered = await sync(app, bob.account.token, joined.cursor, []);
      expect(posts(delivered.events)).toEqual(["after bob"]);
      expect(delivered.cursor).toBe(headCursor(app.db));

      const member = app.db
        .query("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
        .get(groupId, bob.wire) as { role: number } | null;
      expect(member?.role).toBe(Role.Member);
    } finally {
      app.close();
    }
  });

  test("a corrupt stored event is skipped instead of wedging sync", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const bob = await client(app, "bob");
      app.db
        .query("INSERT INTO events (tag, ts, author, scope, bytes) VALUES (?, ?, ?, ?, ?)")
        .run(Tag.Post, 1, 1, 0, new Uint8Array([0xff, 0xff]));
      const response = await sync(app, bob.account.token, bob.cursor, []);
      expect(response.events).toEqual([]);
      expect(response.cursor).toBe(headCursor(app.db));
    } finally {
      app.close();
    }
  });

  test("sync pages at 500 events and the next call finishes the log", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Big", true)]);
      const groupId = seqOf(created, createCid);

      const many = Array.from({ length: 501 }, (_, i) => postOp(cid(), groupId, `p${i}`));
      const posted = await sync(app, alice.account.token, created.cursor, many);
      expect(posted.acks).toHaveLength(501);
      expect(posted.events.filter((event) => event.tag === Tag.Post)).toHaveLength(500);
      expect(posted.more).toBe(true);

      const rest = await sync(app, alice.account.token, posted.cursor, []);
      expect(posts(rest.events)).toEqual(["p500"]);
      expect(rest.more).toBe(false);
      expect(rest.cursor).toBe(headCursor(app.db));
    } finally {
      app.close();
    }
  });

  test("posting and joining are refused with the right ack", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const alice = await client(app, "alice", 25);
      const bob = await client(app, "bob");
      const createCid = cid();
      const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Open", true)]);
      const groupId = seqOf(created, createCid);

      const outsiderPost = cid();
      const refused = await sync(app, bob.account.token, bob.cursor, [postOp(outsiderPost, groupId, "hello")]);
      expect(ack(refused, outsiderPost)).toEqual({ error: AckError.Forbidden });

      const escalation = cid();
      const promoted = await sync(app, bob.account.token, refused.cursor, [joinOp(escalation, groupId, bob.wire, Role.Admin)]);
      expect(ack(promoted, escalation)).toEqual({ error: AckError.Forbidden });

      const missing = cid();
      const notFound = await sync(app, bob.account.token, promoted.cursor, [joinOp(missing, 999_999, bob.wire)]);
      expect(ack(notFound, missing)).toEqual({ error: AckError.NotFound });
    } finally {
      app.close();
    }
  });
});

describe("Slice 5: replies and reactions", () => {
  /** Alice owns an open group with one post; Bob has joined and is at the head. */
  async function groupWithPost(app: ServerApp): Promise<{
    alice: Client;
    bob: Client;
    groupId: number;
    postSeq: number;
    afterPost: number;
  }> {
    const alice = await client(app, "alice", 25);
    const bob = await client(app, "bob");

    const createCid = cid();
    const created = await sync(app, alice.account.token, alice.cursor, [groupOp(createCid, "Habana", true)]);
    const groupId = seqOf(created, createCid);

    const listing = await sync(app, bob.account.token, bob.cursor, []);
    const joinCid = cid();
    const joined = await sync(app, bob.account.token, listing.cursor, [joinOp(joinCid, groupId, bob.wire)]);
    bob.cursor = joined.cursor;

    const postCid = cid();
    const posted = await sync(app, alice.account.token, created.cursor, [postOp(postCid, groupId, "the post")]);
    const postSeq = seqOf(posted, postCid);
    return { alice, bob, groupId, postSeq, afterPost: posted.cursor };
  }

  test("a reply to a post round-trips and a reply to a reply is Invalid", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const { alice, bob, groupId, postSeq, afterPost } = await groupWithPost(app);

      const replyCid = cid();
      const replied = await sync(app, bob.account.token, bob.cursor, [replyOp(replyCid, groupId, postSeq, "first reply")]);
      const replySeq = seqOf(replied, replyCid);
      const event = replied.events.find((candidate) => candidate.seq === replySeq);
      expect(event).toMatchObject({
        tag: Tag.Reply,
        scope: groupId,
        author: bob.wire,
        parent: postSeq,
        text: "first reply",
      });

      // Alice, the post's author, sees Bob's reply on her next sync.
      const seen = await sync(app, alice.account.token, afterPost, []);
      expect(seen.events.find((candidate) => candidate.seq === replySeq)).toMatchObject({
        tag: Tag.Reply,
        parent: postSeq,
      });

      // One level only: the parent of a reply must be a post.
      const nestedCid = cid();
      const nested = await sync(app, bob.account.token, replied.cursor, [
        replyOp(nestedCid, groupId, replySeq, "reply to a reply"),
      ]);
      expect(ack(nested, nestedCid)).toEqual({ error: AckError.Invalid });
      expect(app.db.query("SELECT COUNT(*) AS n FROM events WHERE tag = ? AND scope = ?").get(Tag.Reply, groupId)).toEqual({
        n: 1,
      });
    } finally {
      app.close();
    }
  });

  test("replies need an existing post in the same scope and membership", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const { alice, bob, groupId, postSeq, afterPost } = await groupWithPost(app);

      const missingCid = cid();
      const missing = await sync(app, bob.account.token, bob.cursor, [replyOp(missingCid, groupId, 999_999, "no parent")]);
      expect(ack(missing, missingCid)).toEqual({ error: AckError.NotFound });

      const secondCid = cid();
      const second = await sync(app, alice.account.token, afterPost, [groupOp(secondCid, "Other", true)]);
      const secondGroup = seqOf(second, secondCid);

      const otherScopeCid = cid();
      const otherScope = await sync(app, alice.account.token, second.cursor, [
        replyOp(otherScopeCid, secondGroup, postSeq, "wrong group"),
      ]);
      expect(ack(otherScope, otherScopeCid)).toEqual({ error: AckError.NotFound });

      const outsider = await client(app, "carol");
      const outsiderCid = cid();
      const refused = await sync(app, outsider.account.token, outsider.cursor, [
        replyOp(outsiderCid, groupId, postSeq, "not a member"),
      ]);
      expect(ack(refused, outsiderCid)).toEqual({ error: AckError.Forbidden });
    } finally {
      app.close();
    }
  });

  test("a reaction toggles on and off across two clients", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const { alice, bob, groupId, postSeq, afterPost } = await groupWithPost(app);

      const onCid = cid();
      const on = await sync(app, bob.account.token, bob.cursor, [reactionOp(onCid, groupId, postSeq, 2, true)]);
      const onSeq = seqOf(on, onCid);
      expect(on.events.find((candidate) => candidate.seq === onSeq)).toMatchObject({
        tag: Tag.Reaction,
        scope: groupId,
        author: bob.wire,
        target: postSeq,
        emoji: 2,
        on: true,
      });

      const aliceSeesOn = await sync(app, alice.account.token, afterPost, []);
      expect(aliceSeesOn.events.find((candidate) => candidate.seq === onSeq)).toMatchObject({ emoji: 2, on: true });

      const offCid = cid();
      const off = await sync(app, bob.account.token, on.cursor, [reactionOp(offCid, groupId, postSeq, 2, false)]);
      const offSeq = seqOf(off, offCid);
      expect(off.events.find((candidate) => candidate.seq === offSeq)).toMatchObject({ emoji: 2, on: false });

      const aliceSeesOff = await sync(app, alice.account.token, aliceSeesOn.cursor, []);
      expect(aliceSeesOff.events.find((candidate) => candidate.seq === offSeq)).toMatchObject({ emoji: 2, on: false });
    } finally {
      app.close();
    }
  });

  test("a reaction needs a post or reply target in the same group", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const { bob, groupId, postSeq } = await groupWithPost(app);

      const missingCid = cid();
      const missing = await sync(app, bob.account.token, bob.cursor, [
        reactionOp(missingCid, groupId, 999_999, 0, true),
      ]);
      expect(ack(missing, missingCid)).toEqual({ error: AckError.NotFound });

      const wrongTagCid = cid();
      const wrongTag = await sync(app, bob.account.token, missing.cursor, [
        reactionOp(wrongTagCid, groupId, groupId, 0, true),
      ]);
      expect(ack(wrongTag, wrongTagCid)).toEqual({ error: AckError.Invalid });

      const replyCid = cid();
      const reply = await sync(app, bob.account.token, wrongTag.cursor, [replyOp(replyCid, groupId, postSeq, "reply")]);
      const replySeq = seqOf(reply, replyCid);
      const emojiCid = cid();
      const reacted = await sync(app, bob.account.token, reply.cursor, [
        reactionOp(emojiCid, groupId, replySeq, 7, true),
      ]);
      expect(ack(reacted, emojiCid)).toEqual({ seq: expect.any(Number) });
    } finally {
      app.close();
    }
  });
});
