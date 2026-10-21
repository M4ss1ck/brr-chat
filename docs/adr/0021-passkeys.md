# 0021. Passkeys, with the WebAuthn work kept out of the first load

Status: accepted (2026-10-20)

## Context
Issue #19 adds a second way in: register a passkey on a signed-in account, then sign in with
the device's screen lock, fingerprint or a security key. Password and recovery code stay.

Three existing decisions shape the implementation:

- Accounts have no email. Signup stores a placeholder address of the form
  `<username>@<host>.invalid` (ADR 0006), and BetterAuth's passkey plugin builds its prompt
  from `session.user.email`, so an unmodified plugin would offer the prompt
  `alice@chat.local.invalid`.
- The shell has a 150 KB compressed budget, and ADR 0014 already says the WebAuthn browser
  library must be a lazy import.
- Sessions are bare bearer tokens, and the server strips every cookie it would set so no
  browser carries ambient authority to the API (ADR 0007, ADR 0020). BetterAuth's passkey
  plugin keeps its in-flight challenge in a short-lived signed cookie, which that rule would
  delete before the browser could return it.

## Decision
- **Server plugin.** `@better-auth/passkey` 1.7.7, the same version as `better-auth`. Its
  `passkey` table is created by the normal migration. The RP ID is the hostname of `baseURL`
  and the RP name is `brr chat`. Registration asks for `residentKey: "required"`: sign-in is
  username-less, so a non-discoverable credential would be invisible at the prompt. The
  verify endpoints compare the response with the request's `Origin`, which the browser sets
  and the page cannot forge.
- **The prompt names the account.** An `after` hook on
  `/passkey/generate-register-options` rewrites `user.name` and `user.displayName` to the
  session's username. This is the one place BetterAuth's placeholder email would otherwise
  reach a platform dialog.
- **Sign-in is username-less.** The authenticator resolves the account from its resident
  credential, so the sign-in form does not ask for a username. `verify-authentication` returns
  `{ session, user }`; the client reads `session.token`, stores that bare 32-character token
  like a password sign-in, and checks whether the recovery-code type-back is still pending.
- **The browser library is a separate bundle.** `@simplewebauthn/browser` lives in
  `src/passkey.ts`, built to `/passkey.js` like `/qr-scan.js`. The shell loads it with a
  computed URL only when a passkey button is pressed, so the first load does not include it.
  The budget gate still sums every file, as it already does for the QR scanner; with the
  passkey chunk the first load is 36,821 B compressed and every file together is 66,456 B of
  the 150 KB budget. The service worker caches the chunk after the first ceremony, not at
  install.
- **One cookie survives, and only for the ceremony.** On a same-origin request under
  `/api/auth/passkey/`, the response filter keeps the `better-auth-passkey` challenge cookie
  and deletes every other `Set-Cookie`, including the session. Same-origin means the
  configured `baseURL` origin, so a TLS proxy that differs from the listener address still
  works. The challenge cookie carries no identity: it is a random token for one unused
  challenge, expires in five minutes, and is consumed by the verification request.
  Cross-origin requests still get no cookie at all.
- **Passkeys are tied to the serving origin.** WebAuthn RP IDs are domain-scoped, so a
  client served by server A cannot run a ceremony for server B. The passkey buttons are hidden
  when the active server is not the one that served the app; B still accepts a passkey
  created by a client B served itself.
- **Adding a passkey needs a recent sign-in.** The plugin's fresh-session rule is left at
  BetterAuth's one-day default, so a stolen long-lived token cannot silently attach a new
  credential. The UI explains that signing out and back in is the fix.

## Consequences
- The `passkey` table is part of the SQLite file and its backup. It holds public keys,
  credential ids, counters and optional labels only.
- Chromium and Firefox both complete registration and username-less sign-in against the real
  endpoints; the server test drives the same wire format with a software P-256 authenticator,
  so the gate does not need a browser. Chromium records resident credentials, which is what
  makes the username-less flow work.
- Password and recovery code remain the fallback. Losing every passkey and the password still
  needs the recovery code, exactly as ADR 0006 says. The admin plugin's banned-user session
  hook also runs for the session a passkey creates, so a server ban blocks passkey sign-in
  just like password sign-in.
- There is no passkey list or delete screen yet. A person with several devices adds one per
  device; removing one is a follow-up that needs the plugin's list and delete endpoints in the
  UI.
