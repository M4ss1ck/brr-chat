// One client, several servers (ADR 0001, ADR 0020). A server is identified by its origin:
// that is what the browser fetches, what the account's token belongs to, and what namespaces
// its cached events. Group and DM ids are small integers local to one server, so the origin is
// the only thing that keeps two servers' logs apart on one device.
//
// A server is added by a link (or the QR code that encodes the same link). The link may be a
// bare address, a server invite (`/signup/<token>`) or a group invite (`/join/<token>`). The
// token is kept beside the server until sign-up or join consumes it; it never enters a URL
// this app navigates to.

/** The two kinds of capability a link can carry. Both are server-side tokens, not events. */
export type InviteKind = "signup" | "join";

export interface PendingInvite {
  kind: InviteKind;
  token: string;
}

export interface ServerLink {
  /** Canonical origin, e.g. `https://chat.example`. The server's id on this device. */
  server: string;
  /** Present when the link is an invite link for an account or a group on that server. */
  invite: PendingInvite | null;
}

const TOKEN_PATTERN = "[A-Za-z0-9_-]{16,64}";
const INVITE_PATH = new RegExp(`^/(signup|join)/(${TOKEN_PATTERN})/?$`);
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/** True when the input already names a scheme, so it must not be prefixed again. */
function hasScheme(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
}

/**
 * A typed address without a scheme is the common case on a phone. Default to https, except
 * for a loopback host where a development server is plain http.
 */
function withScheme(raw: string): string {
  if (hasScheme(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  return `${LOOPBACK.test(raw.split("/")[0] ?? "") ? "http" : "https"}://${raw}`;
}

/**
 * The canonical origin for a URL or origin string, or null when it is not an http(s) server.
 * Credentials in the URL are refused: a server URL is not a place to hide a password.
 */
export function serverIdOf(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(withScheme(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.hostname.length === 0) return null;
  return url.origin;
}

/**
 * Parses what a person pastes or what a QR code contains. Anything beyond a bare origin has
 * to be one of the two invite paths this server serves; an unknown path is a typo, not a
 * server we quietly drop the path from.
 */
export function parseServerLink(raw: string): ServerLink | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  let url: URL;
  try {
    url = new URL(withScheme(text));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.hostname.length === 0) return null;

  const server = url.origin;
  const path = url.pathname.replace(/\/+$/, "");
  if (path.length === 0) return { server, invite: null };

  const match = INVITE_PATH.exec(path);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return {
    server,
    invite: { kind: match[1] === "signup" ? "signup" : "join", token: match[2] },
  };
}

/** What the server list shows. The host (with its port) is the honest label without a server call. */
export function serverLabel(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** The reverse of `serverIdOf` for a request URL: the server a fetch is talking to. */
export function serverOfUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
