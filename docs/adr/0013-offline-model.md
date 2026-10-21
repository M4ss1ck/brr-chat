# 0013. Offline outbox, bounded local cache, and NotFound recovery

Status: accepted (2026-10-14)

## Context
Devices on unstable, metered connections frequently compose messages offline and run on
low-storage Android phones where unbounded local caches would fill disk.

## Decision
- Durable outbox with 30-day server deduplication: queued ops (`cid`, tag, scope, fields) persist
  in local storage across app restarts and drain in order on `/sync` when connectivity returns.
  Each op carries an 8-byte random `cid`; the server deduplicates `(user, cid)` for `30 days` and
  returns the original ack on retry, so network drops never duplicate posts. The client also drains
  on the browser's `online` event, and one sync at a time serves both that event and a tapped Sync.
- Bounded event cache (2,000 events/scope): the client keeps at most `2,000` content events (posts,
  replies and DMs) per scope in local storage, evicting the oldest rows above that limit. The
  newest `100` (one `/history` page) are never evicted, so opening any joined group or DM offline
  always renders a recent page immediately. A `/history` page just fetched is protected for that
  write, so the user sees what they paid for before the next sync trims it. Eviction never touches
  outbox rows themselves, and it never removes an event an unsent outbox op still points at (a
  reply's parent, a reaction's target); that exemption can shorten the window but never fail the
  queue.
- Bounded media LRU (50 MB): the offline layer keeps downloaded full/preview WebP bytes (ADR 0011)
  in a client-side IndexedDB LRU capped at `50 MB` across the app; the tap-to-load image view reads
  and writes through it. Recency is persisted, so the cap holds across restarts, and bytes are
  scoped by account plus server origin so another account or server cannot read them. Inline
  ThumbHash placeholders stay on the event records (~25 B each) so evicted images fall back to
  their blurred placeholder until tapped again.
- `NotFound` ack handling: if a queued op (such as a reply or reaction) targets a post that was
  deleted before the device came back online, the server returns `AckError.NotFound` (`4`). The
  client keeps that row as failed with its drafted text, never sends it again, and offers a one-tap
  "discard" action. Other nacks still drop the row, because resending would produce the same
  refusal.

## Consequences
- Local storage stays bounded (2,000 events/scope + 50 MB media) even in high-traffic groups.
- Offline composition is reliable across restarts and flaky links, and permanently invalid replies
  (`NotFound`) never block newer outbox ops behind them.
