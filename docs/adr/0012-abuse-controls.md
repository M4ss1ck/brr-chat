# 0012. Registration modes, rate limits, DM cooldown, and silent blocking

Status: accepted (2026-10-14)

## Context
There is no friend graph, and any account on a server can DM any other account (ADR 0008). Open
servers therefore face signup floods, DM spam, and harassment unless the server enforces controls
without adding protocol round-trips.

## Decision
- Registration modes and freeze switch: a server admin configures registration as `open` (anyone
  can sign up), `invite` (requires a server invite link managed by a server admin), or `closed`
  (no new signups). A single emergency freeze switch immediately halts new registrations regardless
  of mode.
- Server bans: a server ban (`ban` op with `scope = 0`, issued by a server admin) revokes all
  BetterAuth sessions for that user and emits `scope_left` with `purge = true` across every scope
  they belonged to.
- Rate limits: the server enforces fixed per-account and per-IP budgets: posts and DMs at `30/min`
  per account, new DM threads at `10/day` per account, and signups at `3/hour` per IP. Exceeding an
  op limit returns a `RateLimited` ack (`AckError.RateLimited = 5`), not an HTTP error, so the rest
  of the outbox batch still processes.
- 24h DM cooldown for new accounts: accounts younger than `24h` cannot open new DM threads (the op
  receives a `Forbidden` ack), matching the `24h` age gate for group creation (ADR 0010); they can
  still reply in DMs opened by an older account.
- Silent server-enforced per-user block: any user can block another user on the server. Blocking is
  silent: when a blocked user attempts to open a DM or send a DM to the blocker, the server returns
  a normal success ack to the sender so the block is not revealed, never delivers the DM to the
  blocker, and hides the blocked user's posts in groups on the blocker's devices.

## Consequences
- Server admins can contain signup raids with one switch or run invite-only communities without code
  changes.
- Rate-limited ops fail individually via `AckError.RateLimited` instead of wedging the device's
  outbox.
- Silent server-enforced blocking prevents blocked users from probing whether they were blocked or
  burning the blocker's bandwidth.
