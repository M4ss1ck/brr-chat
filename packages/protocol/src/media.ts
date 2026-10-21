// Media variants (ADR 0011): a client encodes two WebP sizes and the server serves the
// nearest one. These numbers are shared by the server route, the PWA and the tests so a
// mismatch cannot ship.
/** Longest edge of the preview variant, the default when no width is asked for. */
export const MEDIA_PREVIEW_EDGE = 320;
/** Longest edge of the full variant. */
export const MEDIA_FULL_EDGE = 1280;
/** Each uploaded variant is capped at this many bytes. */
export const MEDIA_VARIANT_MAX_BYTES = 400 * 1024;
/**
 * The product's placeholder budget: a ThumbHash is 21-25 bytes (ADR 0011), and 25 bytes keeps
 * the whole media field under 40 B. The wire decoder still accepts up to 32 for forward
 * compatibility; the server refuses anything larger when a post is created, so every stored
 * event stays inside the budget.
 */
export const MEDIA_THUMBHASH_MAX_BYTES = 25;

/**
 * Which stored variant answers `GET /m/{id}?w=`. The requested width is a display hint, not
 * a target size: 800 px is equidistant, and the preview wins the tie so the cheaper variant
 * is the default. A missing or unusable width also gets the preview.
 */
export function snapMediaWidth(requested: number | null | undefined): number {
  if (requested === null || requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return MEDIA_PREVIEW_EDGE;
  }
  const previewDistance = Math.abs(requested - MEDIA_PREVIEW_EDGE);
  const fullDistance = Math.abs(requested - MEDIA_FULL_EDGE);
  return previewDistance <= fullDistance ? MEDIA_PREVIEW_EDGE : MEDIA_FULL_EDGE;
}
