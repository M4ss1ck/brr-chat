# 0013. Offline outbox, bounded local cache, and NotFound recovery

Status: accepted (2026-10-14)

## Context
Devices on unstable, metered connections frequently compose messages offline and run on
low-storage Android phones where unbounded local caches would fill disk.

## Decision
- Durable outbox with 30-day server deduplication: queued ops (`cid`, tag, scope, fields) persist
  in local storage across app restarts and drain in order on `/sync` when connectivity returns.
  Each op carries an 8-byte random `cid`; the server deduplicates `(user, cid)` for `30 days` and
  returns the original ack on retry, so network drops never duplicate posts.
- Bounded event cache (~2,000 events/scope): the client keeps at most `~2,000` events per scope in
  local storage, evicting older events outside the latest window. Eviction never removes unacked
  outbox items or the latest page of each scope, so opening any joined group or DM offline always
  renders recent messages immediately.
- Bounded media LRU (50 MB): downloaded full/preview WebP images (ADR 0011) are stored in a
  client-side LRU cache capped at `50 MB` across the app. Inline ThumbHash placeholders stay on the
  event records (~25 B each) so evicted images fall back to their blurred placeholder until tapped
  again.
- `NotFound` ack handling: if a queued op (such as a reply or reaction) targets a post that was
  deleted before the device came back online, the server returns `AckError.NotFound` (`4`). The
  client marks that outbox item as failed and gives the user a one-tap "discard" action (preserving
  the drafted text to copy if desired) instead of retrying forever.

## Consequences
- Local storage stays bounded (~2,000 events/scope + 50 MB media) even in high-traffic groups.
- Offline composition is reliable across restarts and flaky links, and permanently invalid replies
  (`NotFound`) never block newer outbox ops behind them.
