// Server administration over JSON (ADR 0012, ADR 0017). The PWA only shows this panel to a
// server admin; every route is enforced server-side, so hiding it is convenience, not access.
import { bearerHeader } from "./auth.ts";
import { meteredFetch } from "./meter.ts";

export type RegistrationMode = "open" | "invite" | "closed";

export interface ServerInvite {
  token: string;
  link: string;
  /** The same URL, ready to render as a QR code. */
  qr: string;
}

export interface ServerSettings {
  mode: RegistrationMode;
  frozen: boolean;
  admin: boolean;
  invite: ServerInvite | null;
}

export interface RegistrationState {
  mode: RegistrationMode;
  frozen: boolean;
}

export interface ServerUser {
  user: number;
  username: string;
  banned: boolean;
  admin: boolean;
}

interface ServerPayload {
  mode?: unknown;
  frozen?: unknown;
  admin?: unknown;
  invite?: unknown;
  users?: unknown;
  error?: unknown;
}

function asMode(value: unknown): RegistrationMode | null {
  return value === "open" || value === "invite" || value === "closed" ? value : null;
}

function asInvite(value: unknown): ServerInvite | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const token = row.token;
  const link = row.link;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof link !== "string" || link.length === 0) return null;
  return { token, link, qr: typeof row.qr === "string" && row.qr.length > 0 ? row.qr : link };
}

function failure(res: Response, payload: ServerPayload | null, path: string): Error {
  const detail = typeof payload?.error === "string" && payload.error.length > 0 ? payload.error : `status ${res.status}`;
  return new Error(`${path}: ${detail}`);
}

async function request(
  base: string,
  path: string,
  token: string | undefined,
  method: "GET" | "POST",
  body?: unknown,
): Promise<{ res: Response; payload: ServerPayload | null }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== undefined) headers.Authorization = bearerHeader(token);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await meteredFetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await res.json().catch(() => null)) as ServerPayload | null;
  return { res, payload };
}

function asSettings(res: Response, payload: ServerPayload | null, path: string): ServerSettings {
  if (!res.ok) throw failure(res, payload, path);
  const mode = asMode(payload?.mode);
  if (mode === null) throw new Error(`${path}: the server returned no registration mode`);
  if (typeof payload?.frozen !== "boolean") throw new Error(`${path}: the server returned no freeze state`);
  return {
    mode,
    frozen: payload.frozen,
    admin: payload.admin === true,
    invite: asInvite(payload.invite),
  };
}

/** Registration policy and, for an admin, the current server invite. */
export function getServerSettings(base: string, token: string): Promise<ServerSettings> {
  const path = "/api/server/settings";
  return request(base, path, token, "GET").then(({ res, payload }) => asSettings(res, payload, path));
}

/** Change one or both switches; the response is the policy that is now live. */
export function saveServerSettings(
  base: string,
  token: string,
  patch: { mode?: RegistrationMode; frozen?: boolean },
): Promise<ServerSettings> {
  const path = "/api/server/settings";
  return request(base, path, token, "POST", patch).then(({ res, payload }) => asSettings(res, payload, path));
}

/** Replace the server invite link; the old one stops working before this returns. */
export function rotateServerInvite(base: string, token: string): Promise<ServerSettings> {
  const path = "/api/server/invite/rotate";
  return request(base, path, token, "POST").then(({ res, payload }) => asSettings(res, payload, path));
}

/** Every account the admin can act on, with the wire id a server ban needs. */
export async function getServerUsers(base: string, token: string): Promise<ServerUser[]> {
  const path = "/api/server/users";
  const { res, payload } = await request(base, path, token, "GET");
  if (!res.ok) throw failure(res, payload, path);
  const rows = Array.isArray(payload?.users) ? payload.users : [];
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;
    if (typeof r.user !== "number" || !Number.isSafeInteger(r.user) || r.user <= 0) return [];
    if (typeof r.username !== "string") return [];
    return [
      {
        user: r.user,
        username: r.username,
        banned: r.banned === true,
        admin: r.admin === true,
      },
    ];
  });
}

/** Public registration state for the sign-in screen; no session needed. */
export async function getRegistration(base: string): Promise<RegistrationState | null> {
  const res = await meteredFetch(`${base}/api/server/registration`, { headers: { Accept: "application/json" } }).catch(() => null);
  if (!res?.ok) return null;
  const payload = (await res.json().catch(() => null)) as ServerPayload | null;
  const mode = asMode(payload?.mode);
  if (mode === null || typeof payload?.frozen !== "boolean") return null;
  return { mode, frozen: payload.frozen };
}
