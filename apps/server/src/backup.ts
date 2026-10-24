// Periodic snapshots of the one SQLite file (ADR 0023). The server takes them itself because
// the production image has no shell for a scheduler to run a command in, and because only
// SQLite can copy a live WAL database consistently: a file copy taken mid-write can restore
// to a corrupt database. A host-level archiver (Coolify's storage backup) then picks up the
// finished snapshots, which never change once they appear.
import type { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** `brr-chat-20261024T120000123Z.db`: sorts chronologically as plain text. */
const SNAPSHOT_NAME = /^brr-chat-\d{8}T\d{9}Z\.db$/;
const TEMP_PREFIX = ".brr-chat-";
const TEMP_SUFFIX = ".tmp";

export const DEFAULT_BACKUP_INTERVAL_HOURS = 6;
export const DEFAULT_BACKUP_KEEP = 8;

export interface BackupOptions {
  /** Directory the snapshots go to. A separate volume from the live DB in production. */
  dir: string;
  /** Snapshots to keep; older ones are deleted after each new one lands. At least 1. */
  keep: number;
}

export interface Snapshot {
  path: string;
  bytes: number;
  ms: number;
}

export function snapshotName(at: Date): string {
  const stamp = at.toISOString().replace(/[-:.]/g, ""); // 20261024T120000123Z
  return `brr-chat-${stamp}.db`;
}

/** Snapshot names in `dir`, oldest first. Anything else in the directory is left alone. */
export function listSnapshots(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => SNAPSHOT_NAME.test(name))
    .sort();
}

/**
 * Writes one consistent copy of `db` into `opts.dir`, then prunes to `opts.keep`.
 *
 * `VACUUM INTO` reads inside one transaction, so the copy is a single point in time even
 * while the app writes. It goes to a temp name first and is renamed into place, so an
 * archiver walking the directory sees either a whole snapshot or none. It runs on the app's
 * own connection and blocks the event loop for its duration; ADR 0023 records the measured
 * cost and why that is acceptable every few hours.
 */
export function takeSnapshot(db: Database, opts: BackupOptions, now: Date = new Date()): Snapshot {
  const started = performance.now();
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  removeStaleTemps(opts.dir);
  const name = snapshotName(now);
  const temp = join(opts.dir, `${TEMP_PREFIX}${name.slice("brr-chat-".length)}${TEMP_SUFFIX}`);
  const path = join(opts.dir, name);
  try {
    db.query("VACUUM INTO ?").run(temp);
    // Same secrets as the live file (password hashes, session rows): owner-only, like db.ts.
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  prune(opts.dir, opts.keep);
  return { path, bytes: statSync(path).size, ms: Math.round(performance.now() - started) };
}

/** A temp file left by a crash mid-snapshot is never a valid snapshot; drop it. */
function removeStaleTemps(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX)) rmSync(join(dir, name), { force: true });
  }
}

function prune(dir: string, keep: number): void {
  const snapshots = listSnapshots(dir);
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - Math.max(1, keep)))) {
    rmSync(join(dir, name), { force: true });
  }
}

/**
 * Takes a snapshot every `intervalMs`. The first one waits a full interval: a deploy loop
 * that restarts the server must not rotate the older snapshots out. A failed snapshot is
 * logged and retried at the next tick; it never stops the server.
 */
export function scheduleSnapshots(
  db: Database,
  opts: BackupOptions & { intervalMs: number },
  log: (line: string) => void = console.log,
): () => void {
  const timer = setInterval(() => {
    try {
      const snap = takeSnapshot(db, opts);
      log(`brr-chat backup ${snap.path} ${snap.bytes} B in ${snap.ms} ms`);
    } catch (err) {
      log(`brr-chat backup FAILED in ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
