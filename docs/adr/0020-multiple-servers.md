# 0020. Several servers on one device, like networks in IRC

Status: accepted (2026-10-20)

## Context
ADR 0001 fixed the product model: each server is an isolated community, a person has a
separate account on each one, and the client holds several servers "like an IRC client with
several networks: one account, one cursor and one `/sync` per server". Issue #18 makes the
client do that.

The shell was single-server in every layer that mattered. One `session` key, one cursor per
username, one cached group list per username, one protocol range, one meter row, and every
request went to `location.origin`. Group and DM ids are small integers local to one server,
so two servers sharing a key space would mix unrelated logs as soon as the second arrived.

Two browser constraints shape the design. IndexedDB belongs to an origin, so the client that
holds the list is the one served by whichever server the user opened; the other servers are
reached cross-origin. And the service worker only caches the shell it was served, not the
API of another origin.

## Decision
- **A server is its origin.** `https://chat.example` is the id, the fetch base and the cache
  namespace. Nothing else can identify a server: it has no global id (ADR 0001) and its name
  is only a label. The label defaults to the host.
- **One row per server.** IndexedDB `kv` keeps `servers` (an array of
  `{ id, name, addedAt, session, invite }`) and `active` (the server on screen). Every
  per-account key is prefixed with the server: `cursor:<origin> <username>`,
  `posts:<origin> <username>:<scope>`, and so on. Neither an origin nor a username can contain
  a space, so the namespace is unambiguous without escaping.
- **Seeding and migration.** On boot the app calls `migrateLegacy(origin)` once: the old
  `session`, `cursor:<username>`, `outbox:<username>`, caches, `range` and `meter` keys move
  into the new namespace for the serving origin, in place, then the old keys are deleted. A
  fresh device seeds one signed-out entry for the origin that served it, so the single-server
  path never sees an empty list.
- **Adding a server is a link.** Accepted shapes are a bare origin, `/signup/<token>` (the
  server invite from ADR 0017) and `/join/<token>` (a group invite from ADR 0016), with or
  without a scheme (https, or http on loopback). One parser handles a pasted link and a
  `/signup` or `/join` deep link, so an invalid token is rejected both ways. The token is
  stored beside the server and never appears in a URL this app navigates to; the address bar
  is cleaned immediately. A QR code encodes exactly that link, so it is the same code path.
  The client decodes the code on the device, from the camera or a picked image, with jsQR;
  nothing is uploaded. A link tapped in the phone's browser lands on the server it names and
  adds itself to that origin's list; adding another server to the app served by A is done by
  pasting or scanning the link, because IndexedDB is per origin.
- **Switching is local.** The list is a `<select>` outside both auth panels, so a signed-out
  server can be chosen and signed in to. Switching resets every view selection and increases
  a render epoch, so a render that started on the old server paints nothing.
- **One `/sync` per server.** Boot, the Sync button and the browser's `online` event sync
  every signed-in server, each with its own bearer token, cursor and outbox, and the status
  line reports each one. Sending an op syncs only the server on screen. Sends for one account
  are serialized (ADR 0013): a request already in flight finishes, then a second request
  carries the op that was queued meanwhile, so "in sync" is never shown over a waiting
  message. Cursors and outboxes are written per account, so one server's catch-up cannot
  move or drain another's.
- **The meter attributes bytes per server.** Each request is charged to the origin it goes to
  (the URL is the only place the server is visible at that layer). The month row is
  `meter:<origin>`, the tab counter is `brr-meter-session:<origin>`, and the headline totals
  are the sums. The per-server lines appear once the device holds more than one server.
- **Cross-origin API access.** A client served by A calls B directly, so the server answers
  `OPTIONS` preflights and adds `Access-Control-Allow-Origin: *` to foreign-origin responses.
  Authentication is the bare bearer token (ADR 0007), so `*` grants no ambient authority: a
  request without the token is still a 401. Two supporting decisions keep that true:
  `trustedOrigins` is `["*"]` (BetterAuth's origin check cannot know A's origin in advance),
  and the server strips the session cookie BetterAuth would set, so no browser carries an
  identity cookie to this API at all. The one exception is the identity-less WebAuthn
  challenge cookie on a same-origin passkey ceremony (ADR 0021). Same-origin responses get no
  CORS headers, and only the two headers a real response needs are added cross-origin; the
  rest belong to the preflight.
- **Removing a server** revokes its session first (one server's sign-out never touches
  another's token), then deletes every key in that server's namespace: account, cursor,
  outbox, event cache, range, meter row and the durable image bytes indexed to that account.
  If the server cannot be reached, removal stops and asks again: only an explicit second
  confirmation deletes the local copy, because the token stays valid there until it expires.

## Consequences
- No protocol change: a server still sees one client with one token and one cursor. Nothing
  is forwarded between servers, so ADR 0001 stands. No version bump.
- The previous single-user behavior of "sign in as someone else on this device" becomes
  "sign in as someone else on this server": the list has one account slot per origin. Cached
  rows for the old username stay under their own key, so signing back in restores them.
- A cross-origin `/sync` costs one preflight per origin per `Access-Control-Max-Age` (a day).
  That request is invisible to page code, so the meter cannot count it (ADR 0018 already calls
  the meter an estimate). Same-origin traffic pays nothing new.
- jsQR is its own 27 KB bundle (`/qr-scan.js`), loaded only when the Add-server panel opens,
  so the first load is 36 KB and every file together is 63 KB of the 150 KB budget. The
  service worker caches the scanner after its first use. It was chosen over a hand-written
  decoder because Reed-Solomon repair and perspective correction are exactly the part where
  a custom implementation fails on a real camera.
- The service worker does not cache a second server's API. That is correct: API responses are
  never cached (ADR 0018's meter counts them), and stale sync data would be worse than a
  network read.
- Media ids are local to one server, like every other id. The in-memory image URLs are keyed
  by origin and id, and the durable 50 MB LRU (ADR 0013) is owned by one account on one server,
  so neither cache can show another server's picture. An upload goes to the server whose
  composer chose the photo, even if the user switches servers while it uploads.
- Two tabs still each keep their own month totals in memory; per-server rows do not change
  that. Cross-tab coordination remains out of scope.
