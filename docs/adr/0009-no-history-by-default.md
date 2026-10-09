# 0009. No history by default; gaps instead of floods

Status: accepted (2026-10-09)

## Decision
- A fresh device, or a newly joined group or DM, gets current state and a cursor at the head of
  the log. It gets **zero posts**. Older posts load only when the user asks, through
  `POST /history`.
- Catching up on an existing device is automatic (events since the cursor). Responses are paged
  at about 500 events / 64 KB with `more`. Past 100 missed events in one scope, the server sends
  a `gap` event instead, and the gap is filled only on request.
- Losing access through a kick or ban sends `scope_left` with `purge = true`, and the client
  deletes its cached posts.

## Consequences
What a user downloads depends on what they choose to read, not on how old the server is or how
long they've been away.
