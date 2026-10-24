# brr-chat

A small, data-saving social network for groups and DMs, built for slow, expensive, intermittent
connections. Each server is an isolated community. The client holds several servers at once, like
networks in an IRC client: one account, one cursor and one `/sync` per server, added by a link or
a QR code (ADR 0020). Messages composed offline wait in a durable outbox and drain when the link
returns; the local event cache is capped at 2,000 per scope and the media cache at 50 MB
(ADR 0013). An always-visible data meter counts bytes on the wire for this tab session and this
calendar month, split by server once there is more than one; both survive reloads (ADR 0018).

| Path | What |
|---|---|
| `packages/protocol` | The wire contract: CBOR codecs, version handshake, frozen fixtures, byte budgets. Pure TS. |
| `apps/server` | Bun + BetterAuth + bun:sqlite, `POST /sync`, the embedded PWA shell. `bun build --compile` gives one binary. |
| `apps/web` | Vanilla TS PWA (auth, IndexedDB cursor, service worker) inside a 150 KB compressed shell budget. |
| `apps/native` | Tauri 2 shell around `apps/web`. *(not scaffolded)* |
| `docs/PROTOCOL.md` | The protocol, for people. |
| `docs/adr/` | Decisions and why. |

```sh
bun install        # also points git at .githooks (pre-commit runs `bun run check`)
bun run check      # typecheck every workspace + all tests
bun test --cwd packages/protocol    # protocol tests only; prints byte-budget numbers
```

Run the server and the PWA from source:

```sh
bun run --cwd apps/web build          # build the app shell and regenerate the server's embedded copy
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)   # signs sessions; never defaulted (ADR 0007)
bun run --cwd apps/server dev         # serve /, /sync and auth + recovery on http://localhost:3000
```

Or run it in containers, which reloads on save (prefix `HOST_UID=$(id -u) HOST_GID=$(id -g)` to
the command if your ids are not 1000):

```sh
docker compose -f compose.dev.yaml up   # http://localhost:3000
```

`docs/DEPLOY.md` has the production runbook; `scripts/smoke.sh` builds the production image
and tests it.

Open **Add server** to paste a server address or an invite link from another server, or to scan
its QR code with the camera or an image file. The code is decoded on the device. Each server's
account, cursor and cached messages stay separate; **Sync** catches up every signed-in server.

Signup shows one recovery code, once, and will not finish until its last group is typed back.
Keep it: there is no email recovery and no admin reset (ADR 0006).

A signed-in account can add a passkey and then sign in with the device's screen lock or a
security key, no username needed (ADR 0021). The WebAuthn browser library is a separate
`/passkey.js` chunk, fetched only when a passkey button is pressed, so the first load does not
pay for it.

The first account on a fresh server is its **server admin** (ADR 0017). That account sees a
"Server administration" panel: registration mode (open / invite / closed), an emergency freeze
switch, the server invite link for `invite` mode (`/signup/<token>`), and every account
with a server-wide ban switch. A server ban revokes all of that account's sessions, removes it
from every group and DM, and tells its devices to purge those scopes. Change the policy over
JSON if you prefer:

```sh
# TOKEN is any signed-in server admin's 32-char bearer token.
curl -X POST http://localhost:3000/api/server/settings \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"invite","frozen":false}'
```

One binary, no files beside it:

```sh
bun run --cwd apps/server compile     # build the shell, then compile to apps/server/dist/brr-chat
bun run --cwd apps/server dev -- --help    # flags and env vars (PORT, HOST, DB_PATH, BASE_URL,
                                           # BETTER_AUTH_SECRET, MEDIA_QUOTA_BYTES,
                                           # TRUSTED_PROXY_HOPS, BACKUP_DIR, BACKUP_INTERVAL_HOURS,
                                           # BACKUP_KEEP), plus the healthcheck and restore subcommands
```

Photos are resized in the client to 320 px and 1280 px WebP variants with a ThumbHash
placeholder, stored in the same SQLite file as the event log, and fetched only when the user
taps. The total stored media is capped per server (`MEDIA_QUOTA_BYTES` or `--media-quota`,
default 256 MB); an oversized, wrong-type, or over-quota upload is refused with a clear code.

Changing the protocol: read `docs/PROTOCOL.md` "Evolution rules", then run
`bun run --cwd packages/protocol freeze-fixtures` for any new fixture.
