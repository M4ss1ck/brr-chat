# Glossary

- **Server**: one isolated brr-chat community, a single binary plus one SQLite file. Never talks
  to other servers.
- **Account**: a user on one server. The same person on two servers has two unrelated accounts.
- **Recovery code**: 4×5 Crockford base32 characters shown once at signup and stored hashed. It is
  the only way back in when the password is lost and no session is left; losing it in that state
  loses the account (ADR 0006).
- **Scope**: what an event belongs to, either a **group** or a **DM** (two users). Scope 0
  means server-wide.
- **Group**: a scope with members and roles (member, group admin, owner). Open (anyone can join)
  or invite-only. A **group admin** (`Role.Admin = 2`) is distinct from a **server admin**, the
  server-wide `admin` role in BetterAuth.
- **DM scope**: the one scope for an unordered pair of accounts. Its id is the `seq` of the
  `dm_scope` event that created it; there is exactly one per pair (ADR 0015).
- **Block**: one account's personal, silent refusal to receive another account's posts and DMs.
  Stored as server state; the blocked account is never told (ADR 0012).
- **Invite link**: an invite-only group's one URL (`/join/<token>`) and the QR code that encodes
  it. Group admins and the owner can rotate it; the old token stops working at once, while
  existing members stay (ADR 0016).
- **Server admin**: the BetterAuth server-wide `admin` role, distinct from a group admin. The
  first account on a fresh server becomes one so somebody can administer it (ADR 0017).
- **Registration mode**: server policy for new accounts: `open`, `invite` (a server invite link
  is required), or `closed` (no new accounts). A separate **freeze** switch rejects every
  signup regardless of mode (ADR 0012).
- **Server invite link**: a server's one URL (`/signup/<token>`) for creating an account in
  `invite` mode. A server admin can rotate it; the old link stops working at once (ADR 0017).
- **Event**: one entry in the server's append-only log, `[tag, seq, ts, author, scope, ...]`.
- **Tag**: the integer that says what kind of event it is. Unknown tags are skipped.
- **Seq**: an event's position in the log, also the id of what it creates.
- **Cursor**: the last seq a client has applied. Sync returns everything after it.
- **Outbox**: ops the device has queued and not yet had acked.
- **Op**: a client's request to create an event, carrying a **cid**.
- **cid**: 8 random bytes chosen by the device for an op, so retries never duplicate.
- **Ack**: the server's answer for one op, either the seq created or an error.
- **Gap**: a marker for events the server deliberately didn't send. Filled on request.
- **History**: older events in one scope, fetched only when the user asks.
- **Data meter**: the always-visible count of bytes this tab session and this device's calendar
  month. Every app request goes through it; both survive reloads, and the session ends when the
  tab closes (ADR 0018).
- **Protocol version**: the `v` in every request. Servers answer with the range they accept.
- **Fixture**: a frozen encoded message from one protocol version, decoded by CI forever.
