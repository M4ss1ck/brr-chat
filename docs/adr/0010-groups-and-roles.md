# 0010. Groups, roles, invites, and ownership

Status: accepted (2026-10-14)

## Context
Groups (ADR 0008) need moderation, access control (open vs private), and continuity if the
creator leaves or is banned, without colliding with BetterAuth's server-wide `admin` role or
changing the v1 wire format (ADR 0004).

## Decision
- Group roles are `0` none (left), `1` member, `2` group admin (`Role.Admin`), and `3` owner
  (`Role.Owner` in `packages/protocol/src/events.ts`). Because v1 has not shipped to any deployed
  client or server yet (pre-launch prefactor) and wire values `0..3` are unchanged, no protocol
  version bump is needed and frozen v1 fixtures stay valid. We always write "group admin" vs
  "server admin" (BetterAuth's server-wide `admin` role).
- Account age gate: creating a group (`group_meta` op with `scope = 0`) requires an account at
  least 24h old; younger accounts receive a `Forbidden` ack.
- Visibility and invites: open groups (`open = true`) appear in the server's open group list and
  anyone can join. Invite-only groups (`open = false`) are hidden from the list and joinable only
  through a single invite link (or its QR code). Group admins and the owner can rotate that link,
  which immediately invalidates the old link while keeping existing members in the group.
- Moderation and single owner: group admins and the owner can delete any post in the group
  (`delete` op, tag 5) and ban or unban members (`ban` op, tag 10, which kicks the user, sends
  `scope_left` with `purge = true`, and blocks rejoin). A group admin moderates plain members;
  only the owner can ban another group admin, and nobody can group-ban the owner. Every group has
  at most one owner at any time. Only the owner can promote or demote group admins and transfer
  ownership (sending a `membership` op with `role = 3` promotes the target to owner and demotes
  the previous owner to group admin in the same transaction; the target's owner event is written
  first, then the old owner's admin event, so a commit that sees either sees both).
- Auto-succession: if a group's owner is banned server-wide (or leaves without transferring),
  ownership passes automatically to the longest-serving group admin; if the group has no group
  admins, ownership falls back to a server admin. A server ban removes every group membership
  the account holds (passing owned groups on), so lifting the ban restores no group powers
  without a new join.

## Consequences
- Every group always has an accountable owner without requiring server-admin intervention when an
  owner leaves or is banned.
- Single rotatable invite links keep invite state minimal (one secret token per group instead of a
  per-invite ACL table).
- Keeping wire values `0..3` preserves all frozen v1 fixtures without a protocol version bump.
