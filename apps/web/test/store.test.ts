import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { closeStore, getCursor, getRange, getSession, getStoredCursor, setCursor, setRange, setSession } from "../src/store.ts";

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
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  afterEach(async () => {
    await closeStore();
  });

  test("empty store reads as cursor 0, stored null, no session, no range", async () => {
    expect(await getCursor()).toBe(0);
    expect(await getStoredCursor()).toBeNull();
    expect(await getSession()).toBeNull();
    expect(await getRange()).toBeNull();
  });

  test("cursor round-trips", async () => {
    await setCursor(0);
    expect(await getCursor()).toBe(0);
    await setCursor(4_000_000_000);
    expect(await getStoredCursor()).toBe(4_000_000_000);
    expect(await getCursor()).toBe(4_000_000_000);
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
    expect(() => setCursor(-1)).toThrow(RangeError);
    expect(() => setCursor(1.5)).toThrow(RangeError);
    expect(() => setCursor(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
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

    expect(await getStoredCursor()).toBeNull();
    expect(await getCursor()).toBe(0);
    expect(await getSession()).toBeNull();
    expect(await getRange()).toBeNull();
  });

  test("a closed handle reopens on the next call", async () => {
    await setCursor(7);
    await closeStore();
    expect(await getStoredCursor()).toBe(7);
  });

  test("writing after a close does not throw", async () => {
    await closeStore();
    await setCursor(9);
    expect(await getCursor()).toBe(9);
  });
});
