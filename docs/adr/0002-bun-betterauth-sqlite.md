# 0002. Server on Bun + BetterAuth + bun:sqlite, as a single binary

Status: accepted (2026-10-09)

## Decision
TypeScript on Bun 1.4, `bun:sqlite`, compiled with `bun build --compile`. Auth is BetterAuth
1.7.x with the username, bearer, admin and passkey (`@better-auth/passkey`) plugins.
Telemetry is disabled. No social sign-in at launch (it may not work from Cuba). Sessions use
opaque tokens, never JWTs.

Go was considered and dropped because BetterAuth only exists for TypeScript.

## Verified (spike, 2026-10-09, inside a compiled binary)
- `getMigrations(auth.options).runMigrations()` creates tables at startup.
- Username sign-up and sign-in, bearer sessions on custom routes (`auth.api.getSession`), passkey
  register options, revocation on sign-out, and admin `role`/`banned` fields all work.
- The binary is about 84 MB, mostly the runtime. Users never download it.
- BetterAuth logs a false "schema mismatch" on first boot. Run migrations before it initializes.
- BetterAuth requires an email on every user. We store `<username>@<host>.invalid`, and passkey
  prompts show the username, not that address.
