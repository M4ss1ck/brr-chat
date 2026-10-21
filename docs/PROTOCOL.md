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
| App shell, compressed | 150 KB | 66,456 B total; 36,821 B first load (the QR reader and passkey prompt are on demand) |

## Transport

- `POST /sync` and `POST /history`. Body and response are a single CBOR value
  (`Content-Type: application/cbor`).
- `Authorization: Bearer <32-char session token>` (bare token, ADR 0007).
- `/sync` answers `401` without a valid session, and `403` while a signup's recovery code has
  not been confirmed (ADR 0006).
- Responses are brotli-compressed, or `dcz` (shared-dictionary) where the client supports it.
- Media is never inline. `GET /m/{id}?w=<width>` fetches an image, and only when the user taps.
  The upload is one `POST /m` multipart request; both require the bearer session (ADR 0019).

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
- **Gaps:** after a long time offline, if more than 100 missed **posts, replies, DMs or
  reactions** are waiting in one scope, the server sends those newest 100 and a `Gap` event in
  place of the excess. The gap is filled only when the user asks (`/history`). Control events
  (membership, bans, deletes, bulk-delete markers, profiles, group metadata) are always sent,
  however old they are, so group state never goes stale behind a gap. A `Gap`'s `after` is the
  cursor the catch-up started from and `before` is the seq of the first gap-covered event still
  sent, so `before` is the right argument for the first `/history` call (ADR 0019).
