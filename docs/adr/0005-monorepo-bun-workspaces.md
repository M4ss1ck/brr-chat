# 0005. Monorepo with Bun workspaces only

Status: accepted (2026-10-09)

## Decision
`packages/protocol`, `apps/server`, `apps/web` and `apps/native` live in one repo and are linked
by Bun workspaces. No Turborepo or Nx: four packages don't need a task graph.

`packages/protocol` is pure. Its tsconfig allows only ES2022 globals (no DOM, Bun or Node types),
and `test/boundary.test.ts` fails if `src/` imports anything other than its own files and the
CBOR library.

The gate is `bun run check` (typecheck every workspace, then `bun test`), run by
`.githooks/pre-commit`. `bun install` points git at that hook via the `prepare` script.
