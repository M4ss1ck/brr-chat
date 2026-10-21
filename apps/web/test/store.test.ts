import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { AckError, Role, Tag, type Event } from "@brr-chat/protocol";
import {
  MEDIA_CACHE_LIMIT_BYTES,
  applyEvents,
  clearMediaBytes,
  closeStore,
  discardOutbox,
  enqueueOp,
  getBans,
  getCursor,
  getDmMessages,
  getDmScopes,
  getFailedOps,
  getGroups,
  getMediaBytes,
  getMembers,
  getMeter,
  getOutbox,
  getPendingOps,
  getPosts,
  getProfiles,
  getRange,
  getReactions,
  getSelf,
  getActiveAccount,
  getActiveServerId,
  getPendingInvite,
  getSession,
  getStoredCursor,
  ensureServer,
  listServers,
  mediaCacheBytes,
  migrateLegacy,
  removeServer,
  setActiveServer,
  setPendingInvite,
  nextReactionOn,
  putMediaBytes,
  removeOutbox,
  settleOutbox,
  setCursor,
  setMeter,
  setRange,
  setSelf,
  setSession,
  tallyReactions,
  toWireOp,
} from "../src/store.ts";

/** One server for most tests; a second one proves the namespaces do not collide (#18). */
const A = "https://a.example";
const B = "https://b.example";
const alice = { server: A, username: "alice" };
const bob = { server: A, username: "bob" };

/** Direct handle to the same DB the store uses, to simulate corrupt or stale rows. */
async function rawStore(): Promise<{ put(key: string, value: unknown): Promise<void>; close(): void }> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open("brr-chat", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("kv");
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
  return {
    async put(key, value) {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error);
        };
      });
    },
    close() {
      database.close();
    },
  };
}

