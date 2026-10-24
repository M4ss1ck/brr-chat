# Deploying brr-chat

The decisions behind this runbook are in ADR 0022 (deploy) and ADR 0023 (backups). The
files: `Dockerfile`, `compose.yaml` (production), `compose.dev.yaml` (development),
`scripts/smoke.sh`, `scripts/restore.sh`, `.github/workflows/ci.yml`.

How a change reaches production: you push to `main`, CI runs `check:all`, builds the
image, runs `scripts/smoke.sh` against that image, and pushes it to GHCR as `:sha-<short>`
and `:main`. CI then calls Coolify's deploy webhook, and Coolify pulls `:main`, stops the old
container, and starts the new one. Nothing is built on the VPS.

## Development

```sh
# HOST_UID/HOST_GID keep the files the containers write into the repo yours.
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f compose.dev.yaml up   # http://localhost:3000
docker compose -f compose.dev.yaml down      # stop; add -v to wipe the dev database
```

The `HOST_UID`/`HOST_GID` prefix keeps the files the containers write into the repo yours;
drop it if your ids are 1000. Tests and the pre-commit hook still run on the host
(`bun run check`). Running bare `bun` without Docker works too (see README). On macOS and
Windows Docker Desktop, file-change events reach the container through the bind mount; if
rebuilds stop, restart the web service.

To try the production image locally, the same way CI does:

```sh
scripts/smoke.sh       # builds the image, runs it under compose.yaml, checks 9 things, cleans up
```

## First-time production setup

Do these once, in order. Steps marked **(UI)** happen in Coolify or GitHub and have no file
equivalent.

1. **Make the image public (GitHub UI).** After the first green CI run on `main`, open
   github.com/M4ss1ck?tab=packages → `brr-chat` → Package settings → Change visibility →
   Public. The repo is public, so this exposes nothing new, and Coolify then pulls with no
   credentials.
2. **Create the resource (UI).** In Coolify: Project → New resource → Public repository →
   `https://github.com/M4ss1ck/brr-chat`, branch `main`, build pack **Docker Compose**,
   Docker Compose location `/compose.yaml`.
3. **Set the domain (UI).** In the `brr` service's domain field, enter
   `https://<your domain>:3000`. The `:3000` tells Coolify which container port to route
   to; the public URL has no port. Point the domain's DNS A record at the VPS first.
4. **Turn off what the server already does (UI).** In the resource's Advanced settings, set
   **Gzip compression** to Disabled. The server already chooses brotli or `dcz` per response
   (ADR 0021), and a second layer of compression only adds bytes. Under General, turn
   **Auto Deploy** off: CI deploys after the image is pushed, and Coolify's own push hook
   would pull the previous `:main` before the new one exists.
5. **Deploy once (UI)** with the Deploy button. Coolify generates `SERVICE_HEX_64_AUTHSECRET`
   on this first deploy and keeps it from then on. Don't edit it: a new value signs every
   account out.
6. **Check the start-up log (UI, Logs).** You should see:
   ```
   brr-chat listening on http://0.0.0.0:3000 (db /data/brr-chat.db, protocol v…)
   brr-chat base url https://<your domain>
   brr-chat trusting 1 proxy hop(s) for client IPs
   brr-chat snapshots every 6 h to /backups, keeping 8
   ```
   If the base URL is wrong or carries `:3000`, passkeys and CORS will fail. Set `BASE_URL`
   explicitly in Coolify's Environment Variables to override it.
7. **Claim the server admin immediately.** Open the domain and create your account before
   you share the link with anyone. The first account becomes server admin (ADR 0017). Then
   set registration to the mode you want in the Server administration panel.
8. **Schedule the archive of `/backups` (UI).** Backups → Storage backups → Add → choose the
   `brr-backups` volume. Frequency `daily`, archive behaviour **Keep containers running** (safe:
   `/backups` only ever gains finished files). Retention: keep 7 and set **Maximum storage
   (GB)** to what the disk can spare. Each archive holds up to `BACKUP_KEEP` snapshots of
   roughly the DB's size, and images barely compress. **Never** add a storage backup for
   `brr-data`: a file copy of a live SQLite database can be corrupt.
