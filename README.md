# brr-chat

A small, data-saving social network for groups and DMs, built for slow, expensive, intermittent
connections. Each server is an isolated community. The client can hold accounts on several servers.

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
bun run --cwd apps/server dev         # serve /, /sync and /api/auth on http://localhost:3000
```

One binary, no files beside it:

```sh
bun run --cwd apps/server dev -- --help    # flags and env vars (PORT, DB_PATH, BETTER_AUTH_SECRET, BASE_URL)
```

Changing the protocol: read `docs/PROTOCOL.md` "Evolution rules", then run
`bun run --cwd packages/protocol freeze-fixtures` for any new fixture.
