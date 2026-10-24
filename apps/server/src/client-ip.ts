// The address the abuse limits key on (ADR 0012). Behind a reverse proxy the socket peer is
// the proxy, so every user would share one budget; but the client writes X-Forwarded-For
// itself, so trusting its left end lets anyone pick their own IP. Only the entries our own
// proxies appended are trustworthy, and those are at the right end (ADR 0022).

/** Longest value accepted as an address; an IPv6 literal with a zone id fits well inside. */
const MAX_ADDRESS_LENGTH = 64;

/**
 * The client address for one request.
 *
 * `trustedHops = 0` (the default) uses the socket peer and ignores every header: a server
 * reachable directly must not let a header choose its rate-limit key. `trustedHops = N`
 * means N proxies we run sit in front of the server, each appending the address it saw, so
 * the Nth entry from the right is the one the outermost trusted proxy recorded. A request
 * with fewer entries than that did not pass through all of them, so it falls back to the
 * socket peer rather than to anything the client wrote.
 */
export function clientIp(req: Request, socketIp: string | undefined, trustedHops: number): string {
  const peer = socketIp || "local";
  if (trustedHops <= 0) return peer;
  const header = req.headers.get("x-forwarded-for");
  if (!header) return peer;
  const hops = header.split(",").map((entry) => entry.trim());
  const candidate = hops[hops.length - trustedHops];
  if (candidate === undefined || candidate.length === 0 || candidate.length > MAX_ADDRESS_LENGTH) return peer;
  return candidate;
}
