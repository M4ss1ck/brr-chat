# 0015. A dm_scope event names each DM conversation

Status: accepted (2026-10-20). Implements DMs (issue #9) under ADR 0008.

## Context
A group scope has a `group_meta` event whose `seq` is the group id, so a fresh device can list
every group it belongs to from current state (ADR 0009). DMs need the same thing: a stable scope
id, a way to name the other participant, and a conversation list that survives a reinstall
without downloading message history. The `dm` event alone cannot do this, because a device with
no cached events has no way to learn that a conversation exists, and reusing the first message
as state would break "no history by default".

## Decision
- The first `dm` op for an unordered pair (`scope = 0`, `peer` set) creates one DM scope in the
  same transaction as its first message. A unique index on `(user_a, user_b)` makes concurrent
  first messages resolve to a single scope.
- The scope id is the `seq` of a server-generated `dm_scope` event (tag 13, field `peer: uint`).
  Its `scope` is its own `seq`, so the event is self-describing. The opener is the event author
  and `peer` is the other participant; both can derive the pair.
- `dm_scope` is visible only to the pair and is part of the fresh-device state snapshot. DM
  messages (`tag 3`) keep using the scope id and are never part of current state.
- Tag 13 is a new tag, so older peers skip it (ADR 0004 rule 4). No version bump: no existing
  field changed meaning, and v1 fixtures remain valid. A new frozen fixture covers the shape.
- `dm_scope` is server-generated only; it is not in the op set.

## Consequences
- A DM list renders on a fresh device from one small event per conversation, with zero message
  history downloaded.
- Exactly one conversation per pair, even when both people send their first message at once.
- The client caches `dm_scope` rows plus messages keyed by scope, so the list and thread open
  offline with no network call.
