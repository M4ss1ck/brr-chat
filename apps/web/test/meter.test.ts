// Data meter (ADR 0018): actual bytes for request and response, a local calendar month that
// rolls over, and a monthly total that survives a reload while the session total does not.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  DataMeter,
  forgetServerMeter,
  formatBytes,
  migrateLegacyMeterSession,
  requestWireBytes,
  responseWireBytes,
  type MeterStorage,
} from "../src/meter.ts";
import { monthOf } from "../src/month.ts";
import type { StoredMeter } from "../src/store.ts";

/** One server unless a test names more; `row`/`session` stay the first server's counters. */
const DEFAULT_SERVER = "http://chat.local";

type TestStorage = MeterStorage & {
  servers: string[];
  rows: Map<string, StoredMeter>;
  sessions: Map<string, number>;
  readonly row: StoredMeter | null;
  readonly session: number;
};

function memoryStorage(
  initialMonth: StoredMeter | null = null,
  initialSession = 0,
  servers: string[] = [DEFAULT_SERVER],
): TestStorage {
  const rows = new Map<string, StoredMeter>();
  if (initialMonth !== null) rows.set(DEFAULT_SERVER, { ...initialMonth });
  const sessions = new Map<string, number>();
  if (initialSession > 0) sessions.set(DEFAULT_SERVER, initialSession);
  const storage: TestStorage = {
    servers: [...servers],
    rows,
    sessions,
    get row(): StoredMeter | null {
      return rows.get(DEFAULT_SERVER) ?? null;
    },
    get session(): number {
      return sessions.get(DEFAULT_SERVER) ?? 0;
    },
    async readServers(): Promise<string[]> {
      return [...storage.servers];
    },
    async readMonth(server: string): Promise<StoredMeter | null> {
      const row = rows.get(server);
      return row === undefined ? null : { ...row };
    },
    async writeMonth(server: string, row: StoredMeter): Promise<void> {
      rows.set(server, { ...row });
    },
    readSession(server: string): number {
      return sessions.get(server) ?? 0;
    },
    writeSession(server: string, bytes: number): void {
      sessions.set(server, bytes);
    },
  };
  return storage;
}

function fixedFetch(body = "ok", headers: Record<string, string> = { "Content-Type": "text/plain", "Content-Length": "2" }) {
  const calls: Request[] = [];
  return {
    calls,
    async fetch(input: RequestInfo | URL): Promise<Response> {
      calls.push(input as Request);
      return new Response(body, { status: 200, statusText: "OK", headers });
    },
  };
}

