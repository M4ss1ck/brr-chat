# 0023. Backups: in-process SQLite snapshots, archived by Coolify

Status: accepted (2026-10-24)

## Context
One SQLite file holds everything a Server has: the event log, accounts, sessions, recovery
hashes and every stored image (ADR 0011). No S3-compatible storage is available, so backups
have to use what Coolify provides.

- Coolify's **storage backups** tar an application volume on a schedule, keep the archive on
  the VPS, and apply retention. The tar is file-level. Coolify's own docs warn it can capture
  a database mid-write unless the containers are stopped for the archive. It has no restore
  button.
- Coolify's **scheduled tasks** run commands through `sh -c` inside a container. The
  production image has no shell (ADR 0022).
- Copying a live WAL database file by any outside means can restore to a corrupt database.
  Only SQLite can make a consistent copy while the app writes.

## Decision
- **The server snapshots itself.** With `BACKUP_DIR` set (the image sets `/backups`), every
  `BACKUP_INTERVAL_HOURS` (default 6) it runs `VACUUM INTO` to a temp name in that directory.
  The copy is one transaction, so it is a single point in time. It then `chmod 600`s and
  `rename`s the file to `brr-chat-<UTC stamp>.db` and keeps the newest `BACKUP_KEEP`
  (default 8, two days). Files in the directory that don't match the snapshot pattern are
  left alone. A crash leftover is deleted. A failed snapshot is logged
  (`brr-chat backup FAILED ...`) and retried at the next tick, and never stops the server.
  The first snapshot waits a full interval, so a burst of deploys cannot rotate away older
  snapshots.
- **Coolify archives only `/backups`, daily, without stopping containers.** That volume
  only ever gains whole files in one atomic rename, so a live tar of it is consistent. The
  live `/data` volume is never archived by file copy.
- **Restore is a script, and CI tests it.** `scripts/restore.sh <container> [snapshot]` stages
  the snapshot (a name in `/backups`, a `.db` file, or a Coolify `.tar.gz`), stops the server,
  and pipes the file over stdin to `brr-chat restore -` in a one-off container of the same
  image on the same volumes. There is no busybox and no host `sqlite3` in the path. A trap
  installed before the stop restarts the server on any error or Ctrl-C, so a refused snapshot
  leaves it running on the old file. A killed shell (SIGKILL, a dropped SSH session) can leave
  it stopped: run `docker start <container>` then. `restoreSnapshot` checks the SQLite magic,
  `integrity_check` and the presence of the `events`, `user` and `server_settings` tables
  before it touches anything. It then copies the snapshot in under a temp name, raises
  `sqlite_sequence` for `events` and `media` to the replaced database's values, and only after
  that moves the live DB with its `-wal` and `-shm` to `/data/before-restore-<time>/` (mode
  0700) and renames the copy into place, so a failure leaves the live file where it was.
  `scripts/smoke.sh` restores a real snapshot on every CI run and checks that an account
  created after it is gone.

  The counters are the reason this is more than a file copy. Devices have already moved past
  the snapshot: their cursors and media caches point at seqs and ids the snapshot has never
  seen. Sync returns only `seq > cursor`, so a reused seq below a device's cursor would be
  skipped in silence, and a reused media id could show a different image from that device's
  cache.

## Consequences
- **Every copy lives on the VPS disk.** Losing the VPS loses the server's data. Until
  off-box storage exists, the mitigation is the runbook step of downloading an archive from
  Coolify's Backups page now and then. Adding an S3 destination later is a Coolify setting,
  with no code change.
- At most 6 hours of writes can be lost, and the interval is one env var.
- `VACUUM INTO` runs on the app's own connection and blocks the event loop while it runs.
  A 274 MB database (above the 256 MB default media quota plus events) took about 330 ms on a
  local SSD. A VPS disk will be slower, a second or two at most, every 6 hours, and clients
  retry. If the database grows well past the quota, moving the snapshot to a worker with
  its own connection is the next step.
- Snapshots use disk on top of the live file: up to `BACKUP_KEEP` full copies, plus
  Coolify's archive retention. Coolify's default keeps 7 archives, each holding up to 8
  snapshots, so the operator should set the archive's retention with that in mind (the
  runbook says how).
- **Wire ids are not floored.** `wire_users.wire_id` is `MAX(wire_id) + 1`
  (`apps/server/src/events.ts`), so after a restore a new account can get the wire id that an
  account created after the snapshot already had. Devices show the old profile for that id
  until the new profile event arrives on their next sync.
- **Devices keep what they cached from the lost window.** Those events still render until
  they scroll out of the 2,000-event cap. An op against a group created in that window fails
  with `NotFound` and is dropped, the same path as any op against deleted data (ADR 0013).
