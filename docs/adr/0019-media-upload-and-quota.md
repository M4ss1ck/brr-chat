# 0019. Media upload transport, tap-only fetch and the server quota

Status: accepted (2026-10-20)

## Context
ADR 0011 fixes what a media attachment is: two client-encoded WebP variants plus a ThumbHash,
with the event carrying only `Media = [id, w, h, thumbhash]`. It does not say how bytes reach
the server, who may read them, or how much disk one server may spend.

The constraints are the same as everywhere else: one binary and one SQLite file, no native
image libraries, a metered client connection, and no authorization header on an `<img>` tag.

## Decision
- **One upload request.** `POST /m` takes `multipart/form-data` with `preview` and `full`.
  Multipart is standard in every browser (`FormData`) and Bun parses it without a dependency.
  Two requests would cost a second round trip on the network our users actually have.
- **Validation without decoding.** The server checks `RIFF....WEBP`, reads the dimensions from
  the `VP8 `, `VP8L` or `VP8X` header, enforces 320 px / 1280 px longest edges and 400 KB per
  variant, and stores the bytes as-is. It also rejects a full variant smaller than the preview
  and an aspect ratio that differs by more than 2%, so the placeholder cannot make the timeline
  jump. A failure is a JSON body with a stable `code` (`too_large`, `not_webp`, `dimensions`,
  `quota`, `missing_variant`, `bad_body`, `method`, `not_found`) beside the human `error`, so
  the PWA can say what to do instead of showing a status number. The 413 body guard reads
  `Content-Length`; Bun's own 8 MB request backstop covers a chunked body.
- **Storage in SQLite.** Both variants live in a `media` row in the same database file as the
  event log. The row records the uploader's wire id, measured dimensions, total bytes and the
  event that shows it. There is still nothing to deploy beside the binary and the DB file.
- **Quota.** A single configured byte budget (`MEDIA_QUOTA_BYTES`, `--media-quota`, default
  256 MB) caps all stored variants. Check and insert are one transaction. Deleting a post or
  reply frees its bytes; an upload never attached to an event expires after one hour.
- **Tap-only fetch with credentials.** `GET /m/{id}?w=` requires the same bearer session as
  `/sync`; the PWA fetches with `Authorization` and turns the blob into an object URL. A
  public, unguessable URL would either leak DM images or need a signed URL in every event,
  which spends the bytes this product exists to save. An unattached upload is visible only to
  its uploader; once attached, the event's own visibility rules decide.
- **Nearest variant.** `?w=` is a display hint snapped to 320 or 1280, with the tie and any
  missing/invalid width going to 320. The PWA asks for the width the image actually occupies,
  so the feed pays for the preview; the full variant is there for a larger view.
- **No dead-end uploads.** The client steps WebP quality down (0.82 → 0.35) until each variant
  fits the 400 KB cap, and refuses locally only when even that is too large.

## Consequences
- A media-heavy timeline costs one placeholder per image until the user chooses to load it.
- The server never runs an image codec, but it also never verifies pixels. Browsers decode
  untrusted WebP inside their existing image sandbox, which is where that risk already lives.
- A deleted post's image stops being fetchable and stops counting against the quota. A cached
  copy on a device that already loaded it stays in the browser's private cache.
- Operators of a large server raise the quota deliberately; there is no silent growth.
