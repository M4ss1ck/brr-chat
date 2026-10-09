# 0006. Account recovery by recovery code only

Status: accepted (2026-10-09)

## Context
Email is optional and unreliable for our users. BetterAuth's two-factor backup codes are for
login, not recovery.

## Decision
- At signup the server generates one recovery code: 4 groups of 5 Crockford base32 characters
  (100 bits). It is shown once and stored as a hash. You have to type back the last group to
  finish signing up.
- While signed in, you can regenerate the code, which invalidates the old one.
- Redeeming the code is rate-limited per IP and per username. It signs you in, forces a new
  code, and revokes all other sessions.
- There is no email recovery and no admin reset. If you lose both the code and every session,
  the account is gone, and the signup screen says so plainly.

## Consequences
A custom flow of about 100 lines plus tests in `apps/server`. Admins can't take over accounts,
by design.
