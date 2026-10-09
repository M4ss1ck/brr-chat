# brr-chat

A small, data-saving social network for groups and DMs, built for slow, expensive, intermittent
connections. Each server is an isolated community. The client can hold accounts on several servers.

| Path | What |
|---|---|
| `packages/protocol` | The wire contract: CBOR codecs, version handshake, frozen fixtures, byte budgets. Pure TS. |
| `apps/server` | Bun + BetterAuth + bun:sqlite, `POST /sync`. *(placeholder)* |
| `apps/web` | Vanilla TS PWA. *(placeholder)* |
| `apps/native` | Tauri 2 shell around `apps/web`. *(not scaffolded)* |
| `docs/PROTOCOL.md` | The protocol, for people. |
| `docs/adr/` | Decisions and why. |

```sh
bun install        # also points git at .githooks (pre-commit runs `bun run check`)
bun run check      # typecheck every workspace + all tests
bun test --cwd packages/protocol    # protocol tests only; prints byte-budget numbers
```

Changing the protocol: read `docs/PROTOCOL.md` "Evolution rules", then run
`bun run --cwd packages/protocol freeze-fixtures` for any new fixture.
