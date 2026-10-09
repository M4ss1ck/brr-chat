/** Thrown for any malformed input: bad CBOR, wrong shape, out-of-range value. */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

/** Whole-response errors, sent as the trailing field of a response. */
export const ResponseError = {
  /** Client version is below the server's minimum. Client must update. */
  ClientTooOld: 1,
  /** Client version is above the server's maximum. Server must update. */
  ClientTooNew: 2,
} as const;
export type ResponseError = (typeof ResponseError)[keyof typeof ResponseError];

/** Per-op rejection reasons, sent in acks as negative integers. */
export const AckError = {
  Unsupported: 1,
  Forbidden: 2,
  Invalid: 3,
  NotFound: 4,
  RateLimited: 5,
} as const;
export type AckError = (typeof AckError)[keyof typeof AckError];
