# 0018. Data meter: count the wire, persist the month

Status: accepted (2026-10-20)

## Context
Users pay per MB. Until now the app respected byte budgets but never told the person holding
the phone what a sync, a sign-in, or a later history or media fetch actually cost. A meter is
only useful if it is honest: counting decompressed payloads would understate what the radio
downloaded, and resetting on every reload would hide the monthly bill.

The browser does not expose raw socket bytes. `fetch` gives the request and response bodies,
the headers the app can see, and `Content-Length` when the server sends one. TLS, HTTP/2 frame
headers, and browser-added headers (User-Agent, Sec-Fetch-*) are not visible to page code.

## Decision
- **One door.** Every app API request goes through `meteredFetch` in `apps/web/src/meter.ts`.
  Auth, sync, invite and admin calls use it today; history and media will use the same door.
  Shell assets served by the service worker are not app traffic and are not counted.
- **Count both directions.** A request costs its request line, every header the app sets, the
  implicit `Host` and `Content-Length` that fetch adds, and its body. A response costs its
  status line, the headers it exposes, and its body. The bodies are exact. Header bytes are the
  UTF-8 length of the header lines we can see. The count is an estimate in both directions:
  HTTP/2 HPACK usually makes it too high, while browser-injected headers (User-Agent,
  Sec-Fetch-*) make it too low. A meter is not a packet capture; it says "about this much",
  and never silently counts decompressed bytes as downloaded ones.
- **Compressed means downloaded.** `/sync` now returns `Content-Length` for its brotli body, and
  the meter uses `Content-Length` whenever it is present. If a chunked response has none, the
  meter counts the body the app receives; for an identity body that is the wire size, and for
  a compressed one it is an over-count rather than an under-count.
- **Both scopes persist across reloads.** "This session" is the tab session: its bytes live in
  `sessionStorage` under `brr-meter-session`, so a reload resumes them and closing the tab ends
  them. The monthly total lives in the existing IndexedDB `kv` store under `meter`, one row
  `{ month, bytes }`, shared by every tab. The month key is the device's local calendar month
  (`YYYY-MM`), not UTC: the boundary the user experiences is their own midnight. A stored month
  that no longer matches is discarded and replaced with the new month at zero, on load and
  again whenever a request or repaint crosses the boundary.
- **Always visible, outside auth.** The meter is a sticky bar at the top of the document, so it
  shows before sign-in and while scrolling. It is part of the shell, not a signed-in panel.
- **Meter failures are invisible.** If IndexedDB is unavailable or quota-limited, the session
  counter still works and the month is not persisted. A meter write never fails a request.

## Consequences
- The number is close to the bill, not a byte-for-byte packet capture. It deliberately includes
  headers, uses compressed sizes, and rounds only at display time; tests pin the arithmetic.
- A single tab is assumed for month accumulation. Two open tabs each keep their own in-memory
  month total and the last write wins, so the persisted month can lag by the other tab's usage.
  Cross-tab coordination is out of scope until multiple servers (#18) make it matter.
- Session bytes follow the tab, not the auth session: signing out and back in on the same tab
  keeps the count, while a new tab starts at zero. That matches the word "session" in the meter
  and makes a reload keep both numbers, which is what the issue's "survives reloads" asks for.
- No protocol change: `Content-Length` is HTTP metadata, not a CBOR field, so no version bump.
