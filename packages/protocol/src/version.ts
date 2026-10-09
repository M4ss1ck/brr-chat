import { ResponseError } from "./errors.ts";

/** The version this build speaks. Bump only for changes old peers would misread; see docs/adr/0004. */
export const PROTOCOL_VERSION = 1;

export interface VersionRange {
  min: number;
  max: number;
}

/** Versions this build can serve. Widen `max` when adding a version; raise `min` only with an ADR. */
export const SUPPORTED: VersionRange = { min: 1, max: 1 };

/** null when `client` is servable, otherwise the error to return. */
export function negotiate(client: number, server: VersionRange): ResponseError | null {
  if (!Number.isSafeInteger(client) || client < server.min) return ResponseError.ClientTooOld;
  if (client > server.max) return ResponseError.ClientTooNew;
  return null;
}
