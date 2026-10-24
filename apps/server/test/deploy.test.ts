// What the container deploy relies on (ADR 0022, ADR 0023): the abuse limits key on the
// real client behind exactly the proxies we trust, the healthcheck tells a live DB from a
// dead one, and the snapshots are whole, private, and pruned.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSnapshots, scheduleSnapshots, snapshotName, takeSnapshot } from "../src/backup.ts";
import { clientIp } from "../src/client-ip.ts";
import { restoreSnapshot } from "../src/restore.ts";
import { createApp, healthcheck, parseCliOptions, type ServerApp } from "../src/index.ts";

const PROXY = "10.0.1.5";

function forwarded(xff: string | undefined): Request {
  return new Request("http://chat.local/", xff === undefined ? {} : { headers: { "x-forwarded-for": xff } });
}

function signUpRequest(username: string, xff?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "http://chat.local" };
  if (xff !== undefined) headers["x-forwarded-for"] = xff;
  return new Request("http://chat.local/api/auth/sign-up/email", {
    method: "POST",
    headers,
    body: JSON.stringify({ username, password: "password1234" }),
  });
}

async function signUpStatuses(app: ServerApp, attempts: { username: string; xff?: string; socket?: string }[]) {
  const statuses: number[] = [];
  for (const { username, xff, socket } of attempts) {
    statuses.push((await app.fetch(signUpRequest(username, xff), socket)).status);
  }
  return statuses;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "brr-deploy-"));
}

describe("client IP behind trusted proxies", () => {
  test("with no trusted proxy, the socket peer wins and headers are ignored", () => {
    expect(clientIp(forwarded("203.0.113.9"), "198.51.100.1", 0)).toBe("198.51.100.1");
    expect(clientIp(forwarded(undefined), undefined, 0)).toBe("local");
  });

  test("one trusted proxy: the entry it appended, never what the client wrote to its left", () => {
    expect(clientIp(forwarded("198.51.100.7"), PROXY, 1)).toBe("198.51.100.7");
    expect(clientIp(forwarded("1.1.1.1, 2.2.2.2, 198.51.100.7"), PROXY, 1)).toBe("198.51.100.7");
    expect(clientIp(forwarded(" 1.1.1.1 ,198.51.100.7 "), PROXY, 1)).toBe("198.51.100.7");
  });

  test("two trusted proxies (a CDN, then Traefik): the CDN's entry, second from the right", () => {
    expect(clientIp(forwarded("6.6.6.6, 198.51.100.7, 172.70.0.1"), PROXY, 2)).toBe("198.51.100.7");
  });

  test("a request that skipped the proxies, or a malformed chain, falls back to the socket peer", () => {
    expect(clientIp(forwarded(undefined), PROXY, 1)).toBe(PROXY);
    expect(clientIp(forwarded("198.51.100.7"), PROXY, 2)).toBe(PROXY);
    expect(clientIp(forwarded("1.1.1.1, "), PROXY, 1)).toBe(PROXY);
    expect(clientIp(forwarded("x".repeat(65)), PROXY, 1)).toBe(PROXY);
  });

  test("behind one proxy, two real clients get separate signup budgets", async () => {
    // The bug this fixes: every request arrives from the proxy's socket, so before
    // TRUSTED_PROXY_HOPS the whole server shared one 3-per-hour signup budget.
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", trustedProxyHops: 1 });
    try {
      const statuses = await signUpStatuses(app, [
        { username: "ana", xff: "198.51.100.1", socket: PROXY },
        { username: "bea", xff: "198.51.100.1", socket: PROXY },
        { username: "cora", xff: "198.51.100.1", socket: PROXY },
        { username: "dina", xff: "198.51.100.2", socket: PROXY },
        { username: "elsa", xff: "198.51.100.1", socket: PROXY },
      ]);
      expect(statuses).toEqual([200, 200, 200, 200, 429]);
    } finally {
      app.close();
    }
  });

  test("a client cannot dodge the budget by writing its own X-Forwarded-For", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", trustedProxyHops: 1 });
    try {
      // The proxy appends the address it saw (198.51.100.9) after whatever the client sent.
      const statuses = await signUpStatuses(
        app,
        ["ana", "bea", "cora", "dina"].map((username, i) => ({
          username,
          xff: `203.0.113.${i}, 198.51.100.9`,
          socket: PROXY,
        })),
      );
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      app.close();
    }
  });

  test("a server not behind a proxy ignores X-Forwarded-For entirely", async () => {
    // Regression for the old header fallback in recovery.ts, which keyed on the left-most
    // X-Forwarded-For entry whenever the socket address was missing.
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const statuses = await signUpStatuses(
        app,
        ["ana", "bea", "cora", "dina"].map((username, i) => ({ username, xff: `203.0.113.${i}` })),
      );
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      app.close();
    }
  });
});

