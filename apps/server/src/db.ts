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

// Wire ids are the uints on the protocol (author, membership.user); BetterAuth ids are strings.
const CREATE_WIRE_USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS wire_users (
  id TEXT PRIMARY KEY,
  wire_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
)
`.trim();

// Group id is the seq of its group_meta event (docs/PROTOCOL.md: a seq is the id of the
// thing the event creates). The open flag is duplicated from the metadata so visibility
// can be decided without decoding every event. `invite_token` is the current secret in the
// group's single invite link; rotating it is one UPDATE (ADR 0016).
const CREATE_GROUPS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS chat_groups (
  id INTEGER PRIMARY KEY,
  open INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  invite_token TEXT
)
`.trim();

// Current membership. `seq` points at the membership event that established the role, so a
// state snapshot can replay it without walking the whole log.
const CREATE_GROUP_MEMBERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
)
`.trim();

// A DM scope is the unordered pair of its two participants. Its id is the seq of the
// `dm_scope` event that created it (ADR 0015), so one log position names the conversation.
// The unique pair index is what makes two concurrent first messages create exactly one scope.
const CREATE_DM_SCOPES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS dm_scopes (
  id INTEGER PRIMARY KEY,
  user_a INTEGER NOT NULL,
  user_b INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)
`.trim();

// Outbox dedup (docs/PROTOCOL.md): cid -> seq for 30 days, per account. `tag` lets a retried
// join or group create still answer with the state snapshot it originally deserved.
const CREATE_OUTBOX_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS outbox_ops (
  user_id TEXT NOT NULL,
  cid BLOB NOT NULL,
  tag INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, cid)
)
`.trim();

// ADR 0006: only hashes ever reach the disk. `tail_hash` lets signup check the last group
// without keeping the full code anywhere.
const CREATE_RECOVERY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id TEXT PRIMARY KEY,
  code_hash BLOB NOT NULL,
  tail_hash BLOB NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
  db.exec(CREATE_WIRE_USERS_TABLE_SQL);
  db.exec(CREATE_GROUPS_TABLE_SQL);
  // A database created before invite links has no column to ALTER in CREATE TABLE IF NOT
  // EXISTS. SQLite has no ADD COLUMN IF NOT EXISTS, so check the schema first.
  const groupColumns = db.query("PRAGMA table_info(chat_groups)").all() as { name: string }[];
  if (!groupColumns.some((column) => column.name === "invite_token")) {
    db.exec("ALTER TABLE chat_groups ADD COLUMN invite_token TEXT;");
  }
  db.exec(CREATE_GROUP_MEMBERS_TABLE_SQL);
  db.exec(CREATE_DM_SCOPES_TABLE_SQL);
  db.exec(CREATE_OUTBOX_TABLE_SQL);
  db.exec("CREATE INDEX IF NOT EXISTS events_scope_seq ON events(scope, seq);");
  db.exec("CREATE INDEX IF NOT EXISTS events_tag_scope ON events(tag, scope);");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS dm_scopes_pair ON dm_scopes(user_a, user_b);");
  db.exec("CREATE INDEX IF NOT EXISTS dm_scopes_user_a ON dm_scopes(user_a);");
  db.exec("CREATE INDEX IF NOT EXISTS dm_scopes_user_b ON dm_scopes(user_b);");
  // One live token per group, and no two groups may share one. SQLite allows many NULLs.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS chat_groups_invite_token ON chat_groups(invite_token);");
  db.exec("CREATE INDEX IF NOT EXISTS outbox_created ON outbox_ops(created_at);");
  db.exec(CREATE_RECOVERY_TABLE_SQL);
  return db;
}

export function headCursor(db: Database): number {
  const row = db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number } | null;
  return row ? Number(row.seq) : 0;
}
