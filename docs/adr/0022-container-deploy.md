# 0022. Container deploy: compiled binary on distroless, built in CI, run by Coolify

Status: accepted (2026-10-24)

## Context
Production is one Coolify instance on an amd64 VPS. Development should start with one command
and reload on save. Both setups should be written down once and then only maintained, not
rediscovered. Several facts shaped the choices:

- Coolify redeploys a Docker Compose resource by stopping the old containers and then
  starting the new ones. It has no rolling updates for Compose. Its scheduled tasks run
  through `sh -c` inside the container.
- Behind Coolify's Traefik, the socket peer of every request is the proxy. The server keyed
  the ADR 0012 abuse limits on the socket peer, so in production everyone would have shared
  one budget of 3 signups an hour. Its header fallback trusted the *left-most*
  `X-Forwarded-For` entry, which any client can write.
- `--host` defaulted to `localhost`, so a container could not be reached from its proxy.

## Decision
- **The image is the binary and nothing else.** A multi-stage `Dockerfile` installs, builds
  the shell, compiles with `bun build --compile` (ADR 0002), and runs the byte-budget tests.
  The runtime stage is `gcr.io/distroless/cc-debian12:nonroot` (UID 65532) holding `/brr-chat`.
  It has no shell, no package manager and no `curl`. `HOST`, `PORT`, `DB_PATH` and
  `BACKUP_DIR` are baked in. A Server is still one binary plus one SQLite file.
- **CI builds and Coolify only runs.** The `image` job builds for `linux/amd64`, runs
  `scripts/smoke.sh` against that exact image, and on `main` pushes the same bytes to
  `ghcr.io/m4ss1ck/brr-chat` as `:sha-<short>` and `:main`. The `deploy` job then calls
  Coolify's deploy webhook. The VPS never builds: a build would compete with the live chat
  for CPU and RAM, and what ships is what passed the tests. Rollback is `BRR_IMAGE_TAG=sha-<short>`
  in Coolify, then a redeploy.
- **`compose.yaml` is the only place production config lives.** Coolify runs it as a
  Docker Compose resource. Its magic variables supply what must not be typed by hand:
  `SERVICE_URL_BRR` (from the domain) becomes `BASE_URL`, and `SERVICE_HEX_64_AUTHSECRET`
  (generated once, kept across deploys) becomes `BETTER_AUTH_SECRET`. The service runs with a
  read-only root, `cap_drop: [ALL]` and `no-new-privileges`, with no `ports:`. Its writable
  paths are the volumes `/data` and `/backups`, plus a 64 MB `/tmp` tmpfs for SQLite.
  `apps/server/test/container.test.ts` holds these guarantees in the gate lane.
- **Stop-then-start is correct here, not a limitation.** SQLite has one writer. Two
  containers on the same volume during a rolling update would be two writers and two sets
  of in-memory rate limits. The gap is a few seconds, and clients already queue ops in
  their outbox and retry (ADR 0013).
- **Client IP is the proxy's entry.** `TRUSTED_PROXY_HOPS=N` (default `0`) makes the abuse
  limits key on the Nth `X-Forwarded-For` entry from the right, the address the outermost
  trusted proxy saw (`apps/server/src/client-ip.ts`). A shorter chain falls back to the
  socket peer. With `0`, headers are never read. `compose.yaml` sets `1` for Traefik. A CDN in
  front of Traefik makes it `2`, and then the VPS firewall must accept traffic only from the
  CDN's IP ranges: a client reaching Traefik directly would otherwise control the entry the
  server reads. Leaving `1` behind a CDN keys every user on the CDN edge IP.
- **Health is the binary probing itself.** `GET /healthz` runs `SELECT 1` and answers
  `200`, or `503` when the DB is unreadable. It is public, `no-store` and never compressed.
  `brr-chat healthcheck` calls it on loopback and exits 0 or 1, so the Dockerfile
  `HEALTHCHECK` works with no shell. On SIGTERM the server drains requests, closes the DB
  (which checkpoints the WAL) and exits 0, inside a 30 s grace period.
- **The server owns compression.** It already picks brotli or `dcz` per response
  (ADR 0021). Coolify's proxy gzip is turned off for this resource. It is a UI toggle that
  Compose labels cannot express without Raw mode, so `docs/DEPLOY.md` lists it.
- **Development is `compose.dev.yaml`.** A one-shot `deps` service installs into named
  volumes, `web` runs `build --watch` (esbuild rebuilds and regenerates the embedded shell),
  and `server` runs `bun --watch` on `127.0.0.1:3000`. Both use the build stage's exact Bun
  image and run as the host UID, so the files they write stay the user's own. Running bare
  `bun` stays supported for tests and quick fixes.
- **Everything is pinned and updated by Dependabot.** Base images are pinned by digest and
  actions by commit SHA. Dependabot opens weekly PRs for `docker`, `github-actions` and
  `bun`. The Bun tag in the Dockerfile, `compose.dev.yaml` and `.bun-version` must agree, and
  `container.test.ts` fails until they do.

## Considered options
- *`bun src/index.ts` in `oven/bun`*: rejected. It is a larger image with a shell and
  package manager in production, and it is a second way to run the server next to the
  binary ADR 0002 committed to.
- *Coolify building from the Dockerfile*: rejected. It uses VPS resources, and the image
  that runs would not be the image that was tested.
- *A Coolify "Docker Image" resource*: rejected. Volumes, healthcheck and env names would
  live only in Coolify's database, not in git.

## Consequences
- Every deploy has a short outage (stop, then start). This is acceptable because of the
  outbox. It would only need revisiting if the server ever stopped being a single SQLite
  writer.
- The image is about 105 MB unpacked (`docker export`) and 47 MB compressed. `smoke.sh`
  enforces a 120 MB budget. A Bun upgrade that breaks it is a decision to make, not a
  number to raise quietly.
- The first account to sign up becomes server admin (ADR 0017). Continuous deploy makes a
  new domain public immediately, so the runbook has the operator sign up first.
  `BOOTSTRAP_ADMIN` is tracked as an issue.
- The GHCR package has to be public, or Coolify needs registry credentials. The runbook
  makes it public once.