describe("store (IndexedDB)", () => {
  // Bun runs every test file in one process: put the global back when this file is done.
  const originalIndexedDB = globalThis.indexedDB;

  afterAll(() => {
    globalThis.indexedDB = originalIndexedDB;
  });

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(async () => {
    await closeStore();
  });

  test("empty store reads as cursor 0, stored null, no session, no range", async () => {
    expect(await getCursor(alice)).toBe(0);
    expect(await getStoredCursor(alice)).toBeNull();
    expect(await getSession(A)).toBeNull();
    expect(await getRange(A)).toBeNull();
  });

  test("cursor round-trips", async () => {
    await setCursor(alice, 0);
    expect(await getCursor(alice)).toBe(0);
    await setCursor(alice, 4_000_000_000);
    expect(await getStoredCursor(alice)).toBe(4_000_000_000);
    expect(await getCursor(alice)).toBe(4_000_000_000);
  });

  test("session round-trips and clears with null", async () => {
    await setSession(A, { token: "a".repeat(32), username: "alice" });
    expect(await getSession(A)).toEqual({ token: "a".repeat(32), username: "alice" });
    await setSession(A, null);
    expect(await getSession(A)).toBeNull();
  });

  test("server range round-trips per server", async () => {
    await setRange(A, { min: 1, max: 1 });
    expect(await getRange(A)).toEqual({ min: 1, max: 1 });
    await setRange(A, { min: 1, max: 2 });
    expect(await getRange(A)).toEqual({ min: 1, max: 2 });
    expect(await getRange(B)).toBeNull();
  });

  test("setCursor rejects values that are not safe integers", async () => {
    expect(() => setCursor(alice, -1)).toThrow(RangeError);
    expect(() => setCursor(alice, 1.5)).toThrow(RangeError);
    expect(() => setCursor(alice, Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  test("a corrupt row reads back as not stored, never as garbage", async () => {
    const store = await rawStore();
    try {
      await store.put(`cursor:${A} alice`, "many");
      await store.put(`range:${A}`, { min: "1", max: 1 });
      await store.put("servers", [{ id: 12, session: { token: 1 } }]);
    } finally {
      store.close();
    }

    expect(await getStoredCursor(alice)).toBeNull();
    expect(await getCursor(alice)).toBe(0);
    expect(await getSession(A)).toBeNull();
    expect(await getRange(A)).toBeNull();
  });

  test("a closed handle reopens on the next call", async () => {
    await setCursor(alice, 7);
    await closeStore();
    expect(await getStoredCursor(alice)).toBe(7);
  });

  test("writing after a close does not throw", async () => {
    await closeStore();
    await setCursor(alice, 9);
    expect(await getCursor(alice)).toBe(9);
  });

  test("sync events build group, member, post and profile state", async () => {
    const events: Event[] = [
      { tag: Tag.GroupMeta, seq: 10, ts: 100, author: 1, scope: 10, name: "Habana", about: "abierto", open: true },
      { tag: Tag.Membership, seq: 11, ts: 101, author: 1, scope: 10, user: 1, role: Role.Owner },
      { tag: Tag.Membership, seq: 12, ts: 102, author: 2, scope: 10, user: 2, role: Role.Member },
      { tag: Tag.Post, seq: 13, ts: 103, author: 1, scope: 10, text: "hola", media: null },
      { tag: Tag.Profile, seq: 14, ts: 104, author: 1, scope: 0, username: "ana", displayName: "Ana", bio: "" },
    ];
    await applyEvents(alice, events);

    expect(await getGroups(alice)).toEqual([{ id: 10, seq: 10, name: "Habana", about: "abierto", open: true }]);
    expect(await getMembers(alice, 10)).toEqual([
      { group: 10, user: 1, role: Role.Owner, seq: 11 },
      { group: 10, user: 2, role: Role.Member, seq: 12 },
    ]);
    expect(await getPosts(alice, 10)).toEqual([{ seq: 13, ts: 103, author: 1, scope: 10, text: "hola", parent: 0, media: null }]);
    expect((await getProfiles(alice)).get(1)).toEqual({
      user: 1,
      seq: 14,
      username: "ana",
      displayName: "Ana",
      bio: "",
    });
  });

  test("a DM scope and its messages cache so the list and thread open offline", async () => {
    const events: Event[] = [
      { tag: Tag.DmScope, seq: 40, ts: 400, author: 1, scope: 40, peer: 2 },
      { tag: Tag.Dm, seq: 41, ts: 401, author: 1, scope: 40, peer: 2, text: "hola", media: null },
      { tag: Tag.Dm, seq: 42, ts: 402, author: 2, scope: 40, peer: 1, text: "te oigo", media: null },
      { tag: Tag.Profile, seq: 43, ts: 403, author: 2, scope: 0, username: "bea", displayName: "Bea", bio: "" },
    ];
    await applyEvents(alice, events);

    expect(await getDmScopes(alice)).toEqual([{ id: 40, seq: 40, a: 1, b: 2 }]);
    expect(await getDmMessages(alice, 40)).toEqual([
      { seq: 41, ts: 401, author: 1, scope: 40, text: "hola", parent: 0, media: null },
      { seq: 42, ts: 402, author: 2, scope: 40, text: "te oigo", parent: 0, media: null },
    ]);
    // No session, no network: a reopened store still renders the conversation.
    await closeStore();
    expect(await getDmScopes(alice)).toHaveLength(1);
    expect((await getDmMessages(alice, 40)).map((message) => message.text)).toEqual(["hola", "te oigo"]);
    // Another account on the same device never sees this conversation.
    expect(await getDmScopes(bob)).toEqual([]);

    // Losing access purges the conversation and its messages, like a group.
    await applyEvents(alice, [{ tag: Tag.ScopeLeft, seq: 44, ts: 404, author: 0, scope: 40, purge: true }]);
    expect(await getDmScopes(alice)).toEqual([]);
    expect(await getDmMessages(alice, 40)).toEqual([]);
  });

  test("a block event drops the blocked author's cached posts and reactions", async () => {
    await applyEvents(alice, [
      { tag: Tag.GroupMeta, seq: 10, ts: 100, author: 1, scope: 10, name: "Habana", about: "", open: false },
      { tag: Tag.Membership, seq: 11, ts: 101, author: 1, scope: 10, user: 1, role: Role.Owner },
      { tag: Tag.Membership, seq: 12, ts: 102, author: 2, scope: 10, user: 2, role: Role.Member },
      { tag: Tag.Post, seq: 13, ts: 103, author: 1, scope: 10, text: "mine", media: null },
      { tag: Tag.Post, seq: 14, ts: 104, author: 2, scope: 10, text: "theirs", media: null },
      { tag: Tag.Reaction, seq: 15, ts: 105, author: 2, scope: 10, target: 13, emoji: 0, on: true },
      { tag: Tag.DmScope, seq: 40, ts: 400, author: 1, scope: 40, peer: 2 },
      { tag: Tag.Dm, seq: 41, ts: 401, author: 1, scope: 40, peer: 2, text: "hola", media: null },
      { tag: Tag.Dm, seq: 42, ts: 402, author: 2, scope: 40, peer: 1, text: "te oigo", media: null },
    ]);

    await applyEvents(alice, [{ tag: Tag.Block, seq: 50, ts: 500, author: 1, scope: 0, user: 2, on: true }]);

    expect((await getPosts(alice, 10)).map((post) => post.author)).toEqual([1]);
    expect(await getReactions(alice, 10)).toEqual([]);
    expect((await getDmMessages(alice, 40)).map((message) => message.author)).toEqual([1]);
    // The block hides content, not the group, its members, or the conversation itself.
    expect((await getGroups(alice)).map((group) => group.id)).toEqual([10]);
    expect(await getMembers(alice, 10)).toHaveLength(2);
    expect(await getDmScopes(alice)).toHaveLength(1);
  });

  test("a dm op round-trips through the outbox with its peer", async () => {
    const stored = await enqueueOp(alice, { tag: Tag.Dm, scope: 0, peer: 2, text: "first" });
    expect(stored).toMatchObject({ tag: Tag.Dm, scope: 0, peer: 2, text: "first" });
    expect(toWireOp(stored)).toEqual({
      cid: new Uint8Array(stored.cid),
      tag: Tag.Dm,
      scope: 0,
      peer: 2,
      text: "first",
      media: null,
    });
    expect(await getOutbox(alice)).toEqual([stored]);
  });

  test("a block op round-trips through the outbox", async () => {
    const stored = await enqueueOp(alice, { tag: Tag.Block, scope: 0, user: 2, on: true });
    expect(toWireOp(stored)).toEqual({
      cid: new Uint8Array(stored.cid),
      tag: Tag.Block,
      scope: 0,
      user: 2,
      on: true,
    });
    expect(await getOutbox(alice)).toEqual([stored]);
  });

  test("applying the same state event twice never duplicates a post", async () => {
    const post: Event = { tag: Tag.Post, seq: 21, ts: 200, author: 1, scope: 20, text: "once", media: null };
    await applyEvents(alice, [post]);
    await applyEvents(alice, [post]);
    expect(await getPosts(alice, 20)).toHaveLength(1);
  });

  test("replies are cached next to their post with a parent", async () => {
    await applyEvents(alice, [
      { tag: Tag.Post, seq: 40, ts: 400, author: 1, scope: 10, text: "parent", media: null },
      { tag: Tag.Reply, seq: 41, ts: 401, author: 2, scope: 10, parent: 40, text: "child", media: null },
    ]);
    expect(await getPosts(alice, 10)).toEqual([
      { seq: 40, ts: 400, author: 1, scope: 10, text: "parent", parent: 0, media: null },
      { seq: 41, ts: 401, author: 2, scope: 10, text: "child", parent: 40, media: null },
    ]);
  });

  test("a post's image placeholder caches, and the image bytes never enter the store", async () => {
    const thumbhash = [1, 2, 3, 4, 5, 6, 7, 8];
    await applyEvents(alice, [
      {
        tag: Tag.Post,
        seq: 80,
        ts: 800,
        author: 1,
        scope: 10,
        text: "",
        media: { id: 9, w: 1280, h: 800, thumbhash: new Uint8Array(thumbhash) },
      },
    ]);

    const [post] = await getPosts(alice, 10);
    expect(post?.media).toEqual({ id: 9, w: 1280, h: 800, thumbhash });
    expect(post?.text).toBe("");
    // A reopened store renders the placeholder offline; the full bytes were never cached.
    await closeStore();
    expect((await getPosts(alice, 10))[0]?.media).toEqual({ id: 9, w: 1280, h: 800, thumbhash });
    expect(await getPosts(bob, 10)).toEqual([]);
  });

  test("a post op round-trips its media placeholder through the outbox", async () => {
    const media = { id: 7, w: 1280, h: 800, thumbhash: [9, 8, 7] };
    const stored = await enqueueOp(alice, { tag: Tag.Post, scope: 5, text: "", media });
    expect(toWireOp(stored)).toEqual({
      cid: new Uint8Array(stored.cid),
      tag: Tag.Post,
      scope: 5,
      text: "",
      media: { id: 7, w: 1280, h: 800, thumbhash: new Uint8Array([9, 8, 7]) },
    });
    expect(await getOutbox(alice)).toEqual([stored]);
  });

  test("old rows and corrupt media read as text-only posts, never as garbage", async () => {
    const store = await rawStore();
    try {
      await store.put(`posts:${A} alice:10`, {
        "90": { seq: 90, ts: 900, author: 1, scope: 10, text: "old", parent: 0 },
        "91": {
          seq: 91,
          ts: 901,
          author: 1,
          scope: 10,
          text: "bad",
          parent: 0,
          media: { id: "nine", w: 10, h: 10, thumbhash: [] },
        },
      });
    } finally {
      store.close();
    }
    expect((await getPosts(alice, 10)).map((post) => post.media)).toEqual([null, null]);
  });

  test("reaction counts resync without double-counting and keep the latest toggle", async () => {
    const bobOn: Event = {
      tag: Tag.Reaction,
      seq: 51,
      ts: 500,
      author: 2,
      scope: 10,
      target: 40,
      emoji: 2,
      on: true,
    };
    const carolOn: Event = { ...bobOn, seq: 52, ts: 501, author: 3 };
    await applyEvents(alice, [bobOn, carolOn]);

    let rows = await getReactions(alice, 10);
    expect(tallyReactions(rows, 2).get(40)).toEqual([{ emoji: 2, count: 2, mine: true }]);
    expect(tallyReactions(rows, 4).get(40)).toEqual([{ emoji: 2, count: 2, mine: false }]);

    // A resync may resend the same events; counts must not grow.
    await applyEvents(alice, [bobOn, carolOn]);
    rows = await getReactions(alice, 10);
    expect(tallyReactions(rows, 2).get(40)).toEqual([{ emoji: 2, count: 2, mine: true }]);

    // Bob toggles off, then an old snapshot replays his "on": off still wins.
    await applyEvents(alice, [{ ...bobOn, seq: 53, ts: 502, on: false }]);
    await applyEvents(alice, [bobOn]);
    rows = await getReactions(alice, 10);
    expect(tallyReactions(rows, 2).get(40)).toEqual([{ emoji: 2, count: 1, mine: false }]);
  });

  test("the next reaction tap counts a still-pending outbox row", async () => {
    expect(await nextReactionOn(alice, 10, 40, 2, 2)).toBe(true);
    await enqueueOp(alice, { tag: Tag.Reaction, scope: 10, target: 40, emoji: 2, on: true });
    // The "on" op has no ack yet, so a second tap must send "off".
    expect(await nextReactionOn(alice, 10, 40, 2, 2)).toBe(false);
    await enqueueOp(alice, { tag: Tag.Reaction, scope: 10, target: 40, emoji: 2, on: false });
    expect(await nextReactionOn(alice, 10, 40, 2, 2)).toBe(true);
  });

  test("a reaction row from before this shell reads as absent, never as garbage", async () => {
    const store = await rawStore();
    try {
      await store.put(`reactions:${A} alice:10`, { "40:2:2": { scope: 10, target: 40, emoji: 9, user: 2, on: true, seq: 1 } });
    } finally {
      store.close();
    }
    expect(await getReactions(alice, 10)).toEqual([]);
  });

  test("scope_left with purge drops the cached posts and members", async () => {
    await applyEvents(alice, [
      { tag: Tag.GroupMeta, seq: 30, ts: 300, author: 1, scope: 30, name: "Gone", about: "", open: false },
      { tag: Tag.Membership, seq: 31, ts: 301, author: 1, scope: 30, user: 1, role: Role.Owner },
      { tag: Tag.Post, seq: 32, ts: 302, author: 1, scope: 30, text: "bye", media: null },
      { tag: Tag.Reaction, seq: 33, ts: 303, author: 1, scope: 30, target: 32, emoji: 0, on: true },
    ]);
    await applyEvents(alice, [{ tag: Tag.ScopeLeft, seq: 34, ts: 304, author: 0, scope: 30, purge: true }]);
    expect(await getPosts(alice, 30)).toEqual([]);
    expect(await getMembers(alice, 30)).toEqual([]);
    expect(await getReactions(alice, 30)).toEqual([]);
    expect(await getGroups(alice)).toEqual([]);
  });

  test("a group ban removes the member and records the ban", async () => {
    await applyEvents(alice, [
      { tag: Tag.GroupMeta, seq: 50, ts: 500, author: 1, scope: 50, name: "G", about: "", open: true },
      { tag: Tag.Membership, seq: 51, ts: 501, author: 1, scope: 50, user: 1, role: Role.Owner },
      { tag: Tag.Membership, seq: 52, ts: 502, author: 2, scope: 50, user: 2, role: Role.Member },
      { tag: Tag.Ban, seq: 53, ts: 503, author: 1, scope: 50, user: 2, on: true },
    ]);
    expect(await getMembers(alice, 50)).toEqual([{ group: 50, user: 1, role: Role.Owner, seq: 51 }]);
    expect(await getBans(alice, 50)).toEqual([{ group: 50, user: 2, banned: true, seq: 53 }]);

    // Unban keeps the row but no longer lists the account as banned.
    await applyEvents(alice, [{ tag: Tag.Ban, seq: 54, ts: 504, author: 1, scope: 50, user: 2, on: false }]);
    expect(await getBans(alice, 50)).toEqual([]);
  });

  test("a ban's scope_left purge clears the banned client's posts and group cache", async () => {
    await applyEvents(alice, [
      { tag: Tag.GroupMeta, seq: 60, ts: 600, author: 1, scope: 60, name: "Gone", about: "", open: false },
      { tag: Tag.Membership, seq: 61, ts: 601, author: 2, scope: 60, user: 2, role: Role.Owner },
      { tag: Tag.Post, seq: 62, ts: 602, author: 2, scope: 60, text: "cached", media: null },
      { tag: Tag.Ban, seq: 63, ts: 603, author: 1, scope: 60, user: 2, on: true },
      { tag: Tag.ScopeLeft, seq: 64, ts: 604, author: 0, scope: 60, purge: true },
    ]);
    expect(await getPosts(alice, 60)).toEqual([]);
    expect(await getMembers(alice, 60)).toEqual([]);
    expect(await getBans(alice, 60)).toEqual([]);
    expect(await getGroups(alice)).toEqual([]);
  });

  test("a delete removes the target post and its reactions", async () => {
    await applyEvents(alice, [
      { tag: Tag.Post, seq: 70, ts: 700, author: 1, scope: 10, text: "parent", media: null },
      { tag: Tag.Reply, seq: 71, ts: 701, author: 2, scope: 10, parent: 70, text: "child", media: null },
      { tag: Tag.Reaction, seq: 72, ts: 702, author: 2, scope: 10, target: 70, emoji: 1, on: true },
      { tag: Tag.Reaction, seq: 73, ts: 703, author: 2, scope: 10, target: 71, emoji: 1, on: true },
      { tag: Tag.Delete, seq: 74, ts: 704, author: 1, scope: 10, target: 70 },
      { tag: Tag.Post, seq: 75, ts: 705, author: 1, scope: 10, text: "still here", media: null },
    ]);
    expect(await getPosts(alice, 10)).toEqual([
      { seq: 75, ts: 705, author: 1, scope: 10, text: "still here", parent: 0, media: null },
    ]);
    expect(await getReactions(alice, 10)).toEqual([]);
  });

  test("a delete_author marker is inert and its delete events clear that author's cache", async () => {
    await applyEvents(alice, [
      { tag: Tag.Post, seq: 80, ts: 800, author: 1, scope: 10, text: "keep", media: null },
      { tag: Tag.Post, seq: 81, ts: 801, author: 2, scope: 10, text: "purge me", media: null },
      { tag: Tag.Reply, seq: 82, ts: 802, author: 2, scope: 10, parent: 80, text: "and me", media: null },
      // The marker names the action but changes nothing by itself: an old client skips it.
      { tag: Tag.DeleteAuthor, seq: 83, ts: 803, author: 1, scope: 10, user: 2 },
    ]);
    expect(await getPosts(alice, 10)).toHaveLength(3);

    // These are the events every client already understands, old or new.
    await applyEvents(alice, [
      { tag: Tag.Delete, seq: 84, ts: 804, author: 1, scope: 10, target: 81 },
      { tag: Tag.Delete, seq: 85, ts: 805, author: 1, scope: 10, target: 82 },
    ]);
    expect(await getPosts(alice, 10)).toEqual([
      { seq: 80, ts: 800, author: 1, scope: 10, text: "keep", parent: 0, media: null },
    ]);
  });

  test("self is scoped to the account and rejected when it is not a positive uint", async () => {
    expect(await getSelf(alice)).toBeNull();
    await setSelf(alice, 7);
    expect(await getSelf(alice)).toBe(7);
    expect(await getSelf(bob)).toBeNull();
    expect(() => setSelf(alice, 0)).toThrow(RangeError);
  });

  test("outbox round-trips a cid and drops only the acknowledged op", async () => {
    const first = await enqueueOp(alice, { tag: Tag.GroupMeta, scope: 0, name: "G", about: "", open: true });
    const second = await enqueueOp(alice, { tag: Tag.Post, scope: 5, text: "hi" });
    const third = await enqueueOp(alice, {
      tag: Tag.Membership,
      scope: 5,
      user: 7,
      role: Role.Member,
      invite: "tok_123",
    });
    expect(first.cid).toHaveLength(8);
    expect((await getOutbox(alice)).map((op) => op.cid)).toEqual([first.cid, second.cid, third.cid]);
    // Another account on the same device has its own queue.
    expect(await getOutbox(bob)).toEqual([]);

    expect(toWireOp(first)).toMatchObject({ tag: Tag.GroupMeta, scope: 0, name: "G", open: true });
    expect(toWireOp(second)).toMatchObject({ tag: Tag.Post, scope: 5, text: "hi" });
    // The invite token survives a store round-trip and reaches the membership op.
    expect(toWireOp(third)).toEqual({
      cid: new Uint8Array(third.cid),
      tag: Tag.Membership,
      scope: 5,
      user: 7,
      role: Role.Member,
      invite: "tok_123",
    });

    await removeOutbox(alice, [new Uint8Array(first.cid)]);
    expect((await getOutbox(alice)).map((op) => op.cid)).toEqual([second.cid, third.cid]);
  });

  test("the event cache keeps 2,000 events per scope, the latest page, and a queued reply's parent", async () => {
    const reply = await enqueueOp(alice, { tag: Tag.Reply, scope: 10, parent: 50, text: "queued" });
    const posts: Event[] = Array.from({ length: 2100 }, (_, index) => ({
      tag: Tag.Post,
      seq: index + 1,
      ts: 1_000 + index,
      author: 1,
      scope: 10,
      text: `post ${index + 1}`,
      media: null,
    }));
    await applyEvents(alice, [
      ...posts,
      // A reaction to the oldest post leaves with the post in the same eviction pass.
      { tag: Tag.Reaction, seq: 2_101, ts: 9_999, author: 1, scope: 10, target: 1, emoji: 0, on: true },
    ]);

    const seqs = new Set((await getPosts(alice, 10)).map((post) => post.seq));
    expect(seqs.size).toBe(2000);
    // The pending reply's parent survives even though it is far outside the window.
    expect(seqs.has(50)).toBe(true);
    expect(seqs.has(101)).toBe(false);
    expect(seqs.has(102)).toBe(true);
    // The latest page is never evicted, so opening the group offline shows recent messages.
    for (let seq = 2001; seq <= 2100; seq++) expect(seqs.has(seq)).toBe(true);
    expect((await getOutbox(alice)).map((op) => op.cid)).toEqual([reply.cid]);

    // A reaction whose post left the cache in this pass is dropped with it.
    expect(await getReactions(alice, 10)).toEqual([]);
  });

  test("a page just fetched from /history stays visible even when the cache is full", async () => {
    const posts: Event[] = Array.from({ length: 2100 }, (_, index) => ({
      tag: Tag.Post,
      seq: 5_001 + index,
      ts: 5_001 + index,
      author: 1,
      scope: 10,
      text: `post ${index + 1}`,
      media: null,
    }));
    await applyEvents(alice, posts);

    // Exactly what /history returns next: 100 events older than the oldest cached seq.
    const older: Event[] = Array.from({ length: 100 }, (_, index) => ({
      tag: Tag.Post,
      seq: 4_901 + index,
      ts: 4_901 + index,
      author: 1,
      scope: 10,
      text: `older ${index + 1}`,
      media: null,
    }));
    await applyEvents(alice, older, { protectedSeqs: new Set(older.map((event) => event.seq)) });

    const seqs = new Set((await getPosts(alice, 10)).map((post) => post.seq));
    expect(seqs.size).toBe(2000);
    for (const event of older) expect(seqs.has(event.seq)).toBe(true);
    // The page was not bought just to be evicted by its own write.
    expect(seqs.has(5_001)).toBe(false);
  });

  test("the media cache is a durable 50 MB LRU, scoped per account", async () => {
    const size = 20 * 1024 * 1024;
    const bytes = (): Uint8Array => new Uint8Array(size);
    expect(MEDIA_CACHE_LIMIT_BYTES).toBe(50 * 1024 * 1024);

    await putMediaBytes("alice", 1, bytes(), 1_000);
    await putMediaBytes("alice", 2, bytes(), 2_000);
    await putMediaBytes("alice", 3, bytes(), 3_000);
    // 60 MB went in, so the least recently used image (id 1) left.
    expect(await mediaCacheBytes()).toBe(40 * 1024 * 1024);
    expect(await getMediaBytes("alice", 1, 3_500)).toBeNull();

    // Reading id 2 refreshes it; id 3 is now the oldest.
    expect((await getMediaBytes("alice", 2, 4_000))?.byteLength).toBe(size);
    await putMediaBytes("alice", 4, bytes(), 5_000);
    expect(await getMediaBytes("alice", 3, 6_000)).toBeNull();
    expect(await getMediaBytes("alice", 2, 6_000)).not.toBeNull();
    expect(await getMediaBytes("alice", 4, 6_000)).not.toBeNull();

    // Another account on the same device never reads this account's image bytes.
    expect(await getMediaBytes("bob", 2, 6_000)).toBeNull();
    // The LRU itself survives a restart.
    await closeStore();
    expect((await getMediaBytes("alice", 4, 7_000))?.byteLength).toBe(size);

    // Signing out drops this account's bytes without touching other owners.
    await putMediaBytes("bob", 9, new Uint8Array(10), 8_000);
    await clearMediaBytes("alice");
    expect(await getMediaBytes("alice", 4, 9_000)).toBeNull();
    expect((await getMediaBytes("bob", 9, 9_000))?.byteLength).toBe(10);
    await clearMediaBytes();
    expect(await mediaCacheBytes()).toBe(0);
  });

  test("a media index row without bytes reads as absent and stops counting toward the cap", async () => {
    const store = await rawStore();
    try {
      await store.put("media-index", [{ owner: "alice", id: 1, bytes: 10, used: 1 }]);
    } finally {
      store.close();
    }
    expect(await getMediaBytes("alice", 1)).toBeNull();
    expect(await mediaCacheBytes()).toBe(0);
  });

  test("a NotFound ack keeps the draft as failed, out of the next sync, until discarded", async () => {
    const reply = await enqueueOp(alice, { tag: Tag.Reply, scope: 5, parent: 9, text: "still worth saying" });
    const acked = await enqueueOp(alice, { tag: Tag.Post, scope: 5, text: "accepted" });

    const failed = await settleOutbox(alice, [
      { cid: new Uint8Array(reply.cid), error: AckError.NotFound },
      { cid: new Uint8Array(acked.cid), seq: 10 },
    ]);

    expect(failed.map((op) => op.cid)).toEqual([reply.cid]);
    expect(failed[0]).toMatchObject({ failed: AckError.NotFound, text: "still worth saying" });
    // Only the still-unsent op goes back on the wire; a dead reply must not block the queue.
    expect((await getPendingOps(alice)).map((op) => op.cid)).toEqual([]);
    expect((await getFailedOps(alice)).map((op) => op.text)).toEqual(["still worth saying"]);

    // The failure survives a restart with its text, so the user can copy it later.
    await closeStore();
    expect((await getFailedOps(alice)).map((op) => op.text)).toEqual(["still worth saying"]);

    await discardOutbox(alice, reply.cid);
    expect(await getOutbox(alice)).toEqual([]);
  });

  test("a failed reaction never decides the next tap", async () => {
    const tap = await enqueueOp(alice, { tag: Tag.Reaction, scope: 10, target: 40, emoji: 2, on: true });
    await settleOutbox(alice, [{ cid: new Uint8Array(tap.cid), error: AckError.NotFound }]);
    // The failed "on" was never applied, so the next tap still asks for "on".
    expect(await nextReactionOn(alice, 10, 40, 2, 2)).toBe(true);
  });

  test("other nacks drop the op instead of keeping a failed row", async () => {
    const op = await enqueueOp(alice, { tag: Tag.Post, scope: 5, text: "too fast" });
    const failed = await settleOutbox(alice, [{ cid: new Uint8Array(op.cid), error: AckError.RateLimited }]);
    expect(failed).toEqual([]);
    expect(await getOutbox(alice)).toEqual([]);
  });

  test("the outbox round-trips a reply and a reaction toggle", async () => {
    const reply = await enqueueOp(alice, { tag: Tag.Reply, scope: 5, parent: 9, text: "re" });
    const reaction = await enqueueOp(alice, { tag: Tag.Reaction, scope: 5, target: 9, emoji: 7, on: false });
    expect(toWireOp(reply)).toMatchObject({ tag: Tag.Reply, scope: 5, parent: 9, text: "re", media: null });
    expect(toWireOp(reaction)).toMatchObject({ tag: Tag.Reaction, scope: 5, target: 9, emoji: 7, on: false });
    expect(new Uint8Array(toWireOp(reaction).cid)).toEqual(new Uint8Array(reaction.cid));
  });

  test("the outbox round-trips a delete and a ban", async () => {
    const remove = await enqueueOp(alice, { tag: Tag.Delete, scope: 5, target: 9 });
    const ban = await enqueueOp(alice, { tag: Tag.Ban, scope: 5, user: 2, on: true });
    expect(toWireOp(remove)).toMatchObject({ tag: Tag.Delete, scope: 5, target: 9 });
    expect(toWireOp(ban)).toMatchObject({ tag: Tag.Ban, scope: 5, user: 2, on: true });
    expect(new Uint8Array(toWireOp(ban).cid)).toEqual(new Uint8Array(ban.cid));
  });

  test("the outbox round-trips a bulk delete", async () => {
    const bulk = await enqueueOp(alice, { tag: Tag.DeleteAuthor, scope: 5, user: 2 });
    expect(toWireOp(bulk)).toEqual({
      cid: new Uint8Array(bulk.cid),
      tag: Tag.DeleteAuthor,
      scope: 5,
      user: 2,
    });
  });

  test("the month total round-trips and a corrupt row reads back as absent", async () => {
    expect(await getMeter(A)).toBeNull();
    await setMeter(A, { month: "2026-10", bytes: 4096 });
    expect(await getMeter(A)).toEqual({ month: "2026-10", bytes: 4096 });
    expect(await getMeter(B)).toBeNull();

    const store = await rawStore();
    try {
      await store.put(`meter:${A}`, { month: "October", bytes: -1 });
    } finally {
      store.close();
    }
    expect(await getMeter(A)).toBeNull();
  });

  test("a corrupt group row reads back as absent", async () => {
    const store = await rawStore();
    try {
      await store.put(`groups:${A} alice`, { "10": { id: "ten", seq: 10 } });
    } finally {
      store.close();
    }
    expect(await getGroups(alice)).toEqual([]);
  });
  test("a fresh device seeds the origin that served it, signed out", async () => {
    expect(await migrateLegacy(A)).toBe(true);
    expect(await listServers()).toEqual([{ id: A, name: "a.example", addedAt: expect.any(Number), session: null, invite: null }]);
    expect(await getActiveServerId()).toBe(A);
    expect(await getActiveAccount()).toBeNull();
    // Running again is a no-op, not a second entry.
    await ensureServer(A);
    expect(await listServers()).toHaveLength(1);
  });

  test("two servers keep separate accounts, cursors, outboxes and caches", async () => {
    await ensureServer(A);
    await ensureServer(B);
    const aliceB = { server: B, username: "alice" };
    await setSession(A, { token: "a".repeat(32), username: "alice" });
    await setSession(B, { token: "b".repeat(32), username: "alice" });
    await setActiveServer(B);
    expect(await getActiveAccount()).toEqual({ server: B, token: "b".repeat(32), username: "alice" });

    await setCursor(alice, 10);
    await setCursor(aliceB, 99);
    expect(await getCursor(alice)).toBe(10);
    expect(await getCursor(aliceB)).toBe(99);
    // Same username, same group id, different server: the caches must not merge.
    await applyEvents(alice, [{ tag: Tag.GroupMeta, seq: 10, ts: 1, author: 1, scope: 10, name: "A group", about: "", open: true }]);
    await applyEvents(aliceB, [{ tag: Tag.GroupMeta, seq: 10, ts: 1, author: 1, scope: 10, name: "B group", about: "", open: true }]);
    expect((await getGroups(alice))[0]?.name).toBe("A group");
    expect((await getGroups(aliceB))[0]?.name).toBe("B group");
    await enqueueOp(alice, { tag: Tag.Post, scope: 10, text: "on A" });
    expect(await getOutbox(alice)).toHaveLength(1);
    expect(await getOutbox(aliceB)).toHaveLength(0);
  });

  test("an invite is kept beside the server until sign-up or join consumes it", async () => {
    await ensureServer(B);
    expect(await getPendingInvite(B)).toBeNull();
    await setPendingInvite(B, { kind: "signup", token: "abcdefghijklmnopqrstuv" });
    expect(await getPendingInvite(B)).toEqual({ kind: "signup", token: "abcdefghijklmnopqrstuv" });
    await setPendingInvite(B, null);
    expect(await getPendingInvite(B)).toBeNull();
  });

  test("removing a server forgets its cache and account, and moves the pointer", async () => {
    await ensureServer(A);
    await ensureServer(B);
    await setActiveServer(B);
    const aliceB = { server: B, username: "alice" };
    await applyEvents(aliceB, [{ tag: Tag.GroupMeta, seq: 10, ts: 1, author: 1, scope: 10, name: "B group", about: "", open: true }]);
    await setSession(B, { token: "b".repeat(32), username: "alice" });
    await setCursor(aliceB, 7);
    await setMeter(B, { month: "2026-10", bytes: 99 });
    await setRange(B, { min: 1, max: 1 });

    await removeServer(B);
    expect(await listServers()).toEqual([{ id: A, name: "a.example", addedAt: expect.any(Number), session: null, invite: null }]);
    // The active pointer moves to the remaining server instead of dangling.
    expect(await getActiveServerId()).toBe(A);
    await ensureServer(B);
    expect(await getSession(B)).toBeNull();
    expect(await getGroups(aliceB)).toEqual([]);
    expect(await getStoredCursor(aliceB)).toBeNull();
    // The meter row and the cached range belong to the server and go with it.
    expect(await getMeter(B)).toBeNull();
    expect(await getRange(B)).toBeNull();
  });

  test("the single-server shell's session, cursor and cache move into the list", async () => {
    const legacy = await rawStore();
    try {
      await legacy.put("session", { token: "a".repeat(32), username: "alice" });
      await legacy.put("cursor:alice", 42);
      await legacy.put("outbox:alice", [{ cid: [1, 2, 3, 4, 5, 6, 7, 8], tag: Tag.Post, scope: 5, text: "queued" }]);
      await legacy.put("range", { min: 1, max: 1 });
      await legacy.put("meter", { month: "2026-10", bytes: 1234 });
      await legacy.put("profiles:alice", { "7": { user: 7, seq: 9, username: "alice", displayName: "Alice", bio: "" } });
    } finally {
      legacy.close();
    }

    expect(await migrateLegacy(A)).toBe(true);
    expect(await getSession(A)).toEqual({ token: "a".repeat(32), username: "alice" });
    expect(await getActiveAccount()).toEqual({ server: A, token: "a".repeat(32), username: "alice" });
    expect(await getCursor(alice)).toBe(42);
    expect((await getOutbox(alice))[0]?.text).toBe("queued");
    expect(await getRange(A)).toEqual({ min: 1, max: 1 });
    expect(await getMeter(A)).toEqual({ month: "2026-10", bytes: 1234 });
    expect((await getProfiles(alice)).get(7)?.displayName).toBe("Alice");
    // The old keys are gone, not merely shadowed.
    const store = await rawStore();
    try {
      await store.put("cursor:alice", 1);
    } finally {
      store.close();
    }
    expect(await getCursor(alice)).toBe(42);
  });

});
