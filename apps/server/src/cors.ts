// Cross-origin access for a client that holds several servers (#18, ADR 0020). The app is
// served by one origin and talks to the others directly; without these headers the browser
// would refuse every sync to an added server.
//
// Authentication is the bare bearer token (ADR 0007), not a cookie, so `*` grants no ambient
// authority: a request without the token is still a 401. The server also strips the session
// cookie BetterAuth would set, so a browser never carries ambient authority to this API at
// all. That is what makes trusting any client origin defensible.
//
// A cross-origin /sync costs one preflight per origin per cache lifetime (Access-Control-
// Max-Age); the page cannot see that request, so the data meter cannot count it (ADR 0018).
const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Accept-Encoding",
  "Access-Control-Expose-Headers": "Content-Length, Content-Encoding",
  // Every preflight is pure cost on a metered link; cache the answer for a day.
  "Access-Control-Max-Age": "86400",
};

/** The two headers a real cross-origin response needs. Same-origin responses get neither. */
const RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Encoding",
};

/** A browser preflight: it asks permission before the real request exists. */
export function isPreflight(req: Request): boolean {
  return (
    req.method === "OPTIONS" &&
    req.headers.has("origin") &&
    req.headers.has("access-control-request-method")
  );
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
}

/**
 * Finishes a real response at the one exit of the app handler: CORS headers only when the
 * request came from another origin, and never a session cookie. A same-origin response pays
 * nothing, because bytes are money (ADR 0018).
 */
export function withCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== new URL(req.url).origin) {
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) headers.set(name, value);
  }
  const body = response.body === null || response.status === 204 || response.status === 304 ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
