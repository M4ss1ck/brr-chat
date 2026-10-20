// Local persistence for the PWA. IndexedDB only: no localStorage, no cookies, and every
// write is small and versioned by the object store, so a shell update cannot lose the
// session (docs/PROTOCOL.md, app shell budget).
import type { VersionRange } from "@brr-chat/protocol";

const DB_NAME = "brr-chat";
const DB_VERSION = 1;
const STORE = "kv";

const KEY_CURSOR = "cursor";
const KEY_SESSION = "session";
const KEY_RANGE = "range";

export interface Session {
  /** Bare 32-char session token (ADR 0007). */
  token: string;
  username: string;
  /** True until the signup code's last group is typed back (ADR 0006). */
  recoveryPending?: boolean;
}

let dbHandle: Promise<IDBDatabase> | null = null;

function openStore(): Promise<IDBDatabase> {
  if (dbHandle) return dbHandle;
  dbHandle = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        dbHandle = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      dbHandle = null;
      reject(request.error ?? new Error("indexeddb: open failed"));
    };
    request.onblocked = () => {
      reject(new Error("indexeddb: open blocked by another tab"));
    };
  }).catch((err: unknown) => {
    dbHandle = null;
    throw err;
  });
  return dbHandle;
}

/** Drops the cached handle. Safe to call when nothing is open. */
export async function closeStore(): Promise<void> {
  const pending = dbHandle;
  dbHandle = null;
  if (!pending) return;
  try {
    (await pending).close();
  } catch {
    // An open that already failed has nothing to close.
  }
}

function read(key: string): Promise<unknown> {
  return openStore().then(
    (database) =>
      new Promise<unknown>((resolve, reject) => {
        const request = database.transaction(STORE, "readonly").objectStore(STORE).get(key);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error);
        };
      }),
  );
}

function write(key: string, value: unknown): Promise<void> {
  return openStore().then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error);
        };
      }),
  );
}

// ---- narrowers: a row written by an older or broken shell must read as absent ----

function asCursor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asSession(value: unknown): Session | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as { token?: unknown; username?: unknown; recoveryPending?: unknown };
  if (typeof row.token !== "string" || row.token.length === 0) return null;
  if (typeof row.username !== "string" || row.username.length === 0) return null;
  const session: Session = { token: row.token, username: row.username };
  if (row.recoveryPending === true) session.recoveryPending = true;
  return session;
}

function asRange(value: unknown): VersionRange | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as { min?: unknown; max?: unknown };
  if (typeof row.min !== "number" || !Number.isSafeInteger(row.min) || row.min <= 0) return null;
  if (typeof row.max !== "number" || !Number.isSafeInteger(row.max) || row.max <= 0) return null;
  return { min: row.min, max: row.max };
}

function assertCursor(value: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("cursor: expected a safe uint");
  }
}

// ---- cursor ----

/** Last applied seq, or null when this device has never synced. */
export async function getStoredCursor(): Promise<number | null> {
  return asCursor(await read(KEY_CURSOR));
}

/** Last applied seq; a fresh device is at 0. */
export async function getCursor(): Promise<number> {
  return (await getStoredCursor()) ?? 0;
}

export async function setCursor(value: number): Promise<void> {
  assertCursor(value);
  await write(KEY_CURSOR, value);
}

// ---- session ----

export async function getSession(): Promise<Session | null> {
  return asSession(await read(KEY_SESSION));
}

export async function setSession(session: Session | null): Promise<void> {
  await write(KEY_SESSION, session);
}

// ---- server version range ----

/** Cached [vMin, vMax], used to warn about updates before the server refuses the request. */
export async function getRange(): Promise<VersionRange | null> {
  return asRange(await read(KEY_RANGE));
}

export async function setRange(range: VersionRange): Promise<void> {
  await write(KEY_RANGE, range);
}
