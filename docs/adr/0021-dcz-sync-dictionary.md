# 0021. dcz shared dictionary for `/sync`

Status: accepted (2026-10-20)

## Context
`/sync` is the request that matters most: it is every catch-up, every reconnect, every device
that comes back after a day offline. Brotli compresses a response against itself, so every
response pays again for the phrases this community repeats: chat vocabulary, event framing,
the group and profile snapshot a fresh device receives.

RFC 9842 (Compression Dictionary Transport) lets a server compress a response against a
dictionary the browser fetched earlier, with `dcz` as the zstd flavor. Chrome ships it; other
engines ignore `dcz` in `Accept-Encoding` and keep brotli. The protocol does not change: this
is HTTP transport, below CBOR, so there is no version bump and no fixture.

The dictionary is a one-time download on a metered connection, so it has to earn its bytes
back. It also must never contain user content: it is public and identical for every client.

## Decision
- **One static dictionary, served at `/sync-dict/brr-sync-v1`** (`apps/server/src/dictionary.ts`).
  It is a synthetic sample of a typical sync: a four-event group/profile snapshot and 100 posts
  from the same deterministic Spanish/English corpus the protocol's 100-post byte fixture uses,
  at indices the fixture does not use. No user data is read to build it.
- **It is advertised, not pushed.** The document response carries
  `Link: </sync-dict/brr-sync-v1>; rel="compression-dictionary"` (RFC 9842 §3); the browser
  fetches it at low priority when it chooses. The dictionary response sets
  `Use-As-Dictionary: match="/sync", id="brr-sync-v1"` and is fresh for a year (`max-age`,
  `immutable`), which RFC 9842 §2.2.1 requires before a dictionary can match. The id is in the
  path: changing the bytes means a new id and URL, never a stale immutable dictionary.
- **Negotiate on the hash, not on trust.** The server uses the dictionary only when the request
  has `dcz` in `Accept-Encoding`, `Available-Dictionary` equal to the SHA-256 of these exact
  bytes, and, if sent, the matching `Dictionary-ID`. A missing id is tolerated (the hash is the
  authority); a wrong one, a wrong hash or a stale dictionary falls back to brotli.
- **Size guard.** `respondCbor` compresses with both and answers `dcz` only when
  `dcz + "Vary: Accept-Encoding, Available-Dictionary"` is smaller than brotli. A 40-byte
  header on a two-event sync would otherwise make the response bigger.
- **The browser decompresses.** `fetch` decodes `dcz` transparently, so no client code path
  changes (the sync request no longer sets `Accept-Encoding: br`, which browsers ignore as a
  forbidden header anyway, and they add `dcz` and `Available-Dictionary` themselves). The
  server still sends `Content-Length` of the bytes on the wire, which is what the data meter
  counts (ADR 0018).

## Consequences
- **Measured on the 100-post fixture** (`apps/server/test/dictionary.test.ts`, CI gate):
  13,859 B raw, 3,129 B brotli, 2,658 B dcz body. With the response headers that differ
  (`Content-Encoding` and `Vary`) it is 3,151 B vs 2,726 B, a **13.5% saving on the wire**
  (15.1% on body bytes alone). The dictionary is 14,478 B, 3,299 B brotli-compressed; at one
  response like the fixture it pays back after 8 syncs. On smaller or less repetitive
  responses the guard keeps brotli, and the dictionary's cost is not recovered until enough
  traffic matches it.
- The 13.5% (15.1% of body bytes) is measured against the project's synthetic chat corpus, which the dictionary is
  built from. It proves the transport works end to end on the workload this repo treats as
  representative; it is not a promise of those numbers on arbitrary text. Real chat with a different
  vocabulary saves less.
- The dictionary fetch is initiated by the browser, so `meteredFetch` cannot see it. The meter
  under-counts by at most one compressed dictionary (3.3 KB) per browser cache lifetime, the
  same class of invisible traffic as preflights (ADR 0018, ADR 0020). The alternative, a
  page-driven fetch that would sometimes be a cache hit, over-counts the other way.
- Cross-origin use is allowed by RFC 9842 §9.3.3 because this API sends
  `Access-Control-Allow-Origin: *` with bearer auth and no ambient credentials. The preflight
  now also allows `Available-Dictionary` and `Dictionary-ID`; without that, a browser-attached
  dictionary would fail the whole cross-origin sync, not just the compression. Cross-origin
  clients of an added server only get `dcz` when that server's own shell advertised the
  dictionary; otherwise they keep brotli, which is the safe fallback.
- If node:zlib ever drops zstd dictionary support, `dczCompress` is the only place to change;
  clients fall back to brotli automatically, with no protocol consequence.
