// Identicons are the only avatars in v1: a deterministic 5x5 mirrored pattern derived from the
// wire user id (docs/PROTOCOL.md, tag 6). No image request, no stored avatar, no extra bytes.
const GRID = 5;
const CELL = 8;

function seedHash(seed: number): number {
  let hash = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function next(state: number): number {
  let value = state;
  value ^= value << 13;
  value >>>= 0;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

/** A data: URL holding a small SVG. Safe to use as an <img src>. */
export function identicon(seed: number): string {
  let state = seedHash(seed) || 1;
  const hue = state % 360;
  const cells: string[] = [];

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x <= Math.floor(GRID / 2); x++) {
      state = next(state);
      if ((state & 1) === 0) continue;
      const mirror = GRID - 1 - x;
      cells.push(`<rect x="${x * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}"/>`);
      if (mirror !== x) cells.push(`<rect x="${mirror * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}"/>`);
    }
  }

  // An all-empty grid is a valid hash but not a recognisable avatar. Keep the centre lit.
  if (cells.length === 0) {
    const centre = Math.floor(GRID / 2) * CELL;
    cells.push(`<rect x="${centre}" y="${centre}" width="${CELL}" height="${CELL}"/>`);
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID * CELL} ${GRID * CELL}" role="img">` +
    `<rect width="${GRID * CELL}" height="${GRID * CELL}" fill="hsl(${hue} 25% 16%)"/>` +
    `<g fill="hsl(${hue} 70% 62%)">${cells.join("")}</g>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
