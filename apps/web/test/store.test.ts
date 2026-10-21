import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { Role, Tag, type Event } from "@brr-chat/protocol";
import {
  applyEvents,
  closeStore,
  enqueueOp,
  getBans,
  getCursor,
  getDmMessages,
  getDmScopes,
  getGroups,
  getMembers,
  getMeter,
  getOutbox,
  getPosts,
  getProfiles,
  getRange,
  getReactions,
  getSelf,
  getSession,
  getStoredCursor,
  nextReactionOn,
  removeOutbox,
  setCursor,
  setMeter,
  setRange,
  setSelf,
  setSession,
  tallyReactions,
  toWireOp,
} from "../src/store.ts";

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
    expect(await getCursor("alice")).toBe(0);
    expect(await getStoredCursor("alice")).toBeNull();
    expect(await getSession()).toBeNull();
    expect(await getRange()).toBeNull();
  });

  test("cursor round-trips", async () => {
    await setCursor("alice", 0);
    expect(await getCursor("alice")).toBe(0);
    await setCursor("alice", 4_000_000_000);
    expect(await getStoredCursor("alice")).toBe(4_000_000_000);
    expect(await getCursor("alice")).toBe(4_000_000_000);
  });

  test("session round-trips and clears with null", async () => {
    await setSession({ token: "a".repeat(32), username: "alice" });
    expect(await getSession()).toEqual({ token: "a".repeat(32), username: "alice" });
    await setSession(null);
    expect(await getSession()).toBeNull();
  });

  test("server range round-trips", async () => {
    await setRange({ min: 1, max: 1 });
    expect(await getRange()).toEqual({ min: 1, max: 1 });
    await setRange({ min: 1, max: 2 });
    expect(await getRange()).toEqual({ min: 1, max: 2 });
  });

  test("setCursor rejects values that are not safe integers", async () => {
    expect(() => setCursor("alice", -1)).toThrow(RangeError);
    expect(() => setCursor("alice", 1.5)).toThrow(RangeError);
    expect(() => setCursor("alice", Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  test("a corrupt row reads back as not stored, never as garbage", async () => {
    const store = await rawStore();
    try {
      await store.put("cursor", "many");
      await store.put("session", { token: 12 });
      await store.put("range", { min: "1", max: 1 });
    } finally {
      store.close();
    }

    expect(await getStoredCursor("alice")).toBeNull();
    expect(await getCursor("alice")).toBe(0);
    expect(await getSession()).toBeNull();
    expect(await getRange()).toBeNull();
  });

  test("a closed handle reopens on the next call", async () => {
    await setCursor("alice", 7);
    await closeStore();
    expect(await getStoredCursor("alice")).toBe(7);
  });

  test("writing after a close does not throw", async () => {
    await closeStore();
    await setCursor("alice", 9);
    expect(await getCursor("alice")).toBe(9);
  });

  test("sync events build group, member, post and profile state", async () => {
    const events: Event[] = [
      { tag: Tag.GroupMeta, seq: 10, ts: 100, author: 1, scope: 10, name: "Habana", about: "abierto", open: true },
      { tag: Tag.Membership, seq: 11, ts: 101, author: 1, scope: 10, user: 1, role: Role.Owner },
      { tag: Tag.Membership, seq: 12, ts: 102, author: 2, scope: 10, user: 2, role: Role.Member },
      { tag: Tag.Post, seq: 13, ts: 103, author: 1, scope: 10, text: "hola", media: null },
      { tag: Tag.Profile, seq: 14, ts: 104, author: 1, scope: 0, username: "ana", displayName: "Ana", bio: "" },
    ];
    await applyEvents("alice", events);

    expect(await getGroups("alice")).toEqual([{ id: 10, seq: 10, name: "Habana", about: "abierto", open: true }]);
    expect(await getMembers("alice", 10)).toEqual([
      { group: 10, user: 1, role: Role.Owner, seq: 11 },
      { group: 10, user: 2, role: Role.Member, seq: 12 },
    ]);
    expect(await getPosts("alice", 10)).toEqual([{ seq: 13, ts: 103, author: 1, scope: 10, text: "hola", parent: 0 }]);
    expect((await getProfiles("alice")).get(1)).toEqual({
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
    await applyEvents("alice", events);

    expect(await getDmScopes("alice")).toEqual([{ id: 40, seq: 40, a: 1, b: 2 }]);
    expect(await getDmMessages("alice", 40)).toEqual([
      { seq: 41, ts: 401, author: 1, scope: 40, text: "hola", parent: 0 },
      { seq: 42, ts: 402, author: 2, scope: 40, text: "te oigo", parent: 0 },
    ]);
    // No session, no network: a reopened store still renders the conversation.
    await closeStore();
    expect(await getDmScopes("alice")).toHaveLength(1);
    expect((await getDmMessages("alice", 40)).map((message) => message.text)).toEqual(["hola", "te oigo"]);
    // Another account on the same device never sees this conversation.
    expect(await getDmScopes("bob")).toEqual([]);

    // Losing access purges the conversation and its messages, like a group.
    await applyEvents("alice", [{ tag: Tag.ScopeLeft, seq: 44, ts: 404, author: 0, scope: 40, purge: true }]);
    expect(await getDmScopes("alice")).toEqual([]);
    expect(await getDmMessages("alice", 40)).toEqual([]);
  });

  test("a block event drops the blocked author's cached posts and reactions", async () => {
    await applyEvents("alice", [
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

    await applyEvents("alice", [{ tag: Tag.Block, seq: 50, ts: 500, author: 1, scope: 0, user: 2, on: true }]);

    expect((await getPosts("alice", 10)).map((post) => post.author)).toEqual([1]);
    expect(await getReactions("alice", 10)).toEqual([]);
    expect((await getDmMessages("alice", 40)).map((message) => message.author)).toEqual([1]);
    // The block hides content, not the group, its members, or the conversation itself.
    expect((await getGroups("alice")).map((group) => group.id)).toEqual([10]);
    expect(await getMembers("alice", 10)).toHaveLength(2);
    expect(await getDmScopes("alice")).toHaveLength(1);
  });

  test("a dm op round-trips through the outbox with its peer", async () => {
    const stored = await enqueueOp("alice", { tag: Tag.Dm, scope: 0, peer: 2, text: "first" });
    expect(stored).toMatchObject({ tag: Tag.Dm, scope: 0, peer: 2, text: "first" });
    expect(toWireOp(stored)).toEqual({
      cid: new Uint8Array(stored.cid),
      tag: Tag.Dm,
      scope: 0,
      peer: 2,
      text: "first",
      media: null,
    });
    expect(await getOutbox("alice")).toEqual([stored]);
  });

  test("a block op round-trips through the outbox", async () => {
    const stored = await enqueueOp("alice", { tag: Tag.Block, scope: 0, user: 2, on: true });
    expect(toWireOp(stored)).toEqual({
      cid: new Uint8Array(stored.cid),
      tag: Tag.Block,
      scope: 0,
      user: 2,
      on: true,
    });
    expect(await getOutbox("alice")).toEqual([stored]);
  });

  test("applying the same state event twice never duplicates a post", async () => {
    const post: Event = { tag: Tag.Post, seq: 21, ts: 200, author: 1, scope: 20, text: "once", media: null };
    await applyEvents("alice", [post]);
    await applyEvents("alice", [post]);
    expect(await getPosts("alice", 20)).toHaveLength(1);
  });

  test("replies are cached next to their post with a parent", async () => {
    await applyEvents("alice", [
      { tag: Tag.Post, seq: 40, ts: 400, author: 1, scope: 10, text: "parent", media: null },
      { tag: Tag.Reply, seq: 41, ts: 401, author: 2, scope: 10, parent: 40, text: "child", media: null },
    ]);
    expect(await getPosts("alice", 10)).toEqual([
      { seq: 40, ts: 400, author: 1, scope: 10, text: "parent", parent: 0 },
      { seq: 41, ts: 401, author: 2, scope: 10, text: "child", parent: 40 },
    ]);
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
    await applyEvents("alice", [bobOn, carolOn]);

    let rows = await getReactions("alice", 10);
    expect(tallyReactions(rows, 2).get(40)).toEqual([{ emoji: 2, count: 2, mine: true }]);
    expect(tallyReactions(rows, 4).get(40)).toEqual([{ emoji: 2, count: 2, mine: false }]);

    // A resync may resend the same events; counts must not grow.
    await applyEvents("alice", [bobOn, carolOn]);
    rows = await getReactions("alice", 10);
    expect(tallyReactions(rows, 2).get(40)).toEqual([{ emoji: 2, count: 2, mine: true }]);

    // Bob toggles off, then an old snapshot replays his "on": off still wins.
    await applyEvents("alice", [{ ...bobOn, seq: 53, ts: 502, on: false }]);
    await applyEvents("alice", [bobOn]);
    rows = await getReactions("alice", 10);
    expect(tallyReactions(rows, 2).get(40)).toEqual([{ emoji: 2, count: 1, mine: false }]);
  });

  test("the next reaction tap counts a still-pending outbox row", async () => {
    expect(await nextReactionOn("alice", 10, 40, 2, 2)).toBe(true);
    await enqueueOp("alice", { tag: Tag.Reaction, scope: 10, target: 40, emoji: 2, on: true });
    // The "on" op has no ack yet, so a second tap must send "off".
    expect(await nextReactionOn("alice", 10, 40, 2, 2)).toBe(false);
    await enqueueOp("alice", { tag: Tag.Reaction, scope: 10, target: 40, emoji: 2, on: false });
    expect(await nextReactionOn("alice", 10, 40, 2, 2)).toBe(true);
  });

  test("a reaction row from before this shell reads as absent, never as garbage", async () => {
    const store = await rawStore();
    try {
      await store.put("reactions:alice", { "40:2:2": { scope: 10, target: 40, emoji: 9, user: 2, on: true, seq: 1 } });
    } finally {
      store.close();
    }
    expect(await getReactions("alice", 10)).toEqual([]);
  });

  test("scope_left with purge drops the cached posts and members", async () => {
    await applyEvents("alice", [
      { tag: Tag.GroupMeta, seq: 30, ts: 300, author: 1, scope: 30, name: "Gone", about: "", open: false },
      { tag: Tag.Membership, seq: 31, ts: 301, author: 1, scope: 30, user: 1, role: Role.Owner },
      { tag: Tag.Post, seq: 32, ts: 302, author: 1, scope: 30, text: "bye", media: null },
      { tag: Tag.Reaction, seq: 33, ts: 303, author: 1, scope: 30, target: 32, emoji: 0, on: true },
    ]);
    await applyEvents("alice", [{ tag: Tag.ScopeLeft, seq: 34, ts: 304, author: 0, scope: 30, purge: true }]);
    expect(await getPosts("alice", 30)).toEqual([]);
    expect(await getMembers("alice", 30)).toEqual([]);
    expect(await getReactions("alice", 30)).toEqual([]);
    expect(await getGroups("alice")).toEqual([]);
  });

  test("a group ban removes the member and records the ban", async () => {
    await applyEvents("alice", [
      { tag: Tag.GroupMeta, seq: 50, ts: 500, author: 1, scope: 50, name: "G", about: "", open: true },
      { tag: Tag.Membership, seq: 51, ts: 501, author: 1, scope: 50, user: 1, role: Role.Owner },
      { tag: Tag.Membership, seq: 52, ts: 502, author: 2, scope: 50, user: 2, role: Role.Member },
      { tag: Tag.Ban, seq: 53, ts: 503, author: 1, scope: 50, user: 2, on: true },
    ]);
    expect(await getMembers("alice", 50)).toEqual([{ group: 50, user: 1, role: Role.Owner, seq: 51 }]);
    expect(await getBans("alice", 50)).toEqual([{ group: 50, user: 2, banned: true, seq: 53 }]);

    // Unban keeps the row but no longer lists the account as banned.
    await applyEvents("alice", [{ tag: Tag.Ban, seq: 54, ts: 504, author: 1, scope: 50, user: 2, on: false }]);
    expect(await getBans("alice", 50)).toEqual([]);
  });

  test("a ban's scope_left purge clears the banned client's posts and group cache", async () => {
    await applyEvents("alice", [
      { tag: Tag.GroupMeta, seq: 60, ts: 600, author: 1, scope: 60, name: "Gone", about: "", open: false },
      { tag: Tag.Membership, seq: 61, ts: 601, author: 2, scope: 60, user: 2, role: Role.Owner },
      { tag: Tag.Post, seq: 62, ts: 602, author: 2, scope: 60, text: "cached", media: null },
      { tag: Tag.Ban, seq: 63, ts: 603, author: 1, scope: 60, user: 2, on: true },
      { tag: Tag.ScopeLeft, seq: 64, ts: 604, author: 0, scope: 60, purge: true },
    ]);
    expect(await getPosts("alice", 60)).toEqual([]);
    expect(await getMembers("alice", 60)).toEqual([]);
    expect(await getBans("alice", 60)).toEqual([]);
    expect(await getGroups("alice")).toEqual([]);
  });

  test("a delete removes the target post and its reactions", async () => {
    await applyEvents("alice", [
      { tag: Tag.Post, seq: 70, ts: 700, author: 1, scope: 10, text: "parent", media: null },
      { tag: Tag.Reply, seq: 71, ts: 701, author: 2, scope: 10, parent: 70, text: "child", media: null },
      { tag: Tag.Reaction, seq: 72, ts: 702, author: 2, scope: 10, target: 70, emoji: 1, on: true },
      { tag: Tag.Reaction, seq: 73, ts: 703, author: 2, scope: 10, target: 71, emoji: 1, on: true },
      { tag: Tag.Delete, seq: 74, ts: 704, author: 1, scope: 10, target: 70 },
      { tag: Tag.Post, seq: 75, ts: 705, author: 1, scope: 10, text: "still here", media: null },
    ]);
    expect(await getPosts("alice", 10)).toEqual([
      { seq: 75, ts: 705, author: 1, scope: 10, text: "still here", parent: 0 },
    ]);
    expect(await getReactions("alice", 10)).toEqual([]);
  });

  test("self is scoped to the account and rejected when it is not a positive uint", async () => {
    expect(await getSelf("alice")).toBeNull();
    await setSelf("alice", 7);
    expect(await getSelf("alice")).toBe(7);
    expect(await getSelf("bob")).toBeNull();
    expect(() => setSelf("alice", 0)).toThrow(RangeError);
  });

  test("outbox round-trips a cid and drops only the acknowledged op", async () => {
    const first = await enqueueOp("alice", { tag: Tag.GroupMeta, scope: 0, name: "G", about: "", open: true });
    const second = await enqueueOp("alice", { tag: Tag.Post, scope: 5, text: "hi" });
    const third = await enqueueOp("alice", {
      tag: Tag.Membership,
      scope: 5,
      user: 7,
      role: Role.Member,
      invite: "tok_123",
    });
    expect(first.cid).toHaveLength(8);
    expect((await getOutbox("alice")).map((op) => op.cid)).toEqual([first.cid, second.cid, third.cid]);
    // Another account on the same device has its own queue.
    expect(await getOutbox("bob")).toEqual([]);

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

    await removeOutbox("alice", [new Uint8Array(first.cid)]);
    expect((await getOutbox("alice")).map((op) => op.cid)).toEqual([second.cid, third.cid]);
  });

  test("the outbox round-trips a reply and a reaction toggle", async () => {
    const reply = await enqueueOp("alice", { tag: Tag.Reply, scope: 5, parent: 9, text: "re" });
    const reaction = await enqueueOp("alice", { tag: Tag.Reaction, scope: 5, target: 9, emoji: 7, on: false });
    expect(toWireOp(reply)).toMatchObject({ tag: Tag.Reply, scope: 5, parent: 9, text: "re", media: null });
    expect(toWireOp(reaction)).toMatchObject({ tag: Tag.Reaction, scope: 5, target: 9, emoji: 7, on: false });
    expect(new Uint8Array(toWireOp(reaction).cid)).toEqual(new Uint8Array(reaction.cid));
  });

  test("the outbox round-trips a delete and a ban", async () => {
    const remove = await enqueueOp("alice", { tag: Tag.Delete, scope: 5, target: 9 });
    const ban = await enqueueOp("alice", { tag: Tag.Ban, scope: 5, user: 2, on: true });
    expect(toWireOp(remove)).toMatchObject({ tag: Tag.Delete, scope: 5, target: 9 });
    expect(toWireOp(ban)).toMatchObject({ tag: Tag.Ban, scope: 5, user: 2, on: true });
    expect(new Uint8Array(toWireOp(ban).cid)).toEqual(new Uint8Array(ban.cid));
  });

  test("the month total round-trips and a corrupt row reads back as absent", async () => {
    expect(await getMeter()).toBeNull();
    await setMeter({ month: "2026-10", bytes: 4096 });
    expect(await getMeter()).toEqual({ month: "2026-10", bytes: 4096 });

    const store = await rawStore();
    try {
      await store.put("meter", { month: "October", bytes: -1 });
    } finally {
      store.close();
    }
    expect(await getMeter()).toBeNull();
  });

  test("a corrupt group row reads back as absent", async () => {
    const store = await rawStore();
    try {
      await store.put("groups:alice", { "10": { id: "ten", seq: 10 } });
    } finally {
      store.close();
    }
    expect(await getGroups("alice")).toEqual([]);
  });
});
