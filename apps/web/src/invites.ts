// Invite links (ADR 0010, ADR 0016). The server owns the token; the client only shows it,
// rotates it, or resolves a link before sending a membership op with that token.
import { bearerHeader } from "./auth.ts";
import { meteredFetch } from "./meter.ts";

export const INVITE_PREFIX = "/api/invites/";

export interface InviteLink {
  group: number;
  token: string;
  link: string;
  /** The same URL, ready to render as a QR code. */
  qr: string;
}

export interface ResolvedInvite {
  group: number;
  name: string;
  about: string;
  open: boolean;
  members: number;
  joined: boolean;
}

interface InvitePayload {
  group?: unknown;
  token?: unknown;
  link?: unknown;
  qr?: unknown;
  name?: unknown;
  about?: unknown;
  open?: unknown;
  members?: unknown;
  joined?: unknown;
  error?: unknown;
}

async function request(
  base: string,
  path: string,
  token: string,
  method: "GET" | "POST",
): Promise<{ res: Response; payload: InvitePayload | null }> {
  const res = await meteredFetch(`${base}${path}`, {
    method,
    headers: { Accept: "application/json", Authorization: bearerHeader(token) },
  });
  const payload = (await res.json().catch(() => null)) as InvitePayload | null;
  return { res, payload };
}

function failure(res: Response, payload: InvitePayload | null, path: string): Error {
  const detail = typeof payload?.error === "string" && payload.error.length > 0 ? payload.error : `status ${res.status}`;
  return new Error(`${path}: ${detail}`);
}

function asLink(res: Response, payload: InvitePayload | null, path: string): InviteLink {
  if (!res.ok) throw failure(res, payload, path);
  const group = payload?.group;
  const token = payload?.token;
  const link = payload?.link;
  const qr = payload?.qr;
  if (typeof group !== "number" || !Number.isSafeInteger(group) || group <= 0) {
    throw new Error(`${path}: the server returned no group`);
  }
  if (typeof token !== "string" || token.length === 0) throw new Error(`${path}: the server returned no invite token`);
  if (typeof link !== "string" || link.length === 0) throw new Error(`${path}: the server returned no link`);
  // ADR 0010: the QR code is just the link encoded, never a second credential.
  return { group, token, link, qr: typeof qr === "string" && qr.length > 0 ? qr : link };
}

/** Current link for a group the account administers. */
export function getInvite(base: string, token: string, group: number): Promise<InviteLink> {
  const path = `/api/groups/${group}/invite`;
  return request(base, path, token, "GET").then(({ res, payload }) => asLink(res, payload, path));
}

/** Replace the link; the old one stops working before this call returns. */
export function rotateInvite(base: string, token: string, group: number): Promise<InviteLink> {
  const path = `/api/groups/${group}/invite/rotate`;
  return request(base, path, token, "POST").then(({ res, payload }) => asLink(res, payload, path));
}

/** Group basics for a link holder, so the join screen can say what they are joining. */
export async function resolveInvite(base: string, token: string, invite: string): Promise<ResolvedInvite> {
  const path = `${INVITE_PREFIX}${encodeURIComponent(invite)}`;
  const { res, payload } = await request(base, path, token, "GET");
  if (!res.ok) throw failure(res, payload, path);
  const group = payload?.group;
  if (typeof group !== "number" || !Number.isSafeInteger(group) || group <= 0) {
    throw new Error(`${path}: the server returned no group`);
  }
  return {
    group,
    name: typeof payload?.name === "string" ? payload.name : `group #${group}`,
    about: typeof payload?.about === "string" ? payload.about : "",
    open: payload?.open === true,
    members: typeof payload?.members === "number" ? payload.members : 0,
    joined: payload?.joined === true,
  };
}
