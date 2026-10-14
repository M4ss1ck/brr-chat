// Auth over plain fetch (ADR 0014): BetterAuth endpoints called directly, with the bare
// 32-char session token (ADR 0007). No better-auth/client bundle in the app shell.
import { getSession, setSession, type Session } from "./store.ts";

export const SIGN_UP_PATH = "/api/auth/sign-up/email";
export const SIGN_IN_PATH = "/api/auth/sign-in/username";
export const SIGN_OUT_PATH = "/api/auth/sign-out";

interface AuthPayload {
  token?: unknown;
  user?: { username?: unknown } | null;
}

async function postCredentials(base: string, path: string, username: string, password: string): Promise<Session> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = (await res.json().catch(() => null)) as AuthPayload | null;
  const token = typeof payload?.token === "string" ? payload.token : "";
  if (!res.ok || token.length === 0) {
    throw new Error(`${path} failed with status ${res.status}`);
  }
  const session: Session = {
    token,
    username: typeof payload?.user?.username === "string" ? payload.user.username : username,
  };
  await setSession(session);
  return session;
}

/** Username + password sign-up. The server fills the placeholder email (ADR 0002). */
export function signUp(base: string, username: string, password: string): Promise<Session> {
  return postCredentials(base, SIGN_UP_PATH, username, password);
}

/** Username + password sign-in on the same device, returning the stored session. */
export function signIn(base: string, username: string, password: string): Promise<Session> {
  return postCredentials(base, SIGN_IN_PATH, username, password);
}

/**
 * Revokes the session on the server. The token stays on the device until the server confirms:
 * dropping it first would leave a live session this device can no longer revoke.
 */
export async function signOut(base: string): Promise<void> {
  const session = await getSession();
  if (!session) return;
  const res = await fetch(`${base}${SIGN_OUT_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) throw new Error(`${SIGN_OUT_PATH} failed with status ${res.status}`);
  await setSession(null);
}

/** Authorization header for the bare token (ADR 0007), or null when signed out. */
export async function authorizationHeader(): Promise<string | null> {
  const session = await getSession();
  return session ? `Bearer ${session.token}` : null;
}
