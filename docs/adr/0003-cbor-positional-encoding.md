# 0003. CBOR with positional arrays; tiny-cbor behind a seam

Status: accepted (2026-10-09)

## Decision
The wire format is CBOR, and every structure is a positional array with integer tags (see
`docs/PROTOCOL.md`). The schema lives in one table (`SCHEMA` in `packages/protocol/src/events.ts`),
and the TypeScript types are derived from it, so adding an event type is one row.
Frozen fixtures, not a CDDL toolchain, are the executable spec.

Library: `@levischuck/tiny-cbor` 0.3.6, which is used only in `src/cbor.ts`.

| Library | Minified | gzip -9 | Notes |
|---|---|---|---|
| @levischuck/tiny-cbor 0.3.6 | 5.6 KB | 2.1 KB | MIT; shortest-form ints, bytes, rejects truncation |
| cborg 6.1.3 | 25.9 KB | 7.9 KB | |
| cbor-x 1.6.6 | 29.7 KB | 10.7 KB | fastest, largest |

Measured 2026-10-09 with `bun build --minify --target browser` on an encode+decode import.

## Rejected
- Maps with short string keys: self-describing, but about 30% more bytes per event.
- CDDL plus codegen: formal, but adds tooling that Andy would also have to review.

## Consequences
- The decoder does no subset check: unknown content passes through, and each field decoder
  validates what it reads. This is what lets old clients skip new data (ADR 0004).
- If tiny-cbor stalls, cborg is the drop-in fallback (+6 KB gz), behind the same seam.
