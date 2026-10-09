# brr-chat wire protocol (v1)

The contract between a client and one server. It is written for people. The code in
`packages/protocol` is the reference implementation, and `packages/protocol/fixtures/` is the
proof that the code matches this document.

## Goals

Bytes are money for our users (the reference case is a Cuban mobile connection: high latency,
intermittent, billed per MB). Every rule below exists to send fewer bytes or fewer round trips.

| Budget (CI-enforced, `test/budget.test.ts`) | Limit | v1 actual |
|---|---|---|
| Empty sync payload (request + response) | 1 KB | 19 B |
| 100 text posts in one response, uncompressed | 20 KB | 13,859 B (17.1 B/post framing) |
| Image placeholder (whole media field) | 40 B | 39 B worst case |
| App shell, compressed | 150 KB | not built yet (apps/web) |

## Transport

- `POST /sync` and `POST /history`. Body and response are a single CBOR value
  (`Content-Type: application/cbor`).
- `Authorization: Bearer <32-char session token>` (bare token, ADR 0007).
- Responses are brotli-compressed, or `dcz` (shared-dictionary) where the client supports it.
- Media is never inline. `GET /m/{id}?w=<width>` fetches an image, and only when the user taps.

## Encoding rules

- **Positional arrays, not maps.** Every structure is a CBOR array. A field's meaning is its
  position. No key names on the wire.
- **Integers use the shortest CBOR form.** Ids, seqs and timestamps are unsigned integers.
- The protocol **emits** only: uint, negative int (ack errors only), text, bytes, bool, null, array.
  It never emits maps, floats or CBOR tags.
- A trailing optional field that is `null` is **omitted**. A missing optional field decodes as `null`.
- Text fields are at most 4000 UTF-8 bytes.

## Evolution rules (ADR 0004)

1. Fields are only ever **appended**, never reordered, retyped or removed.
2. A field appended after v1 must be optional. Older peers simply don't see it.
3. Decoders **ignore** fields past the ones they know, and anything inside them (even maps).
4. A new event type is a **new tag**. Decoders skip unknown tags and count them (`skipped`).
   Neither case is an error.
5. Tags are never reused. Tag 7 is reserved (it was `friend_state`, dropped before v1).
6. Anything an old client would misread gets a **version bump**, an ADR and a new fixture
   directory `fixtures/vN/`. Fixtures from every older version must still decode (CI gate).

## Version handshake

Every request starts with `v`, the version the client speaks. Every response starts with
`vMin, vMax`, the versions the server accepts. The server reads `v` before anything else
(`readVersion`), so it can answer even when it cannot parse the rest of the request.

| Client `v` | Server answers |
|---|---|
| `vMin ≤ v ≤ vMax` | normal response |
| `v < vMin` | response with `error = 1` (ClientTooOld) and no events: the client must update |
| `v > vMax` | response with `error = 2` (ClientTooNew) and no events: the server is outdated |

The client caches `[vMin, vMax]`. When a newer version exists, it shows "update available"
before the server stops accepting its version.

## `POST /sync`

```
SyncRequest  = [v: uint, cursor: uint, outbox: [* Op]]
SyncResponse = [vMin: uint, vMax: uint, cursor: uint, more: bool, events: [* Event], acks: [* Ack], ? error: uint]
Ack          = [cid: bytes .size 8, result: int]   ; result > 0: seq of the created event; < 0: -AckError
```

- `cursor` is the last `seq` the client has applied. A fresh device sends `0`.
- The server returns events with `seq > cursor` that the user may see, oldest first, and the new
  cursor.
- **Paging:** a response holds at most ~500 events or ~64 KB. `more = true` means "call again
  now".
- **Gaps:** after a long time offline, if more than 100 events are missing in one scope, the
  server sends a `Gap` event instead of the excess. The gap is filled only when the user asks
  (`/history`).
- **Fresh device or new join:** the server sends current state (profiles, group metadata,
  memberships) and a cursor at the head of the log. **No posts.** Older posts load only when the
  user asks.
- **Outbox:** each op carries a `cid`, 8 random bytes chosen by the device. A retry resends the
  same `cid`. The server remembers `cid → seq` for 30 days and returns the original seq instead of
  creating a duplicate. Every op gets exactly one ack. An op with an unknown
  tag gets `AckError.Unsupported`. A malformed op with a readable `cid` gets `AckError.Invalid`.
  Neither fails the rest of the batch, so one bad op can't block a device's outbox.
- **Malformed events** in a response are dropped and counted, like unknown tags. One bad event
  must not block a client's sync.

`AckError`: 1 Unsupported, 2 Forbidden, 3 Invalid, 4 NotFound, 5 RateLimited.

## `POST /history`

Older events in one scope, on explicit user request only.

```
HistoryRequest  = [v: uint, scope: uint, before: uint, limit: uint]   ; limit 1..100
HistoryResponse = [vMin: uint, vMax: uint, events: [* Event], more: bool, ? error: uint]
```

Returns visible events in `scope` with `seq < before`, newest first. `more` means older events
exist.

## Events

```
Event = [tag: uint, seq: uint, ts: uint, author: uint, scope: uint, ...fields]
Op    = [cid: bytes .size 8, tag: uint, scope: uint, ...fields]
```

- `seq` is the event's position in the server's single append-only log. It is also the id of the
  thing the event creates (a post's id is its seq).
- `ts` is Unix seconds. `author` is the acting user, or 0 for server-generated events. `scope` is
  a group or DM scope id, or 0 for server-wide events (profiles, server bans).
- An op has the same fields as the event it asks for. The server fills in seq, ts and author. A
  client may send only the tags marked "op".

| Tag | Name | Fields after the header | Op | Notes |
|---|---|---|---|---|
| 1 | post | `text, ? media` | yes | group scopes only |
| 2 | reply | `parent: uint, text, ? media` | yes | one level: `parent` must be a post |
| 3 | dm | `peer: uint, text, ? media` | yes | op with `scope = 0` opens a DM with `peer` |
| 4 | reaction | `target: uint, emoji: uint 0..7, on: bool` | yes | fixed 8-emoji palette, toggled |
| 5 | delete | `target: uint` | yes | the author, or a moderator/admin |
| 6 | profile | `username, displayName, bio` | yes | `scope = 0`. Avatars are identicons from the user id |
| 7 | *reserved* | | | never reuse |
| 8 | group_meta | `name, about, open: bool` | yes | op with `scope = 0` creates a group |
| 9 | membership | `user: uint, role: uint 0..3` | yes | 0 none (left), 1 member, 2 moderator, 3 admin |
| 10 | ban | `user: uint, on: bool` | yes | `scope = 0`: server ban (admin), else group ban |
| 11 | scope_left | `purge: bool` | no | the viewer lost access to `scope`. `purge`: delete cached posts |
| 12 | gap | `after: uint, before: uint, count: uint` | no | `count` events in `(after, before)` not sent |

```
Media = [id: uint, w: uint, h: uint, thumbhash: bytes .size (0..32)]
```

`thumbhash` is a [ThumbHash](https://evanw.github.io/thumbhash/) placeholder (about 21–25 bytes),
shown blurred until the user taps to load `GET /m/{id}`.

## Scopes and visibility

A scope is either a **group** or a **DM** between two users. There is no friends feed.

- A user sees an event if they currently have access to its scope: they are a member of the
  group (or the group is open and they joined), or they are one of the two DM participants.
  Scope-0 events are visible to everyone on the server.
- The server works out the viewer's scope set once per request and filters the log by it.
- When a user is kicked or banned from a scope, they get `scope_left` with `purge = true`, and
  the client deletes its cached posts from that scope.
