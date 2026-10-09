# Glossary

- **Server**: one isolated brr-chat community, a single binary plus one SQLite file. Never talks
  to other servers.
- **Account**: a user on one server. The same person on two servers has two unrelated accounts.
- **Scope**: what an event belongs to, either a **group** or a **DM** (two users). Scope 0
  means server-wide.
- **Group**: a scope with members and roles (member, moderator, admin). Open (anyone can join)
  or invite-only.
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
- **Protocol version**: the `v` in every request. Servers answer with the range they accept.
- **Fixture**: a frozen encoded message from one protocol version, decoded by CI forever.
