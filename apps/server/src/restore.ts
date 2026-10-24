// Replacing the live database with a snapshot (ADR 0023). Run by `brr-chat restore` while
// the server is stopped; scripts/restore.sh drives it from the Docker host.
//
// A snapshot is older than the database it replaces, and devices have already seen what
// came after it: their cursors and media caches point past the snapshot's last seq and
// media id. If the restored server handed those numbers out again, a device would skip the
// new events below its cursor (sync returns only seq > cursor) and could show a cached image
// under a reused media id. So the restored file's AUTOINCREMENT counters are raised to the
// replaced database's, and new rows start above anything a device has seen.
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Tables whose ids devices cache; see the module comment. */
const FLOORED_TABLES = ["events", "media"] as const;
const SQLITE_MAGIC = "SQLite format 3\0";

export interface RestoreResult {
  /** Where the replaced database and its WAL went, or null when there was none. */
  previous: string | null;
  /** Head seq of the restored log, and the counter new events now continue from. */
  head: number;
  eventsFloor: number;
  mediaFloor: number;
}

function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261024T120000Z
}

/** Refuses anything that is not a whole brr-chat database before the live one is touched. */
export function checkSnapshot(path: string): void {
  const head = Buffer.alloc(16);
  const file = Bun.file(path);
  if (file.size < 16) throw new Error(`${path} is not a SQLite database`);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (head.toString("latin1") !== SQLITE_MAGIC) throw new Error(`${path} is not a SQLite database`);
  const db = new Database(path, { readonly: true });
  try {
    const check = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (check.integrity_check !== "ok") throw new Error(`${path} fails integrity_check: ${check.integrity_check}`);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const table of ["events", "user", "server_settings"]) {
      if (!tables.some((t) => t.name === table)) throw new Error(`${path} has no ${table} table: not a brr-chat database`);
    }
  } finally {
    db.close();
  }
}

function counters(path: string): Record<(typeof FLOORED_TABLES)[number], number> {
  const out = { events: 0, media: 0 };
  if (!existsSync(path)) return out;
  // Read-write so SQLite can replay a WAL left by a crash; readonly would miss those rows.
  const db = new Database(path);
  try {
    const rows = db.query("SELECT name, seq FROM sqlite_sequence").all() as { name: string; seq: number }[];
    for (const table of FLOORED_TABLES) out[table] = Number(rows.find((r) => r.name === table)?.seq ?? 0);
  } catch {
    // No sqlite_sequence: nothing was ever inserted, every floor is 0.
  } finally {
    db.close();
  }
  return out;
}

/** A `before-restore-<stamp>` directory that is not taken yet: `-2`, `-3`, ... beside an older one. */
function beforeRestoreDir(dir: string, stamp: string): string {
  let candidate = join(dir, `before-restore-${stamp}`);
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `before-restore-${stamp}-${n}`);
  return candidate;
}

/**
 * Replaces `dbPath` with a copy of `snapshotPath`. The server must not be running.
 *
 * Nothing live moves until the replacement is whole: the snapshot is copied under a temp
 * name beside the DB, chmodded 600, opened, floored and closed. Only then does the replaced
 * file move, with its -wal and -shm, into `before-restore-<time>/`: a stale WAL left next to
 * the restored file would be replayed onto it. The temp is renamed into place last, so any
 * failure before the move removes the temp and leaves the live database as it was. A second
 * restore at the same time gets `-2`, `-3`, ... rather than overwriting the first one's copy.
 */
export function restoreSnapshot(dbPath: string, snapshotPath: string, now: Date = new Date()): RestoreResult {
  checkSnapshot(snapshotPath);
  const floors = counters(dbPath);
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const temp = `${dbPath}.restoring`;
  let head = 0;
  try {
    copyFileSync(snapshotPath, temp);
    chmodSync(temp, 0o600);
    const db = new Database(temp);
    try {
      for (const table of FLOORED_TABLES) {
        const floor = floors[table];
        if (floor === 0) continue;
        const row = db.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | null;
        if (row === null) db.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, floor);
        else if (Number(row.seq) < floor) db.query("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(floor, table);
      }
      head = Number((db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq);
      // Report the counters the restored file now continues from: the floor, or its own if higher.
      for (const row of db.query("SELECT name, seq FROM sqlite_sequence").all() as { name: string; seq: number }[]) {
        if (row.name === "events") floors.events = Math.max(floors.events, Number(row.seq));
        if (row.name === "media") floors.media = Math.max(floors.media, Number(row.seq));
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // The live files were never touched; drop the partial copy so nothing half is left behind.
    rmSync(temp, { force: true, recursive: true });
    throw err;
  }

  let previous: string | null = null;
  if (existsSync(dbPath)) {
    previous = beforeRestoreDir(dir, stampOf(now));
    mkdirSync(previous, { mode: 0o700 });
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, join(previous, basename(dbPath) + suffix));
    }
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

  renameSync(temp, dbPath);
  return { previous, head, eventsFloor: floors.events, mediaFloor: floors.media };
}
