# 0019. Gaps cover messages, not control events

Status: accepted (2026-10-21). Amends ADR 0009.

## Context
ADR 0009 decides that a catch-up past 100 missed events in one scope sends a `gap` marker
instead of the excess, and that `/history` fills it on request. It says "events" without
saying which ones. Taken literally, a gap could hide membership changes, bans, deletes or group
metadata.

Those events are different from a flood of posts. They are few in normal use, and a client that
skips one holds stale state: a removed member still listed, a deleted post still visible, a
group it no longer belongs to still shown. Only messages and reactions are content a user reads
backwards, and only they can grow without bound while a device is offline.

## Decision
- A gap covers **post, reply, DM and reaction** events only: `GAP_COVERED_TAGS` in
  `packages/protocol`, shared by server and client.
- Every other event is delivered however old it is: profile, group metadata, membership, ban,
  delete, bulk-delete marker, `scope_left`, `dm_scope` and the viewer's own block events.
- For a scope that passed the threshold, the server sends its newest 100 gap-covered events and
  one `gap` marker. `after` is the cursor the catch-up started from, `before` is the seq of the
  first gap-covered event still sent, and `count` is the number of covered events in
  `(after, before)` that were not sent. `before` is therefore the argument for the first
  `/history` call.
- The client keeps gap markers in IndexedDB per scope. "Load older" starts at the lowest stored
  `before`, not at the oldest cached post, so a hole between old and new cache fills from its
  top edge. A page shrinks the hole to the oldest seq it returned, or closes it when it reaches
  `after` or the server reports no older events.
- No wire change: tag 12 and the `/history` envelope already carry everything this needs. No
  version bump.

## Consequences
- Catching up stays bounded by content, while group state stays correct without a detour
  through history.
- A scope with hundreds of membership or moderation events still sends all of them. That is
  acceptable: those events are small, and a correct member list is worth more than the bytes.
- A gap is a durable local fact, so reopening the app still offers to fill the hole it knows
  about.
