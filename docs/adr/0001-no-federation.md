# 0001. No federation

Status: accepted (2026-10-09)

## Context
Federation (ActivityPub, Matrix) means server-to-server traffic, identity portability and
moderation across trust boundaries. That is most of the complexity in those systems, and none of
it makes a phone on a metered link faster.

## Decision
Each server is an isolated community. A user has a separate account on each server. Servers
never talk to each other. The client manages several servers, like an IRC client with several
networks: one account, one cursor and one `/sync` per server. You join by invite link or QR code.

## Consequences
- The protocol has no global identifiers. Ids are small integers local to one server, which
  keeps them 1–5 bytes on the wire.
- Moving to another server means a new account. Accepted for the MVP.
