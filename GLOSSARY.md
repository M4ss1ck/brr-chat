# Glossary

- **Server**: one isolated brr-chat community, a single binary plus one SQLite file. Never talks
  to other servers. Identified on a device by its origin (ADR 0020).
- **Account**: a user on one server. The same person on two servers has two unrelated accounts;
  a device holds one account per server.
- **Server list**: the servers this device knows, each with its own account, cursor, outbox and
  cached events. Adding one is a **server link** (a bare origin, `/signup/<token>` or
  `/join/<token>`) or the QR code that encodes the same link (ADR 0020).
- **Active server**: the entry in the server list whose groups, DMs and cursor are on screen.
  Switching is local; it never merges two servers' logs.
- **Recovery code**: 4×5 Crockford base32 characters shown once at signup and stored hashed. It is
  the only way back in when the password is lost and no session is left; losing it in that state
  loses the account (ADR 0006).
- **Passkey**: a WebAuthn credential held by the device, unlocked by its screen lock, fingerprint
  or a security key. The server stores only the public key; sign-in is username-less because the
  authenticator picks the account (ADR 0021).
- **Scope**: what an event belongs to, either a **group** or a **DM** (two users). Scope 0
  means server-wide.
- **Group**: a scope with members and roles (member, group admin, owner). Open (anyone can join)
  or invite-only. A **group admin** (`Role.Admin = 2`) is distinct from a **server admin**, the
  server-wide `admin` role in BetterAuth.
- **DM scope**: the one scope for an unordered pair of accounts. Its id is the `seq` of the
  `dm_scope` event that created it; there is exactly one per pair (ADR 0015).
- **Block**: one account's personal, silent refusal to receive another account's posts and DMs.
  Stored as server state; the blocked account is never told (ADR 0012).
- **Bulk delete**: one `delete_author` op by a group admin or the owner that removes every post
  and reply one account wrote in a group. The server expands it into individual `delete` events.
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
- **Media**: a post, reply or DM image. The event carries only `id`, `w`, `h` and a ThumbHash
  placeholder; the two WebP variants (320 px and 1280 px) are stored by the server and fetched
  only when the user taps (ADR 0011, ADR 0019).
- **Media quota**: the total bytes of stored image variants one server keeps (default 256 MB),
  checked and spent at upload, returned when a post is deleted.
- **Event**: one entry in the server's append-only log, `[tag, seq, ts, author, scope, ...]`.
- **Tag**: the integer that says what kind of event it is. Unknown tags are skipped.
- **Seq**: an event's position in the log, also the id of what it creates.
- **Cursor**: the last seq a client has applied. Sync returns everything after it.
- **Outbox**: ops one account on one server has queued and not yet had acked. It is per server,
  like the cursor.
- **Failed op**: a queued op one server refused for good (`NotFound`), kept locally with its
  drafted text and excluded from later syncs until the user discards it.
- **Op**: a client's request to create an event, carrying a **cid**.
- **cid**: 8 random bytes chosen by the device for an op, so retries never duplicate.
- **Ack**: the server's answer for one op, either the seq created or an error.
- **Event cache**: the bounded per-scope offline store of posts, replies and DMs (2,000 rows,
  newest page protected from eviction).
- **Media cache**: the durable 50 MB LRU of downloaded image bytes, separate from event rows.
- **Gap**: a marker for **messages and reactions** the server deliberately didn't send. Filled
  on request; control events (membership, bans, deletes, metadata) are never gapped (ADR 0019).
- **History**: older events in one scope, fetched only when the user asks.
- **Data meter**: the always-visible count of bytes this tab session and this device's calendar
  month. Every app request goes through it; both survive reloads, and the session ends when the
  tab closes (ADR 0018).
- **Protocol version**: the `v` in every request. Servers answer with the range they accept.
- **Fixture**: a frozen encoded message from one protocol version, decoded by CI forever.
