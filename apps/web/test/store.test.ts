import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { Role, Tag, type Event } from "@brr-chat/protocol";
import {
  applyEvents,
  closeStore,
  enqueueOp,
  getCursor,
  getGroups,
  getMembers,
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
    expect(first.cid).toHaveLength(8);
    expect((await getOutbox("alice")).map((op) => op.cid)).toEqual([first.cid, second.cid]);
    // Another account on the same device has its own queue.
    expect(await getOutbox("bob")).toEqual([]);

    expect(toWireOp(first)).toMatchObject({ tag: Tag.GroupMeta, scope: 0, name: "G", open: true });
    expect(toWireOp(second)).toMatchObject({ tag: Tag.Post, scope: 5, text: "hi" });

    await removeOutbox("alice", [new Uint8Array(first.cid)]);
    expect((await getOutbox("alice")).map((op) => op.cid)).toEqual([second.cid]);
  });

  test("the outbox round-trips a reply and a reaction toggle", async () => {
    const reply = await enqueueOp("alice", { tag: Tag.Reply, scope: 5, parent: 9, text: "re" });
    const reaction = await enqueueOp("alice", { tag: Tag.Reaction, scope: 5, target: 9, emoji: 7, on: false });
    expect(toWireOp(reply)).toMatchObject({ tag: Tag.Reply, scope: 5, parent: 9, text: "re", media: null });
    expect(toWireOp(reaction)).toMatchObject({ tag: Tag.Reaction, scope: 5, target: 9, emoji: 7, on: false });
    expect(new Uint8Array(toWireOp(reaction).cid)).toEqual(new Uint8Array(reaction.cid));
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
