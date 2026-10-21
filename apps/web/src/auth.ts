// Auth over plain fetch (ADR 0014): BetterAuth endpoints called directly, with the bare
// 32-char session token (ADR 0007). No better-auth/client bundle in the app shell.
import { meteredFetch } from "./meter.ts";
import { serverIdOf } from "./servers.ts";
import { getSession, setSession, type Account, type Session } from "./store.ts";


export const SIGN_UP_PATH = "/api/recovery/sign-up";
export const SIGN_IN_PATH = "/api/auth/sign-in/username";
export const SIGN_OUT_PATH = "/api/auth/sign-out";
export const CONFIRM_PATH = "/api/recovery/confirm";
export const REGENERATE_PATH = "/api/recovery/regenerate";
export const REDEEM_PATH = "/api/recovery/redeem";
export const STATUS_PATH = "/api/recovery/status";

interface AuthPayload {
  token?: unknown;
  user?: { username?: unknown } | null;
  recoveryCode?: unknown;
  error?: unknown;
}

interface Exchange {
  session: Account;
  recoveryCode: string;
}

/**
 * A request's base is the server it goes to. Every session write is keyed by that origin, so
 * signing in to a second server cannot overwrite the first one's account (ADR 0020).
 */
function serverOf(base: string): string {
  const server = serverIdOf(base);
  if (server === null) throw new Error(`auth: expected an http(s) server, got ${base}`);
  return server;
}

async function remember(server: string, session: Session): Promise<Account> {
  await setSession(server, session);
  return { server, ...session };
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ res: Response; payload: AuthPayload | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (token !== undefined) headers.Authorization = bearerHeader(token);
  const res = await meteredFetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = (await res.json().catch(() => null)) as AuthPayload | null;
  return { res, payload };
}

function failure(res: Response, payload: AuthPayload | null, path: string): Error {
  const detail = typeof payload?.error === "string" && payload.error.length > 0 ? payload.error : `status ${res.status}`;
  return new Error(`${path}: ${detail}`);
}

function codeFrom(payload: AuthPayload | null, res: Response, path: string): string {
  if (!res.ok) throw failure(res, payload, path);
  const code = typeof payload?.recoveryCode === "string" ? payload.recoveryCode : "";
  if (code.length === 0) throw new Error(`${path}: the server returned no recovery code`);
  return code;
}

function sessionFrom(payload: AuthPayload | null, res: Response, path: string, username: string): Session {
  if (!res.ok) throw failure(res, payload, path);
  const token = typeof payload?.token === "string" ? payload.token : "";
  if (token.length === 0) throw new Error(`${path}: the server returned no session token`);
  return { token, username: typeof payload?.user?.username === "string" ? payload.user.username : username };
}

async function exchange(
  base: string,
  path: string,
  body: unknown,
  username: string,
  options: { token?: string; pending?: boolean } = {},
): Promise<Exchange> {
  const { res, payload } = await postJson(base, path, body, options.token);
  const session = sessionFrom(payload, res, path, username);
  const recoveryCode = codeFrom(payload, res, path);
  if (options.pending === true) session.recoveryPending = true;
  const stored = await remember(serverOf(base), session);
  return { session: stored, recoveryCode };
}

/**
 * Create an account. The server also returns the one recovery code it will ever show; the
 * session stays pending until the last group is typed back, so the caller must confirm.
 * `invite` is the server invite token on an invite-only server (ADR 0012).
 */
export function signUp(base: string, username: string, password: string, invite?: string): Promise<Exchange> {
  const body = invite === undefined || invite.length === 0 ? { username, password } : { username, password, invite };
  return exchange(base, SIGN_UP_PATH, body, username, { pending: true });
}

/** Username + password sign-in on the same device, returning the stored account. */
export async function signIn(base: string, username: string, password: string): Promise<Account> {
  const { res, payload } = await postJson(base, SIGN_IN_PATH, { username, password });
  const session = sessionFrom(payload, res, SIGN_IN_PATH, username);
  // A signup that never finished can still be signed in to; say so, so the UI asks for the
  // type-back instead of hiding it behind a sync that always 403s.
  if (!(await recoveryConfirmed(base, session.token))) session.recoveryPending = true;
  return remember(serverOf(base), session);
}

/** True unless the server says otherwise; a failed check must not block signing in. */
async function recoveryConfirmed(base: string, token: string): Promise<boolean> {
  const res = await meteredFetch(`${base}${STATUS_PATH}`, { headers: { Authorization: bearerHeader(token) } }).catch(() => null);
  if (!res?.ok) return true;
  const payload = (await res.json().catch(() => null)) as { confirmed?: unknown } | null;
  return payload?.confirmed !== false;
}

/** Finish signup by typing back the last group of the code (ADR 0006). */
export async function confirmRecovery(base: string, group: string): Promise<void> {
  const server = serverOf(base);
  const session = await getSession(server);
  if (!session) throw new Error("Sign in first.");
  const { res, payload } = await postJson(base, CONFIRM_PATH, { group }, session.token);
  if (!res.ok) throw failure(res, payload, CONFIRM_PATH);
  await setSession(server, { ...session, recoveryPending: false });
}

/** Issue a new code; the old one dies. Needs a signed-in session. */
export async function regenerateRecovery(base: string): Promise<string> {
  const session = await getSession(serverOf(base));
  if (!session) throw new Error("Sign in first.");
  const { res, payload } = await postJson(base, REGENERATE_PATH, {}, session.token);
  return codeFrom(payload, res, REGENERATE_PATH);
}

/**
 * Sign in with a recovery code. The server rotates the code and revokes every other session,
 * so the caller must show the new code before the user can lose it.
 */
export function redeemRecovery(base: string, username: string, code: string): Promise<Exchange> {
  return exchange(base, REDEEM_PATH, { username, code }, username);
}

/**
 * Revokes the session on the server. The token stays on the device until the server confirms:
 * dropping it first would leave a live session this device can no longer revoke.
 */
export async function signOut(base: string): Promise<void> {
  const server = serverOf(base);
  const session = await getSession(server);
  if (!session) return;
  const res = await meteredFetch(`${server}${SIGN_OUT_PATH}`, {
    method: "POST",
    headers: { Authorization: bearerHeader(session.token) },
  });
  if (!res.ok) throw new Error(`${SIGN_OUT_PATH} failed with status ${res.status}`);
  await setSession(server, null);
}

/** The one place the bare token becomes a header (ADR 0007). */
export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}