describe("/healthz", () => {
  test("answers ok, uncached, on GET and HEAD with no session", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const get = await app.fetch(new Request("http://chat.local/healthz"));
      expect(get.status).toBe(200);
      expect(get.headers.get("cache-control")).toBe("no-store");
      expect(get.headers.get("content-encoding")).toBeNull();
      expect(await get.text()).toBe("ok\n");
      const head = await app.fetch(new Request("http://chat.local/healthz", { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect((await app.fetch(new Request("http://chat.local/healthz", { method: "POST" }))).status).toBe(405);
    } finally {
      app.close();
    }
  });

  test("answers 503 once the database is gone", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    app.db.close();
    const res = await app.fetch(new Request("http://chat.local/healthz"));
    expect(res.status).toBe(503);
  });

  test("the healthcheck subcommand exits 0 for a live server and 1 for none", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "127.0.0.1" });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
    const port = server.port ?? 0;
    try {
      expect(await healthcheck({ port, host: "0.0.0.0" })).toBe(0);
    } finally {
      await server.stop(true);
      app.close();
    }
    // The port just freed: nothing answers, so the probe must fail rather than hang.
    expect(await healthcheck({ port, host: "127.0.0.1" })).toBe(1);
  });
});

describe("snapshots", () => {
  function seededDb(dir: string): Database {
    const db = new Database(join(dir, "live.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT);");
    const insert = db.query("INSERT INTO t (body) VALUES (?)");
    for (let i = 0; i < 500; i++) insert.run(`row ${i}`);
    return db;
  }

  test("names sort chronologically and carry milliseconds", () => {
    expect(snapshotName(new Date("2026-10-24T12:00:00.123Z"))).toBe("brr-chat-20261024T120000123Z.db");
    const a = snapshotName(new Date("2026-10-24T09:59:59.999Z"));
    const b = snapshotName(new Date("2026-10-24T10:00:00.000Z"));
    expect([b, a].sort()).toEqual([a, b]);
  });

  test("a snapshot is a whole, owner-only copy that includes uncheckpointed WAL writes", () => {
    const dir = tempDir();
    const db = seededDb(dir);
    try {
      const backups = join(dir, "backups");
      const snap = takeSnapshot(db, { dir: backups, keep: 3 });
      expect(statSync(snap.path).mode & 0o777).toBe(0o600);
      expect(snap.bytes).toBeGreaterThan(0);
      const copy = new Database(snap.path, { readonly: true });
      try {
        expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(copy.query("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 500 });
      } finally {
        copy.close();
      }
      // Only finished snapshots are ever visible to an archiver walking the directory.
      expect(readdirSync(backups)).toEqual([snap.path.slice(backups.length + 1)]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the newest N, drops crash leftovers, and leaves foreign files alone", () => {
    const dir = tempDir();
    const db = seededDb(dir);
    try {
      const backups = join(dir, "backups");
      takeSnapshot(db, { dir: backups, keep: 2 }, new Date("2026-10-24T00:00:00.000Z"));
      writeFileSync(join(backups, ".brr-chat-20261024T030000000Z.db.tmp"), "half a snapshot");
      writeFileSync(join(backups, "README"), "operator notes");
      takeSnapshot(db, { dir: backups, keep: 2 }, new Date("2026-10-24T06:00:00.000Z"));
      takeSnapshot(db, { dir: backups, keep: 2 }, new Date("2026-10-24T12:00:00.000Z"));
      expect(listSnapshots(backups)).toEqual(["brr-chat-20261024T060000000Z.db", "brr-chat-20261024T120000000Z.db"]);
      expect(readdirSync(backups).sort()).toEqual([
        "README",
        "brr-chat-20261024T060000000Z.db",
        "brr-chat-20261024T120000000Z.db",
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the schedule waits one interval, logs each snapshot, and survives a failure", async () => {
    const dir = tempDir();
    const db = seededDb(dir);
    const lines: string[] = [];
    // A file where the backup directory should be makes every snapshot fail.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const stopGood = scheduleSnapshots(db, { dir: join(dir, "backups"), keep: 8, intervalMs: 40 }, (l) => lines.push(l));
    const stopBad = scheduleSnapshots(db, { dir: blocked, keep: 8, intervalMs: 40 }, (l) => lines.push(l));
    try {
      expect(lines).toEqual([]);
      await Bun.sleep(150);
      expect(lines.some((l) => /^brr-chat backup .*brr-chat-\d{8}T\d{9}Z\.db \d+ B in \d+ ms$/.test(l))).toBe(true);
      expect(lines.filter((l) => l.startsWith("brr-chat backup FAILED")).length).toBeGreaterThanOrEqual(2);
    } finally {
      stopGood();
      stopBad();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an app given a backup directory snapshots its own DB; an in-memory one never does", async () => {
    const dir = tempDir();
    const backups = join(dir, "backups");
    const app = await createApp({
      dbPath: join(dir, "brr-chat.db"),
      host: "chat.local",
      secret: "s".repeat(32),
      backup: { dir: backups, keep: 2, intervalMs: 30 },
    });
    const mem = await createApp({
      dbPath: ":memory:",
      host: "chat.local",
      backup: { dir: join(dir, "never"), keep: 2, intervalMs: 30 },
    });
    try {
      await Bun.sleep(120);
      expect(listSnapshots(backups).length).toBeGreaterThan(0);
      expect(listSnapshots(backups).length).toBeLessThanOrEqual(2);
    } finally {
      app.close();
      mem.close();
    }
    // close() stops the timer: nothing new lands after it.
    const after = listSnapshots(backups);
    await Bun.sleep(80);
    expect(listSnapshots(backups)).toEqual(after);
    expect(() => readdirSync(join(dir, "never"))).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("container configuration", () => {
  test("HOST sets the listen address and the derived base URL; --host still wins", () => {
    expect(parseCliOptions([], { HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(parseCliOptions([], { HOST: "0.0.0.0", PORT: "3000" }).baseURL).toBe("http://0.0.0.0:3000");
    expect(parseCliOptions(["--host", "127.0.0.1"], { HOST: "0.0.0.0" }).host).toBe("127.0.0.1");
  });

  test("trusted proxy hops default to 0 and reject nonsense", () => {
    expect(parseCliOptions([], {}).trustedProxyHops).toBe(0);
    expect(parseCliOptions([], { TRUSTED_PROXY_HOPS: "1" }).trustedProxyHops).toBe(1);
    expect(parseCliOptions(["--trusted-proxy-hops", "2"], { TRUSTED_PROXY_HOPS: "1" }).trustedProxyHops).toBe(2);
    expect(() => parseCliOptions([], { TRUSTED_PROXY_HOPS: "-1" })).toThrow(/proxy hops/);
    expect(() => parseCliOptions([], { TRUSTED_PROXY_HOPS: "yes" })).toThrow(/proxy hops/);
  });

  test("snapshots are off unless a directory is given; interval and keep are validated", () => {
    const off = parseCliOptions([], {});
    expect(off.backupDir).toBeUndefined();
    expect(off.backupIntervalHours).toBe(6);
    expect(off.backupKeep).toBe(8);
    expect(parseCliOptions([], { BACKUP_DIR: "" }).backupDir).toBeUndefined();
    const on = parseCliOptions([], { BACKUP_DIR: "/backups", BACKUP_INTERVAL_HOURS: "0.001", BACKUP_KEEP: "3" });
    expect(on).toMatchObject({ backupDir: "/backups", backupIntervalHours: 0.001, backupKeep: 3 });
    expect(() => parseCliOptions([], { BACKUP_INTERVAL_HOURS: "0" })).toThrow(/backup interval/);
    expect(() => parseCliOptions([], { BACKUP_KEEP: "0" })).toThrow(/backup keep/);
  });
});

describe("restore", () => {
  const SECRET = "r".repeat(32);

  async function liveServer(dir: string) {
    return createApp({ dbPath: join(dir, "brr-chat.db"), host: "chat.local", secret: SECRET });
  }

  function insertEvent(db: Database): number {
    db.query("INSERT INTO events (tag, ts, author, scope, bytes) VALUES (1, 0, 1, 0, x'00')").run();
    return Number((db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s);
  }

  test("new events continue above everything devices saw before the restore", async () => {
    const dir = tempDir();
    try {
      const app = await liveServer(dir);
      insertEvent(app.db);
      const snap = takeSnapshot(app.db, { dir: join(dir, "backups"), keep: 2 });
      // After the snapshot, devices see three more events and one more image id.
      for (let i = 0; i < 3; i++) insertEvent(app.db);
      const seenHead = insertEvent(app.db);
      app.db.query("INSERT INTO sqlite_sequence (name, seq) VALUES ('media', 41)").run();
      app.close();

      const result = restoreSnapshot(join(dir, "brr-chat.db"), snap.path, new Date("2026-10-24T12:00:00Z"));
      expect(result.head).toBeLessThan(seenHead);
      expect(result.eventsFloor).toBe(seenHead);
      expect(result.mediaFloor).toBe(41);

      const restored = await liveServer(dir);
      try {
        expect(insertEvent(restored.db)).toBe(seenHead + 1);
      } finally {
        restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the replaced database and its WAL move aside; no stale WAL stays next to the restore", async () => {
    const dir = tempDir();
    try {
      const app = await liveServer(dir);
      const snap = takeSnapshot(app.db, { dir: join(dir, "backups"), keep: 2 });
      insertEvent(app.db);
      // Simulate a crash: the WAL still holds the newest rows and is never checkpointed.
      const live = join(dir, "brr-chat.db");
      const crashed = { wal: Bun.file(`${live}-wal`).size };
      expect(crashed.wal).toBeGreaterThan(0);
      const result = restoreSnapshot(live, snap.path, new Date("2026-10-24T12:00:00Z"));
      app.close();
      expect(result.previous).toBe(join(dir, "before-restore-20261024T120000Z"));
      expect(readdirSync(result.previous!).sort()).toContain("brr-chat.db");
      expect(statSync(result.previous!).mode & 0o777).toBe(0o700);
      expect(statSync(live).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).some((n) => n.endsWith(".restoring"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed copy leaves the live database untouched and no before-restore dir", async () => {
    const dir = tempDir();
    try {
      const app = await liveServer(dir);
      const snap = takeSnapshot(app.db, { dir: join(dir, "backups"), keep: 2 });
      insertEvent(app.db);
      app.close();
      const live = join(dir, "brr-chat.db");
      const before = await Bun.file(live).bytes();
      // A directory where the copy lands makes copyFileSync fail after the checks pass.
      mkdirSync(`${live}.restoring`);

      expect(() => restoreSnapshot(live, snap.path, new Date("2026-10-24T12:00:00Z"))).toThrow();

      expect(await Bun.file(live).bytes()).toEqual(before);
      expect(readdirSync(dir).some((n) => n.startsWith("before-restore-"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two restores at the same instant keep two distinct before-restore dirs", async () => {
    const dir = tempDir();
    try {
      const app = await liveServer(dir);
      insertEvent(app.db);
      const snap = takeSnapshot(app.db, { dir: join(dir, "backups"), keep: 2 });
      app.close();
      const live = join(dir, "brr-chat.db");
      const now = new Date("2026-10-24T12:00:00Z");

      const first = restoreSnapshot(live, snap.path, now);
      const second = restoreSnapshot(live, snap.path, now);

      expect(first.previous).toBe(join(dir, "before-restore-20261024T120000Z"));
      expect(second.previous).toBe(join(dir, "before-restore-20261024T120000Z-2"));
      expect(readdirSync(first.previous!)).toContain("brr-chat.db");
      expect(readdirSync(second.previous!)).toContain("brr-chat.db");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a non-database, a foreign database and a corrupt file before touching the live one", async () => {
    const dir = tempDir();
    try {
      const app = await liveServer(dir);
      app.close();
      const live = join(dir, "brr-chat.db");
      const before = await Bun.file(live).bytes();

      const junk = join(dir, "junk.db");
      writeFileSync(junk, "definitely not sqlite, just some bytes");
      expect(() => restoreSnapshot(live, junk)).toThrow(/not a SQLite database/);

      const foreign = join(dir, "foreign.db");
      const other = new Database(foreign);
      other.exec("CREATE TABLE notes (id INTEGER)");
      other.close();
      expect(() => restoreSnapshot(live, foreign)).toThrow(/not a brr-chat database/);

      const corrupt = join(dir, "corrupt.db");
      const bytes = await Bun.file(live).bytes();
      bytes.fill(0xff, 4096, 8192); // a whole page of garbage after the header
      writeFileSync(corrupt, bytes);
      expect(() => restoreSnapshot(live, corrupt)).toThrow();

      expect(await Bun.file(live).bytes()).toEqual(before);
      expect(readdirSync(dir).some((n) => n.startsWith("before-restore-"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores into an empty volume with no floors to raise", async () => {
    const dir = tempDir();
    try {
      const app = await liveServer(dir);
      insertEvent(app.db);
      const snap = takeSnapshot(app.db, { dir: join(dir, "backups"), keep: 2 });
      app.close();
      const fresh = join(dir, "fresh", "brr-chat.db");
      const result = restoreSnapshot(fresh, snap.path);
      expect(result.previous).toBeNull();
      expect(result.head).toBe(result.eventsFloor);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
