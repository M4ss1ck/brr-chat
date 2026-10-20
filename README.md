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
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)   # signs sessions; never defaulted (ADR 0007)
bun run --cwd apps/server dev         # serve /, /sync and auth + recovery on http://localhost:3000
```

Signup shows one recovery code, once, and will not finish until its last group is typed back.
Keep it: there is no email recovery and no admin reset (ADR 0006).

One binary, no files beside it:

```sh
bun run --cwd apps/server compile     # build the shell, then compile to apps/server/dist/brr-chat
bun run --cwd apps/server dev -- --help    # flags and env vars (PORT, DB_PATH, BASE_URL, BETTER_AUTH_SECRET)
```

Changing the protocol: read `docs/PROTOCOL.md` "Evolution rules", then run
`bun run --cwd packages/protocol freeze-fixtures` for any new fixture.