- **Fresh device or new join:** the server sends current state (profiles, group metadata,
  memberships, the viewer's `dm_scope` events) and a cursor at the head of the log. **No
  posts or DM messages.** Older posts load only when the user asks. A state snapshot may repeat an event at or below the device's previous cursor; the
  client applies it by `seq` and then moves to the returned cursor.
- **Outbox:** each op carries a `cid`, 8 random bytes chosen by the device. A retry resends the
  same `cid`. The server remembers `cid → seq` for 30 days and returns the original seq instead of
  creating a duplicate. Every op gets exactly one ack. An op with an unknown
  tag gets `AckError.Unsupported`. A malformed op with a readable `cid` gets `AckError.Invalid`.
  Neither fails the rest of the batch, so one bad op can't block a device's outbox.
  A `NotFound` ack turns the op into a local failed row instead of a retry: the device keeps the
  drafted text, stops sending that `cid`, and offers the user a discard action (ADR 0013).
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
exist. Visibility is the same rule `/sync` applies: a non-member of an invite-only group, a
non-participant in a DM, or a blocked author yields nothing.

Only a tap pays for a gap. A client catching up on a device loops `/sync` while `more` is true,
then fetches `/history` once per "load older" tap, starting at the oldest message it holds (or
at a gap's `before`). The history page joins the same cache; it does not move the sync cursor.

Measured catch-up (`apps/server/test/history.test.ts`): 840 posts missed over three weeks in one
group arrive as 101 events — the newest 100 plus one gap — at about 2,000 B uncompressed and a
few hundred bytes compressed on the wire, inside the 20 KB 100-post budget.

## Invite links

Invite links are ordinary URLs (`/join/<token>`), so a QR code is just the same URL encoded.
They are managed over JSON beside `/sync`, not as events: a token in the log would be visible
to every member (ADR 0016).

- `GET /api/groups/{id}/invite` returns `{ group, token, link, qr }` for an invite-only group's
  admin or owner. `qr` is the link itself.
- `POST /api/groups/{id}/invite/rotate` returns the same shape with a new token and invalidates
  the old link immediately. Existing members stay. `POST /api/groups/{id}/invite` is accepted
  as a shorthand for the same rotation.
- Open groups have no invite link: `GET`/`POST` on their invite route returns `404`.
- `GET /api/invites/{token}` returns group basics for a link holder, so the join screen can say
  what they are joining.
- `POST /api/invites/{token}/join` joins in one call. The PWA sends a `membership` op with
  `invite` instead, so the join and its state snapshot arrive in one `/sync` response.

All four require a bearer session. A group admin or owner may read or rotate; a plain member
gets `403`; a non-member gets `404` for a group they cannot see, and an unknown or rotated
token gets `404`.

## Several servers, one client

The app is served by one server but may hold accounts on several, like networks in an IRC
client (ADR 0001, ADR 0020). Nothing is forwarded between servers; each `/sync` goes straight
to its own origin with its own bearer token and cursor.

- A server is identified by its origin. Group, DM and event ids stay small integers local to
  one server; the client namespaces its cache by origin so two logs cannot collide.
- A server is added by a link: a bare origin, a server invite (`/signup/<token>`) or a group
  invite (`/join/<token>`). A QR code encodes the same link and is decoded on the device.
- Requests to an added server are cross-origin. Every server answers `OPTIONS` preflights and
  sends `Access-Control-Allow-Origin: *` on foreign-origin responses. Authentication is the
  bearer token, never a cookie: the server strips any session cookie it would set, so a
  foreign origin has no ambient authority to borrow.
- `/sync`, `/history`, the auth routes, the media routes and the JSON invite and admin routes
  are all usable this way. The wire format is unchanged; a server cannot tell a multi-server
  client from a single-server one.
- The durable outbox, its 2,000-event cache and its 50 MB media LRU are per account on one
  server (ADR 0013), so the online event drains every signed-in server's own queue.

## Server administration

Registration is server policy, not a group rule (ADR 0012, ADR 0017). It is read on every
signup, so a change takes effect immediately.

- `open` admits anyone, `invite` requires the current server invite token, and `closed` admits
  nobody. The independent `frozen` switch rejects every signup regardless of mode.
- `GET /api/server/registration` is public and returns `{ mode, frozen }`, so a sign-in screen
  can explain why signup is unavailable.
- `GET /api/server/settings` returns `{ mode, frozen, admin, invite }` to a signed-in account.
  `invite` is `{ token, link, qr }` for a server admin and `null` for everyone else.
- `POST /api/server/settings` (server admin) changes `mode` and/or `frozen`.
- `POST /api/server/invite/rotate` (server admin) replaces the live server invite and returns
  the same settings shape. The old link stops working before the response. Selecting `invite`
  mode issues a link when the server has none yet.
- `GET /api/server/users` (server admin) returns every account with the wire id a server ban
  needs: `{ users: [ { user, username, banned, admin } ] }`. An account that has never synced
  gets a wire id at this point, so it can still be banned.

The BetterAuth admin plugin's own `/api/auth/admin/*` routes are not exposed; registration and
bans have exactly one path, described here.

A server invite is an ordinary URL, `/signup/<token>`. The app shell answers that path, reads
the token from it, and sends it as the optional `invite` field in the signup JSON body. The
token is a capability and never enters the event log. It is consumed by the recovery service
before the body is forwarded to BetterAuth.

A server ban (`ban` op with `scope = 0`) revokes every session for the account in the same
transaction, removes every group membership (handing owned groups on per ADR 0010), and records
`scope_left` with `purge = true` for every group and DM scope the account was in. DM scope rows
stay, so the other participant keeps their side of the history. A banned account cannot sign
in, redeem a recovery code, or sync until an admin lifts the ban; lifting it clears the pending
DM purges (a DM has no join) but not the revoked sessions or the old group roles.

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
- A `delete_author` op is acknowledged by the seq of its marker event. The server expands it
  into one `delete` event per live post or reply that account wrote in the group. Old clients
  skip the marker and apply the deletes, which they already understand.

| Tag | Name | Fields after the header | Op | Notes |
|---|---|---|---|---|
| 1 | post | `text, ? media` | yes | group scopes only |
| 2 | reply | `parent: uint, text, ? media` | yes | one level: `parent` must be a post |
| 3 | dm | `peer: uint, text, ? media` | yes | op with `scope = 0` opens a DM with `peer` |
| 4 | reaction | `target: uint, emoji: uint 0..7, on: bool` | yes | fixed 8-emoji palette, toggled |
| 5 | delete | `target: uint` | yes | the author, a group admin, or the owner |
| 6 | profile | `username, displayName, bio` | yes | `scope = 0`. Avatars are identicons from the user id |
| 7 | *reserved* | | | never reuse |
| 8 | group_meta | `name, about, open: bool` | yes | op with `scope = 0` creates a group |
| 9 | membership | `user: uint, role: uint 0..3, ? invite: text` | yes | 0 none (left), 1 member, 2 group admin (`Role.Admin`), 3 owner (`Role.Owner`). `invite` exists only in an **op**, never in an event: it is the current token for an invite-only group's link |
| 10 | ban | `user: uint, on: bool` | yes | `scope = 0`: server ban (server admin), which revokes sessions and purges every group and DM scope; else group ban (group admin or owner) |
| 11 | scope_left | `purge: bool` | no | the viewer lost access to `scope`. `purge`: delete cached posts |
| 12 | gap | `after: uint, before: uint, count: uint` | no | `count` events in `(after, before)` not sent |
| 13 | dm_scope | `peer: uint` | no | server-generated when a DM is first opened; `scope` is the new DM id |
| 14 | block | `user: uint, on: bool` | yes | `scope = 0` toggles the sender's personal, silent block of `user`. The event is delivered only to the blocker; the blocked account is never told (ADR 0012) |
| 15 | delete_author | `user: uint` | yes | group admin or owner removes every post and reply `user` wrote in `scope`. The server appends this marker, then one `delete` event per affected post or reply; old clients skip the marker and apply the deletes (ADR 0004) |

```
Media = [id: uint, w: uint, h: uint, thumbhash: bytes .size (0..32)]
```

`thumbhash` is a [ThumbHash](https://evanw.github.io/thumbhash/) placeholder (about 21–25 bytes),
shown blurred until the user taps to load `GET /m/{id}`.

`text` may be empty when `media` is present: a photo with no caption is a complete post, reply
or DM. A post with neither text nor media is `Invalid`. A ThumbHash longer than 25 bytes is
also `Invalid`: the wire decoder accepts up to 32 for forward compatibility, but the product's
whole media field must stay inside its 40 B budget.

### Media upload and fetch

Bytes travel beside `/sync`, not in it. Both routes need the bearer session; a device that has
not finished signup gets `403`.

```
POST /m
  Content-Type: multipart/form-data
  fields: preview (WebP, longest edge <= 320 px), full (WebP, longest edge <= 1280 px)
  each variant <= 400 KB
  201 { id: uint, w: uint, h: uint, bytes: uint }   ; w/h are the full variant's measured size
```

The server does not re-encode. It checks the `RIFF....WEBP` container, reads the dimensions
from the `VP8 `, `VP8L` or `VP8X` header, enforces the caps and the server's total media quota,
and stores the bytes as-is. A refusal is JSON with a stable `code` and a human `error`:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `missing_variant` | one of the two files is absent or empty |
| 400 | `bad_body` | the multipart body could not be read |
| 401 / 403 | `unauthorized` / `signup_incomplete` | no valid session, or signup not finished |
| 404 | `not_found` | fetch only: unknown id, expired upload, deleted post, or no access |
| 405 | `method` | upload needs POST, fetch needs GET |
| 413 | `too_large` | a variant is over 400 KB, or the declared body is over the upload limit |
| 415 | `not_webp` / `bad_body` | wrong bytes, or not a multipart body |
| 422 | `dimensions` | a variant is longer than its edge, the full one is smaller than the preview, or their aspect ratios differ by more than 2% |
| 507 | `quota` | the server's configured media byte budget is full |

```
GET /m/{id}?w=<width>
  200 image/webp, Cache-Control: private, max-age=31536000, immutable
  404 when the id is unknown, the viewer may not see its event, or the post was deleted
```

`?w=` is a hint, not a resize request: it snaps to the nearer of the two stored variants. An
exact tie, a missing width, or an unusable one answers with the 320 px preview. Until an upload
is attached to an event, only its uploader can fetch it; afterwards the event's own visibility
rules apply. Deleting a post or reply removes its stored image and returns the bytes to the
quota. An upload that is never posted expires after one hour and is no longer fetchable or
attachable.

## Scopes and visibility

A scope is either a **group** or a **DM** between two users. There is no friends feed.

- The first `dm` op for a pair (`scope = 0`, `peer` set) creates the DM scope. Its id is the
  `seq` of the server-generated `dm_scope` event, whose `peer` names the other participant.
  There is exactly one DM scope per unordered pair; later messages use that scope id. The
  first sender's `dm` event and the `dm_scope` event are appended in the same transaction.
- A fresh device gets every `dm_scope` its account participates in, like group metadata, and
  zero DM messages (ADR 0009).
- A user sees an event if they currently have access to its scope: they are a member of the
  group (or the group is open and they joined), or they are one of the two DM participants.
  Scope-0 events are visible to everyone on the server.
- An **open** group's `group_meta` event is visible to every account, member or not, so the
  client can list it before joining. Its memberships and posts stay members-only. A user joins
  with a `membership` op naming themselves; the join is a new scope, so it gets state and no
  back history (ADR 0009).
- An **invite-only** group's events are invisible to non-members, including its `group_meta`,
  so it never appears in the open list. Its single link is a URL whose token names the group.
  A client joins with the same `membership` op plus `invite = <token>`. The server compares the
  token with the group's current one; a rotated token gets `Forbidden`. The token is never
  appended to the membership event (ADR 0016).
- The server works out the viewer's scope set once per request and filters the log by it.
- When a user is kicked or banned from a scope, they get `scope_left` with `purge = true`, and
  the client deletes its cached posts from that scope.

## Abuse controls (ADR 0012)

Open servers stay usable without new round trips: every control is decided inside the op that
would have broken it, and the outbox keeps moving.

- **Budgets.** Posts and DMs share one per-account budget of 30 per minute. Opening a brand-new
  DM thread is one of 10 per account per day; replies and later messages in an existing thread are
  free of that budget. Signups are 3 per IP per hour.
- **Ack, not HTTP error.** An over-budget op gets `AckError.RateLimited = 5` for that `cid`; the
  rest of the batch still applies. A rate-limited signup is the one JSON route and answers `429`
  with `Retry-After`.
- **New-account DM cooldown.** An account younger than 24h cannot open a DM thread: `Forbidden`.
  It can still reply in a thread an older account opened, because the scope id already exists.
- **Silent personal block.** A `block` op with `scope = 0` toggles the sender's own block of
  `user`. The server stores it and returns a normal ack. A blocked account's posts, replies,
  reactions, DM scopes and DMs stop appearing on the blocker's devices; a device that already
  cached that author's content drops it when the block event arrives. A DM the blocked account
  sends is still stored and acked as delivered, but the blocker never receives it. The block event
  itself is delivered only to the blocker, so the blocked account cannot tell it happened.
  Unblocking (`on = false`) is just as silent.
