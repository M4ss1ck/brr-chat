# 0008. Groups and DMs only; no friends

Status: accepted (2026-10-09). Supersedes the handoff's MVP item "friends (mutual follow)".

## Decision
There are two kinds of scope: groups and 1:1 DMs. There is no friend graph and no friends
timeline. Any account on a server can DM any other account on that server. Event tag 7
(`friend_state`) is reserved and never reused.

## Consequences
- Fewer event types and simpler visibility: a user's scopes are their groups plus their DMs.
- With DMs open to everyone, DM spam on open-registration servers is a real risk. Per-user
  blocking and rate limits are the job of open question 5 (spam and abuse controls), and are
  enforced on the server without protocol changes.
