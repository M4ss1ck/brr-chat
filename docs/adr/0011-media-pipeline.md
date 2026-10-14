# 0011. Client-side WebP media pipeline and server quota

Status: accepted (2026-10-14)

## Context
On slow, metered connections (2G/3G in Cuba), auto-downloading full-resolution camera uploads
wastes users' data budgets, and server-side image transcoding adds CPU, memory, and
native-library bloat to the single-binary server (ADR 0002).

## Decision
- Client-side resize and encoding: before upload, the client decodes the source image, strips
  metadata, resizes, and encodes two WebP variants at `320` px and `1280` px longest edge, plus a
  ThumbHash placeholder (~21-25 bytes). Each uploaded variant is capped at `400 KB`.
- Inline placeholder only: posts, replies, and DMs carry only `Media = [id, w, h, thumbhash]` on
  `/sync` and `/history` (at most 40 B on the wire, enforced by
  `packages/protocol/test/budget.test.ts`). Full images are never pushed inline; viewers see the
  blurred ThumbHash and fetch `GET /m/{id}?w=<width>` only when they tap to load (`?w=` snaps to
  the nearest stored variant, `320` or `1280`).
- Server validation without re-encoding: the server checks WebP magic bytes (`RIFF....WEBP`),
  parses the WebP header to verify pixel dimensions (`<= 320` and `<= 1280`) and the `400 KB` byte
  cap, and stores the bytes as-is without server-side re-encoding. Invalid uploads are rejected.
- Per-server storage quota: the server enforces a configurable total media byte quota across
  stored files (evicting oldest blobs or rejecting uploads when full according to server policy)
  so a single binary deployment cannot exhaust disk.

## Consequences
- Zero image-processing native dependencies (`libvips`/`sharp`) in the compiled server binary, and
  near-zero server CPU per upload.
- Scrolling a media-heavy group costs ~39 B per image until the user explicitly taps to load
  `320` px or `1280` px.
- The server relies on header/dimension inspection rather than re-encoding, so browsers handle
  decoding of untrusted WebP payloads inside their existing image sandbox.