9. **Connect CI to Coolify (UI, both sides).** In Coolify, Keys & Tokens → API Tokens → create
   one with only the `deploy` permission (Settings → Advanced → API Access must be on). In
   the resource, Webhooks → copy **Deploy Webhook (auth required)**. In GitHub, repo
   Settings → Secrets and variables → Actions, add `COOLIFY_TOKEN` (the token) and
   `COOLIFY_WEBHOOK` (the URL). Until both exist, CI pushes images and skips the deploy with
   a notice.

From then on, merging to `main` is a deploy.

## Configuration

Set these in Coolify's Environment Variables. Anything not set uses the default in
`compose.yaml`.

| Variable | Default | What |
|---|---|---|
| `BRR_IMAGE_TAG` | `main` | Image tag to run. Set to `sha-<short>` to roll back. |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies in front that append `X-Forwarded-For`. Traefik is 1; add 1 for a CDN in front of it. |
| `MEDIA_QUOTA_BYTES` | `268435456` | Total stored image bytes (ADR 0011). |
| `BACKUP_INTERVAL_HOURS` | `6` | Hours between snapshots. |
| `BACKUP_KEEP` | `8` | Snapshots kept in `/backups`. |
| `BASE_URL` | from the domain | Only to override what Coolify derives. |

With a CDN in front of Traefik (`TRUSTED_PROXY_HOPS=2`), the VPS firewall must accept
traffic only from the CDN's IP ranges: a client that reaches Traefik directly otherwise
controls the `X-Forwarded-For` entry the server reads. Leaving it at `1` behind a CDN is
also wrong: every user then keys on the CDN edge IP.

## Rollback

1. Find the last good tag in GitHub → Packages → `brr-chat` (or in the CI run summary of the
   good commit): `sha-<short>`.
2. In Coolify, set `BRR_IMAGE_TAG=sha-<short>` and click Redeploy.
3. When the fix is on `main`, delete `BRR_IMAGE_TAG` and redeploy, or merge the fix and let
   CI deploy it.

A rollback changes the binary, not the data. `openDb` only adds tables and columns, so an
older binary usually runs on newer data, but check the commits between the two tags for
changes to the meaning of existing data first. If the data itself is the problem, see
Restore.

## Restore

`scripts/restore.sh` runs on the VPS (it needs the repo checkout, or just that one file, and
Docker). It stages the snapshot, stops the server, and pipes the file over stdin into
`brr-chat restore -`, a one-off container of the same image on the same volumes. That command
refuses a file that is not a whole brr-chat database (SQLite magic, `integrity_check`, the
`events`, `user` and `server_settings` tables) before it moves anything. It then copies the
snapshot in under a temp name, raises the `events` and `media` counters, and only then moves
the live DB and its WAL to `/data/before-restore-<time>/` and renames the copy into place, so
no seq or media id a device has already seen is reused and a failed copy leaves the old file
untouched. The script restarts the server on any error or Ctrl-C, on the old file if the
snapshot was refused. A killed shell (a SIGKILL, or an SSH session that drops) can leave the
server stopped: run `docker start <container>` then. CI exercises the script on every run.

```sh
docker ps --filter name=brr                        # the container, brr-<uuid> in Coolify
scripts/restore.sh brr-<uuid>                      # newest snapshot in /backups
scripts/restore.sh brr-<uuid> brr-chat-20261024T120000000Z.db   # a specific one
scripts/restore.sh brr-<uuid> ~/brr-backups.tar.gz # an archive downloaded from Coolify
```

Every session created after the snapshot is lost, and those users sign in again. Devices keep
the events they cached from the lost window until those scroll out of the cap, and an op
against a group created in that window fails with `NotFound` and is dropped (ADR 0013). Only
ops still in the outbox are resent: a message the server acked after the snapshot is gone,
even though the device showed it as sent.

## Off-box copies

Every backup lives on the VPS disk until a remote destination exists (ADR 0023). If the
VPS is lost, all data is lost. Until there is an S3 destination, download the newest
archive from Coolify's Backups → Executions → **Download** at least weekly, and keep it
somewhere else. Adding S3 later is a Coolify setting on the same storage-backup schedule,
with no code change.

## Updates

Dependabot opens weekly PRs for base images, GitHub Actions and Bun packages. Merge them
when CI is green. A Bun image bump also needs `.bun-version` and the image line in
`compose.dev.yaml` updated in the same PR; `apps/server/test/container.test.ts` fails until
all three agree.
