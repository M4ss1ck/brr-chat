# brr-chat

A small, data-saving social network for groups and DMs, built for slow, expensive, intermittent
connections. Each server is an isolated community. The client can hold accounts on several servers.
Messages composed offline wait in a durable outbox and drain when the link returns; the local
event cache is capped at 2,000 per scope and the media cache at 50 MB (ADR 0013). An
always-visible data meter counts bytes on the wire for this tab session and this calendar
month; both survive reloads (ADR 0018).

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

Signup shows one recovery code, once, and will not finish until its last group is typed back.
Keep it: there is no email recovery and no admin reset (ADR 0006).

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
bun run --cwd apps/server dev -- --help    # flags and env vars (PORT, DB_PATH, BASE_URL, BETTER_AUTH_SECRET, MEDIA_QUOTA_BYTES)
```

Photos are resized in the client to 320 px and 1280 px WebP variants with a ThumbHash
placeholder, stored in the same SQLite file as the event log, and fetched only when the user
taps. The total stored media is capped per server (`MEDIA_QUOTA_BYTES` or `--media-quota`,
default 256 MB); an oversized, wrong-type, or over-quota upload is refused with a clear code.

Changing the protocol: read `docs/PROTOCOL.md` "Evolution rules", then run
`bun run --cwd packages/protocol freeze-fixtures` for any new fixture.
