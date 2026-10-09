# 0004. Protocol versioning from day one

Status: accepted (2026-10-09)

## Context
Servers are self-hosted and the PWA is cached, so clients and servers will run different
versions for months.

## Decision
- Every request starts with `v`, and every response starts with `[vMin, vMax]`. Out-of-range
  requests get an upgrade error, never a parse failure (`readVersion` reads only the head).
- Compatible changes don't bump the version: append optional fields, add new tags. Decoders
  skip unknown tags and ignore extra fields.
- Any change an old peer would misread bumps the version, needs an ADR, and gets a new
  `fixtures/vN/` directory.
- Fixtures are written once by `bun run freeze-fixtures` and never overwritten. CI decodes every
  fixture of every version, and current-version fixtures must re-encode byte-for-byte.
- Tags are never reused (7 is reserved).
