// Server administration over JSON beside /sync (ADR 0012, ADR 0017). Registration policy
// changes take effect on the next signup; the invite token is a capability that never enters
// the event log, exactly like a group invite link (ADR 0016).
import type { Database } from "bun:sqlite";
import { actorFor, newInviteToken } from "./events.ts";
import type { AuthInstance } from "./index.ts";
import { isRecoveryConfirmed } from "./recovery.ts";
import {
  hasServerAdminRole,
  isRegistrationMode,
  isServerAdmin,
  readServerSettings,
  writeServerSettings,
  type RegistrationMode,
  type ServerSettings,
} from "./settings.ts";

/** The public path a server invite points at. The shell serves the app for this route. */
export const SERVER_SIGNUP_PATH_PREFIX = "/signup/";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function linkFor(baseURL: string, token: string): string {
  return new URL(`${SERVER_SIGNUP_PATH_PREFIX}${token}`, baseURL).toString();
}

interface InvitePayload {
  token: string;
  link: string;
  /** The same URL, ready to render as a QR code. */
  qr: string;
}

function invitePayload(baseURL: string, settings: ServerSettings): InvitePayload | null {
  if (settings.inviteToken === null) return null;
  const link = linkFor(baseURL, settings.inviteToken);
  return { token: settings.inviteToken, link, qr: link };
}

function settingsPayload(baseURL: string, settings: ServerSettings, admin: boolean) {
  return {
    mode: settings.mode,
    frozen: settings.frozen,
    admin,
    invite: admin ? invitePayload(baseURL, settings) : null,
  };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export interface ServerAdminService {
  /** Handles every server-administration route. Null means "not mine". */
  handle(req: Request, pathname: string): Promise<Response | null>;
}

export function createServerAdminService(db: Database, auth: AuthInstance, baseURL: string): ServerAdminService {
  async function account(req: Request): Promise<{ userId: string; admin: boolean } | Response> {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session || session.user.banned) return json(401, { error: "sign in first" });
    if (!isRecoveryConfirmed(db, session.user.id)) return json(403, { error: "finish signup first" });
    return { userId: session.user.id, admin: isServerAdmin(db, session.user.id) };
  }

  async function settings(req: Request): Promise<Response> {
    const session = await account(req);
    if (session instanceof Response) return session;

    if (req.method === "GET") {
      return json(200, settingsPayload(baseURL, readServerSettings(db), session.admin));
    }
    if (req.method !== "POST") return json(405, { error: "use GET or POST" });
    if (!session.admin) return json(403, { error: "server admins only" });

    const body = await readJson(req);
    if (body === null) return json(400, { error: "expected a JSON object" });
    const mode = body.mode;
    const frozen = body.frozen;
    if (mode !== undefined && !isRegistrationMode(mode)) {
      return json(400, { error: "mode must be open, invite or closed" });
    }
    if (frozen !== undefined && typeof frozen !== "boolean") {
      return json(400, { error: "frozen must be a boolean" });
    }
    // An explicit null from a client is not a mode; only complete fields are written.
    const patch: { mode?: RegistrationMode; frozen?: boolean; inviteToken?: string } = {};
    if (mode !== undefined) patch.mode = mode;
    if (frozen !== undefined) patch.frozen = frozen;
    // Switching to invite mode always hands out a working link; otherwise the switch would
    // silently reject every signup until someone thought to press "New link".
    const current = readServerSettings(db);
    if ((mode ?? current.mode) === "invite" && current.inviteToken === null) {
      patch.inviteToken = newInviteToken();
    }
    const next = writeServerSettings(db, patch);
    return json(200, settingsPayload(baseURL, next, true));
  }

  function rotate(req: Request, admin: boolean): Response {
    if (req.method !== "POST") return json(405, { error: "rotate needs POST" });
    if (!admin) return json(403, { error: "server admins only" });
    // One UPDATE replaces the live token: the old link stops working before this returns.
    const next = writeServerSettings(db, { inviteToken: newInviteToken() });
    return json(200, settingsPayload(baseURL, next, true));
  }

  function users(admin: boolean): Response {
    if (!admin) return json(403, { error: "server admins only" });
    const rows = db
      .query("SELECT id, username, banned, role FROM user ORDER BY createdAt ASC")
      .all() as { id: string; username: string; banned: number | null; role: string | null }[];
    return json(200, {
      users: rows.map((row) => ({
        // An account that has never synced still needs a wire id to be ban-able. Allocating
        // one here is the same first-use allocation any event would do.
        user: actorFor(db, row.id).wireId,
        username: row.username,
        banned: Number(row.banned) === 1,
        admin: hasServerAdminRole(row.role),
      })),
    });
  }

  return {
    async handle(req, pathname): Promise<Response | null> {
      if (pathname === "/api/server/registration") {
        if (req.method !== "GET") return json(405, { error: "use GET" });
        const settings = readServerSettings(db);
        return json(200, { mode: settings.mode, frozen: settings.frozen });
      }
      if (pathname === "/api/server/settings") return settings(req);
      if (pathname === "/api/server/invite/rotate") {
        const session = await account(req);
        if (session instanceof Response) return session;
        return rotate(req, session.admin);
      }
      if (pathname === "/api/server/users") {
        if (req.method !== "GET") return json(405, { error: "use GET" });
        const session = await account(req);
        if (session instanceof Response) return session;
        return users(session.admin);
      }
      return null;
    },
  };
}
