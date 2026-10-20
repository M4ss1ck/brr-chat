# 0016. Invite links are server-side capabilities, not events

Status: accepted (2026-10-20)

## Context
ADR 0010 gives every invite-only group a single rotatable invite link. The link has to reach an
account that is not a member yet, but it must not reach the group's existing plain members: a
token in the event log would be delivered to every member by `/sync`, and any of them could
hand it out. The wire format is v1, where fields are only ever appended and optional (ADR 0004).

## Decision
- An invite-only group's current token lives in `chat_groups.invite_token`, one unique value per
  group. Open groups have no token; the open list is their way in. The link is
  `GET /join/<token>`, so a QR code encodes the same URL; there is no second credential.
- The `membership` op gains one appended optional field, `invite: text`. An invite-only group
  accepts a join only when the token matches its current one. The server never copies the field
  into the membership event, so the log and every member's device stay free of it.
- Admins and the owner read the current link with `GET /api/groups/{id}/invite` and rotate it
  with `POST /api/groups/{id}/invite/rotate`. Rotation is one `UPDATE`, so the old token is dead
  before the response and existing members are untouched.
- `GET /api/invites/{token}` resolves group basics for the join screen, and
  `POST /api/invites/{token}/join` exists for one-call clients. The PWA sends the membership op
  instead, so the join and its state snapshot arrive in the same `/sync` response.
- An invite-only group created before this slice gets its token lazily on the first admin request.

## Consequences
- The invite token is a capability: whoever holds the current URL can join, which is what a
  link is for. Rotating it is the only revocation needed.
- Plain members cannot read the link out of the log; non-members cannot see that the group
  exists. Only admins and the owner can hand it out.
- Older clients send and decode the same membership wire bytes; the new optional decodes as
  null when absent. The frozen v1 fixture bytes stay valid, so no protocol version bump is
  needed.
