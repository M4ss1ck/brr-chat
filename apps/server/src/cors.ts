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
  // The dictionary headers are what a browser attaches to /sync once it stored the shared
  // dictionary (RFC 9842). Without them the preflight fails and the whole sync is blocked,
  // not just the compression (issue #21).
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Accept-Encoding, Available-Dictionary, Dictionary-ID",
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

/** BetterAuth's short-lived WebAuthn challenge cookie, plain or secure-prefixed (ADR 0021). */
function isChallengeCookie(setCookie: string): boolean {
  // BetterAuth prefixes its own cookies (`better-auth.better-auth-passkey`) and a secure
  // origin adds `__Secure-` on top, so match the stable suffix.
  const name = setCookie.slice(0, setCookie.indexOf("=")).trim();
  return name.endsWith("better-auth-passkey");
}

/**
 * The WebAuthn challenge is held in a cookie, so it only survives a same-origin passkey
 * ceremony. `appOrigin` is the configured `baseURL`, not the listener address, so a reverse
 * proxy that terminates TLS does not strip the challenge. It carries no identity: it is a
 * random token for one in-flight challenge. Every other cookie, including the session, is
 * still stripped (ADR 0020). A request without `Origin` is the browser's own same-origin GET.
 */
function sameOriginPasskey(req: Request, appOrigin: string): boolean {
  if (!new URL(req.url).pathname.startsWith("/api/auth/passkey/")) return false;
  const origin = req.headers.get("origin");
  return origin === null || origin === appOrigin;
}

/**
 * Finishes a real response at the one exit of the app handler: CORS headers only when the
 * request came from another origin, and never a session cookie. A same-origin response pays
 * nothing, because bytes are money (ADR 0018).
 */
export function withCors(req: Request, response: Response, appOrigin: string): Response {
  const headers = new Headers(response.headers);
  const challengeCookies = sameOriginPasskey(req, appOrigin)
    ? headers.getSetCookie().filter(isChallengeCookie)
    : [];
  headers.delete("set-cookie");
  for (const cookie of challengeCookies) headers.append("set-cookie", cookie);
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== new URL(req.url).origin) {
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) headers.set(name, value);
  }
  const body = response.body === null || response.status === 204 || response.status === 304 ? null : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