describe("data meter", () => {
  test("every app API call goes through the meter, so a new endpoint cannot skip it", () => {
    const src = resolve(import.meta.dir, "..", "src");
    // sw.ts fetches the shell from its own cache; those assets are not app traffic.
    const modules = readdirSync(src).filter((file) => file.endsWith(".ts") && file !== "sw.ts" && file !== "meter.ts");
    expect(modules.length).toBeGreaterThan(0);
    for (const file of modules) {
      const source = readFileSync(resolve(src, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
  });

  test("months are the device's local calendar month", () => {
    expect(monthOf(new Date(2026, 0, 1))).toBe("2026-01");
    expect(monthOf(new Date(2026, 9, 20))).toBe("2026-10");
    expect(monthOf(new Date(2026, 11, 31, 23, 59))).toBe("2026-12");
  });

  test("formatBytes crosses each unit once and never shows a fraction of a byte", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  test("a request counts its request line, every header and its body", () => {
    const plain = requestWireBytes({
      method: "POST",
      url: "http://chat.local/sync",
      headers: new Headers({ "Content-Type": "application/cbor" }),
      bodyBytes: 10,
    });
    const authorized = requestWireBytes({
      method: "POST",
      url: "http://chat.local/sync",
      headers: new Headers({
        "Content-Type": "application/cbor",
        Authorization: `Bearer ${"a".repeat(32)}`,
      }),
      bodyBytes: 10,
    });
    const authLine = `authorization: Bearer ${"a".repeat(32)}\r\n`;
    expect(authorized - plain).toBe(Buffer.byteLength(authLine));
    // Host and Content-Length are sent by fetch even though the caller did not set them.
    expect(plain).toBe(
      Buffer.byteLength("POST /sync HTTP/1.1\r\n") +
        Buffer.byteLength("content-type: application/cbor\r\n") +
        Buffer.byteLength("host: chat.local\r\n") +
        Buffer.byteLength("content-length: 10\r\n") +
        2 +
        10,
    );
    // A bodyless POST still carries Content-Length: 0.
    expect(
      requestWireBytes({ method: "POST", url: "http://chat.local/api/auth/sign-out", headers: new Headers(), bodyBytes: 0 }),
    ).toBe(
      Buffer.byteLength("POST /api/auth/sign-out HTTP/1.1\r\n") +
        Buffer.byteLength("host: chat.local\r\n") +
        Buffer.byteLength("content-length: 0\r\n") +
        2,
    );
  });

  test("a response counts Content-Length, not the decompressed body", () => {
    const compressed = responseWireBytes({
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Encoding": "br", "Content-Length": "20" }),
      bodyBytes: 20,
    });
    const inflated = responseWireBytes({
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Encoding": "br", "Content-Length": "20" }),
      bodyBytes: 200,
    });
    expect(compressed).toBeLessThan(inflated);
    expect(compressed).toBe(
      Buffer.byteLength("HTTP/1.1 200 OK\r\n") +
        Buffer.byteLength("content-encoding: br\r\n") +
        Buffer.byteLength("content-length: 20\r\n") +
        2 +
        20,
    );
  });

  test("metered fetch counts both directions and feeds the session and month totals", async () => {
    const storage = memoryStorage();
    let now = new Date(2026, 9, 20, 12, 0);
    const fake = fixedFetch();
    const meter = new DataMeter(storage, () => now, fake.fetch);

    const body = JSON.stringify({ username: "alice", password: "password1234" });
    const response = await meter.fetch("http://chat.local/api/auth/sign-in/username", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
    expect(await response.text()).toBe("ok");
    await meter.flush();

    const sent = requestWireBytes({
      method: "POST",
      url: "http://chat.local/api/auth/sign-in/username",
      headers: new Headers({ "Content-Type": "application/json", Accept: "application/json" }),
      bodyBytes: Buffer.byteLength(body),
    });
    const received = responseWireBytes({
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "text/plain", "Content-Length": "2" }),
      bodyBytes: 2,
    });
    expect(meter.totals()).toEqual({ sessionBytes: sent + received, monthBytes: sent + received, monthKey: "2026-10" });
    expect(storage.row).toEqual({ month: "2026-10", bytes: sent + received });
  });

  test("both totals survive a reload, because a reload does not end the tab session", async () => {
    const storage = memoryStorage();
    let now = new Date(2026, 9, 20, 12, 0);
    const first = new DataMeter(storage, () => now, fixedFetch().fetch);
    await first.fetch("http://chat.local/sync", { method: "POST", body: new Uint8Array(8) });
    await first.flush();
    const spent = first.totals().monthBytes;
    expect(spent).toBeGreaterThan(0);

    // A reload builds a new meter over the same tab storage: both totals resume.
    now = new Date(2026, 9, 20, 13, 0);
    const reloaded = new DataMeter(storage, () => now, fixedFetch().fetch);
    await reloaded.load();
    expect(reloaded.totals()).toEqual({ sessionBytes: spent, monthBytes: spent, monthKey: "2026-10" });
  });

  test("a new tab starts a new session but inherits the month", async () => {
    const firstTab = memoryStorage();
    let now = new Date(2026, 9, 20, 12, 0);
    const first = new DataMeter(firstTab, () => now, fixedFetch().fetch);
    await first.fetch("http://chat.local/sync", { method: "POST", body: new Uint8Array(8) });
    await first.flush();
    const spent = first.totals().monthBytes;

    // A second tab shares IndexedDB but has its own sessionStorage.
    const nextTab = memoryStorage(firstTab.row, 0);
    now = new Date(2026, 9, 20, 13, 0);
    const meter = new DataMeter(nextTab, () => now, fixedFetch().fetch);
    await meter.load();
    expect(meter.totals()).toEqual({ sessionBytes: 0, monthBytes: spent, monthKey: "2026-10" });
  });

  test("the month rolls over on the local calendar and writes the new month", async () => {
    const storage = memoryStorage({ month: "2026-10", bytes: 5000 });
    let now = new Date(2026, 9, 31, 23, 59);
    const meter = new DataMeter(storage, () => now, fixedFetch().fetch);
    await meter.load();
    expect(meter.totals()).toEqual({ sessionBytes: 0, monthBytes: 5000, monthKey: "2026-10" });

    now = new Date(2026, 10, 1, 0, 1);
    await meter.load();
    expect(meter.totals()).toEqual({ sessionBytes: 0, monthBytes: 0, monthKey: "2026-11" });
    await meter.flush();
    expect(storage.row).toEqual({ month: "2026-11", bytes: 0 });

    await meter.fetch("http://chat.local/sync", { method: "POST", body: new Uint8Array(1) });
    await meter.flush();
    expect(meter.totals().monthKey).toBe("2026-11");
    expect(meter.totals().monthBytes).toBeGreaterThan(0);
    expect(storage.row?.month).toBe("2026-11");
  });

  test("a stored month that is not the current month is discarded, not added to", async () => {
    const storage = memoryStorage({ month: "2026-08", bytes: 9000 });
    const meter = new DataMeter(storage, () => new Date(2026, 9, 20), fixedFetch().fetch);
    await meter.load();
    expect(meter.totals().monthBytes).toBe(0);
    await meter.flush();
    expect(storage.row).toEqual({ month: "2026-10", bytes: 0 });
  });

  test("metered fetch counts a Request object's body when there is no init to inspect", async () => {
    const storage = memoryStorage();
    const meter = new DataMeter(storage, () => new Date(2026, 9, 20), fixedFetch().fetch);
    const request = new Request("http://chat.local/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    await meter.fetch(request);
    await meter.flush();

    const sent = requestWireBytes({
      method: "POST",
      url: request.url,
      headers: request.headers,
      bodyBytes: 7,
    });
    const received = responseWireBytes({
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "text/plain", "Content-Length": "2" }),
      bodyBytes: 2,
    });
    expect(meter.totals().sessionBytes).toBe(sent + received);
  });

  test("a bodyless response does not bill the Content-Length it never sent", async () => {
    const storage = memoryStorage();
    const meter = new DataMeter(storage, () => new Date(2026, 9, 20), async () =>
      new Response(null, { status: 204, statusText: "No Content", headers: { "Content-Length": "100" } }),
    );
    const response = await meter.fetch("http://chat.local/api", { method: "GET" });
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("100");
    await meter.flush();

    const sent = requestWireBytes({ method: "GET", url: "http://chat.local/api", headers: new Headers(), bodyBytes: 0 });
    const received = responseWireBytes({
      status: 204,
      statusText: "No Content",
      headers: new Headers({ "Content-Length": "100" }),
      bodyBytes: 0,
    });
    expect(meter.totals().sessionBytes).toBe(sent + received);
  });

  test("a failed request still costs the bytes that left the device", async () => {
    const storage = memoryStorage();
    let requests = 0;
    const meter = new DataMeter(storage, () => new Date(2026, 9, 20), async () => {
      requests += 1;
      throw new Error("offline");
    });
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    };
    await expect(meter.fetch("http://chat.local/sync", init)).rejects.toThrow("offline");
    expect(requests).toBe(1);
    expect(meter.totals().sessionBytes).toBe(
      requestWireBytes({
        method: "POST",
        url: "http://chat.local/sync",
        headers: new Headers({ "Content-Type": "application/json" }),
        bodyBytes: 2,
      }),
    );
  });

  test("a response without Content-Length is counted from the body the app receives", async () => {
    const storage = memoryStorage();
    const meter = new DataMeter(storage, () => new Date(2026, 9, 20), async () =>
      new Response("hello", { status: 200, statusText: "OK", headers: { "Content-Type": "text/plain" } }),
    );
    const response = await meter.fetch("http://chat.local/api", { method: "GET" });
    expect(await response.text()).toBe("hello");
    await meter.flush();
    const sent = requestWireBytes({
      method: "GET",
      url: "http://chat.local/api",
      headers: new Headers(),
      bodyBytes: 0,
    });
    const received = responseWireBytes({
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "text/plain" }),
      bodyBytes: 5,
    });
    expect(meter.totals().sessionBytes).toBe(sent + received);
  });
  test("two servers are counted separately and add up to the device total", async () => {
    const other = "https://other.example";
    const storage = memoryStorage(null, 0, [DEFAULT_SERVER, other]);
    const meter = new DataMeter(storage, () => new Date(2026, 9, 20), fixedFetch().fetch);
    await meter.load();
    await meter.fetch(`${DEFAULT_SERVER}/sync`, { method: "POST", body: new Uint8Array(8) });
    await meter.fetch(`${other}/sync`, { method: "POST", body: new Uint8Array(16) });
    await meter.flush();

    const rows = meter.servers();
    expect(rows.map((row) => row.server)).toEqual([DEFAULT_SERVER, other]);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error("expected two server rows");
    expect(first.monthBytes).toBeGreaterThan(0);
    expect(second.monthBytes).toBeGreaterThan(first.monthBytes);
    // The headline totals are the sum, not the last server's numbers.
    expect(meter.totals().sessionBytes).toBe(first.sessionBytes + second.sessionBytes);
    expect(meter.totals().monthBytes).toBe(first.monthBytes + second.monthBytes);
    expect(storage.rows.get(DEFAULT_SERVER)).toEqual({ month: "2026-10", bytes: first.monthBytes });
    expect(storage.rows.get(other)).toEqual({ month: "2026-10", bytes: second.monthBytes });
    expect(storage.sessions.get(DEFAULT_SERVER)).toBe(first.sessionBytes);
    expect(storage.sessions.get(other)).toBe(second.sessionBytes);
  });

  test("a server added after boot shows up on the next load, with its stored month", async () => {
    const added = "https://new.example";
    const storage = memoryStorage({ month: "2026-10", bytes: 500 }, 0);
    const meter = new DataMeter(storage, () => new Date(2026, 9, 20), fixedFetch().fetch);
    await meter.load();
    expect(meter.servers().map((row) => row.server)).toEqual([DEFAULT_SERVER]);

    storage.servers.push(added);
    storage.rows.set(added, { month: "2026-10", bytes: 900 });
    storage.sessions.set(added, 40);
    await meter.load();

    expect(meter.servers().map((row) => row.server)).toEqual([DEFAULT_SERVER, added]);
    expect(meter.totals()).toEqual({ sessionBytes: 40, monthBytes: 1400, monthKey: "2026-10" });
  });

  test("the month rolls for every server, not only the one on screen", async () => {
    const other = "https://other.example";
    const storage = memoryStorage({ month: "2026-10", bytes: 500 }, 0, [DEFAULT_SERVER, other]);
    storage.rows.set(other, { month: "2026-10", bytes: 700 });
    let now = new Date(2026, 9, 31, 23, 59);
    const meter = new DataMeter(storage, () => now, fixedFetch().fetch);
    await meter.load();
    expect(meter.totals().monthBytes).toBe(1200);

    now = new Date(2026, 10, 1, 0, 1);
    await meter.load();
    await meter.flush();
    expect(meter.totals()).toEqual({ sessionBytes: 0, monthBytes: 0, monthKey: "2026-11" });
    expect(storage.rows.get(DEFAULT_SERVER)).toEqual({ month: "2026-11", bytes: 0 });
    expect(storage.rows.get(other)).toEqual({ month: "2026-11", bytes: 0 });
  });

  test("the single-server tab counter moves to the serving server once, without overwriting", () => {
    const values = new Map<string, string>([["brr-meter-session", "1234"]]);
    const fake = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { value: fake, configurable: true });
    try {
      migrateLegacyMeterSession(DEFAULT_SERVER);
      expect(values.get(`brr-meter-session:${DEFAULT_SERVER}`)).toBe("1234");
      expect(values.has("brr-meter-session")).toBe(false);

      // A fresh count on the namespaced key wins over an old legacy value.
      values.set("brr-meter-session", "9");
      migrateLegacyMeterSession(DEFAULT_SERVER);
      expect(values.get(`brr-meter-session:${DEFAULT_SERVER}`)).toBe("1234");

      forgetServerMeter(DEFAULT_SERVER);
      expect(values.has(`brr-meter-session:${DEFAULT_SERVER}`)).toBe(false);
    } finally {
      if (original === undefined) delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
      else Object.defineProperty(globalThis, "sessionStorage", original);
    }
  });

  test("a removed server stops counting, even for a response already in flight", async () => {
    const storage = memoryStorage();
    const meter = new DataMeter(storage, () => new Date(2026, 9, 20), fixedFetch().fetch);
    await meter.load();
    await meter.fetch(`${DEFAULT_SERVER}/sync`, { method: "POST", body: new Uint8Array(8) });
    await meter.flush();
    const before = storage.rows.get(DEFAULT_SERVER)?.bytes ?? 0;
    expect(before).toBeGreaterThan(0);

    meter.forget(DEFAULT_SERVER);
    // The server is gone from the list (removeServer does that), and a late fetch must not
    // bring its bucket or its month row back.
    storage.servers = [];
    await meter.fetch(`${DEFAULT_SERVER}/sync`, { method: "POST", body: new Uint8Array(8) });
    await meter.flush();
    expect(meter.servers()).toEqual([]);
    expect(storage.rows.get(DEFAULT_SERVER)?.bytes).toBe(before);
  });

});
