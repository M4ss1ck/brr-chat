# 0007. Send the bare 32-char session token, not the signed one

Status: accepted (2026-10-09)

## Context
The BetterAuth bearer plugin issues `<token>.<hmac>` (77 bytes). By default it also accepts the
bare 32-character token (`requireSignature: false`). The bare token saves about 45 bytes on
every request.

## Findings (better-auth 1.7.7 source, `dist/plugins/bearer/index.mjs`)
- For a bare token, the server **signs it with its own secret and then verifies that
  signature**. The HMAC adds nothing on the wire: holding the 32 characters is exactly as good as
  holding the signed form.
- `session.token` is stored in plaintext (`dist/db/internal-adapter.mjs:273`, `generateId(32)`).
  With `requireSignature: true`, someone who reads the SQLite file but doesn't have
  `BETTER_AUTH_SECRET` can't use the tokens. With bare tokens accepted, **read access to the
  database alone is enough to hijack sessions.**
- 32 alphanumeric characters is about 190 bits, so guessing tokens or timing the lookup is not
  a threat. (The alphabet wasn't checked against `@better-auth/utils`.)

## Decision
Bare tokens. Someone who can read the database can already read every post and DM, so the
signature would protect sessions only, not data. Mitigations:
- Create the database file with mode `0600`.
- Document that backups contain live sessions.
- Short sliding session lifetime.
- One-tap "sign out all devices".

## Revisit if
BetterAuth changes the default, or we start hashing session tokens at rest.
