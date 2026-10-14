import { Database } from "bun:sqlite";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

const CREATE_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tag INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  author INTEGER NOT NULL,
  scope INTEGER NOT NULL,
  bytes BLOB NOT NULL
)
`.trim();

export function enforceDbFilePermissions(dbPath: string): void {
  if (!dbPath || dbPath === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) {
      chmodSync(p, 0o600);
    }
  }
}

export function openDb(dbPath: string): Database {
  const isMemory = !dbPath || dbPath === ":memory:";
  if (!isMemory) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const fd = openSync(dbPath, constants.O_CREAT | constants.O_RDWR, 0o600);
    closeSync(fd);
    chmodSync(dbPath, 0o600);
  }

  const db = new Database(dbPath);
  if (!isMemory) {
    db.exec("PRAGMA journal_mode = WAL;");
    enforceDbFilePermissions(dbPath);
  }
  db.exec(CREATE_EVENTS_TABLE_SQL);
  return db;
}

export function headCursor(db: Database): number {
  const row = db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number } | null;
  return row ? Number(row.seq) : 0;
}
