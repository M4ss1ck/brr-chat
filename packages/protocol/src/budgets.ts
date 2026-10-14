// Byte budgets from the product spec (docs/PROTOCOL.md). One definition per limit, so the
// gate in the protocol, the app shell build and the server tests cannot disagree. Raising a
// number here needs an ADR: the budget is what a metered connection pays.
export const KB = 1024;

/** Empty sync: request + response payload, HTTP headers excluded. */
export const EMPTY_SYNC_BUDGET = 1 * KB;

/** 100 text posts in one response, uncompressed. */
export const POSTS_BUDGET = 20 * KB;

/** One media placeholder, the whole media field. */
export const MEDIA_PLACEHOLDER_BUDGET = 40;

/** The whole app shell as the browser downloads it, brotli-compressed. */
export const APP_SHELL_BUDGET = 150 * KB;
