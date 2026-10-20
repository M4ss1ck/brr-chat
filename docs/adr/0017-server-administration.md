# 0017. Server administration: registration policy, server invite links, and ban blast radius

Status: accepted (2026-10-20)

## Context
ADR 0012 decides that a server admin can switch registration between `open`, `invite` and
`closed`, freeze signups, and ban an account server-wide. It does not say where that policy
lives, how an invite link is presented, how a fresh server gets its first admin, or how far a
server ban reaches. Without those decisions the rules exist only on paper: a new install has
no admin, and an invite mode has no link to hand out.

The group slices already establish two patterns worth reusing: a single rotatable token is a
capability that never enters the event log (ADR 0016), and JSON routes beside `/sync` carry
secrets and admin actions without spending wire bytes.

## Decision
- **One settings row.** `server_settings` is a singleton (`id = 1`) holding
  `registration_mode`, `registration_frozen` and the current `invite_token`. `openDb` inserts
  the row with `open`, unfrozen, no token. Every signup reads it at request time, so a mode
  change or freeze applies to the next signup with no restart and no cache to invalidate.
- **First account is the bootstrap admin.** After the first account finishes signup by typing
  back its recovery code, `promoteBootstrapAdmin` makes the account a BetterAuth `admin` when
  no other admin exists. Promoting only after confirmation matters: an abandoned signup must
  not hold the server's only admin role. This is one SQL statement, so two simultaneous
  confirmations cannot both see "no admin". The same rule repairs a server whose last admin was
  removed. Without it a fresh binary is unadministrable.
- **Server invite links are `/signup/<token>`.** One live token per server, generated when
  invite mode is first selected or on the first rotation, replaceable in one `UPDATE`. The
  token is a capability and never enters the event log. The signup request carries it in an
  `invite` JSON field; the recovery service reads it, then strips it before forwarding the body
  to BetterAuth, so an unknown field never reaches the user row. Open mode ignores a token;
  invite mode requires an exact match; closed mode and the freeze reject every signup. A body
  that is not JSON is left for BetterAuth to reject.
- **One administration surface.** The BetterAuth admin plugin still supplies the `role` and
  `banned` columns, but its own `/api/auth/admin/*` routes are answered `404`: they would be a
  second signup and ban path around the registration gate and the purge transaction.
  `GET /api/server/settings` returns the policy to any signed-in account and the invite link
  only to an admin. `POST /api/server/settings` changes `mode` and/or `frozen`;
  `POST /api/server/invite/rotate` replaces the link; `GET /api/server/users` lists every
  account with the wire id a ban needs (allocating one for an account that never synced).
  `GET /api/server/registration` is public so the sign-in screen can explain why signup is
  unavailable. Every mutating route checks the `admin` role server-side; the PWA hiding the
  panel is convenience only.
- **A server ban reaches every scope.** The existing `ban` op with `scope = 0` now revokes every
  BetterAuth session row for the target in the same transaction, removes every group
  membership, hands owned groups on, and records `scope_left` with `purge = true` for every
  group and every DM scope the account was in. DM scope rows stay, so the other participant
  keeps their side of the history; lifting the ban clears the DM purge marks because a DM has
  no join, while group purge marks stay until a new join. Recovery redemption refuses a banned
  account, because a recovery code must not mint a fresh session around the ban. Lifting a ban
  restores the account and its DMs, not the revoked sessions or the old group roles.
- **No protocol version bump.** No tag, field or sync shape changed. Registration policy and
  invite tokens travel over JSON beside `/sync`; the ban keeps tag 10 and only gains server
  behaviour.

## Consequences
- A fresh server always has an administrator, and the first person to sign up is trusted with
  that job. Operators who do not want that must close registration immediately after setup.
- One shared server invite link is simple and revocable, but it is not per-person: rotating it
  invalidates every unopened link at once. Per-invite expiry, usage caps and multiple live
  links are deliberately out of scope.
- The signup rate limit from ADR 0012 (3/hour per IP, `apps/server/src/limits.ts`) is enforced
  before this policy gate; a rejected attempt refunds its budget slot.
- A banned account cannot sign in, sync, redeem recovery, or use an admin route. Its old
  bearer tokens are dead because the session rows are gone, not merely because `/sync` checks
  the flag.
- The gate is read at the start of each signup. A request already in flight when an admin
  freezes or closes registration can still finish; there is no lock held across account
  creation, and the next signup is refused.
