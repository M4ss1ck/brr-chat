// Server-wide settings and the one server-admin role (ADR 0012, ADR 0017). Registration is
// a server decision, not a group one, so it lives in a singleton row read on every signup.
// The first account on a server, or the first account after every admin is gone, becomes a
// server admin; without that bootstrap nobody could ever change a setting.
import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";

export const RegistrationMode = { Open: "open", Invite: "invite", Closed: "closed" } as const;
export type RegistrationMode = (typeof RegistrationMode)[keyof typeof RegistrationMode];

export function isRegistrationMode(value: unknown): value is RegistrationMode {
  return value === RegistrationMode.Open || value === RegistrationMode.Invite || value === RegistrationMode.Closed;
}

export interface ServerSettings {
  mode: RegistrationMode;
  frozen: boolean;
  /** The current server invite token, or null before the first rotation. */
  inviteToken: string | null;
}

interface SettingsRow {
  registration_mode: string;
  registration_frozen: number;
  invite_token: string | null;
}

/**
 * BetterAuth stores several roles as a comma-separated list when a user has more than one.
 * Kept here, next to the settings it gates, so both the sync log and the admin routes agree.
 */
export function hasServerAdminRole(role: string | null): boolean {
  return (role ?? "")
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
}

export function isServerAdmin(db: Database, userId: string): boolean {
  const row = db.query("SELECT role FROM user WHERE id = ?").get(userId) as { role: string | null } | null;
  return hasServerAdminRole(row?.role ?? null);
}

export function readServerSettings(db: Database): ServerSettings {
  const row = db
    .query("SELECT registration_mode, registration_frozen, invite_token FROM server_settings WHERE id = 1")
    .get() as SettingsRow | null;
  // The row is inserted by openDb. A read before that (or from a hand-made test DB) still has
  // to answer, and open/no-freeze is the only safe default for a community. A damaged value in
  // an existing row fails closed instead of silently opening a server that meant to be closed.
  if (!row) return { mode: RegistrationMode.Open, frozen: false, inviteToken: null };
  return {
    mode: isRegistrationMode(row.registration_mode) ? row.registration_mode : RegistrationMode.Closed,
    frozen: Number(row.registration_frozen) === 1,
    inviteToken: row.invite_token,
  };
}

export function writeServerSettings(
  db: Database,
  patch: { mode?: RegistrationMode; frozen?: boolean; inviteToken?: string | null },
  now = Math.floor(Date.now() / 1000),
): ServerSettings {
  // Per-column writes in one transaction, not a read-modify-write of the whole row: a mode
  // change must not put a concurrently rotated invite token back, and vice versa.
  db.transaction(() => {
    db.query(
      "INSERT OR IGNORE INTO server_settings (id, registration_mode, registration_frozen, invite_token, updated_at) VALUES (1, 'open', 0, NULL, ?)",
    ).run(now);
    if (patch.mode !== undefined) {
      db.query("UPDATE server_settings SET registration_mode = ?, updated_at = ? WHERE id = 1").run(patch.mode, now);
    }
    if (patch.frozen !== undefined) {
      db.query("UPDATE server_settings SET registration_frozen = ?, updated_at = ? WHERE id = 1").run(
        patch.frozen ? 1 : 0,
        now,
      );
    }
    if (patch.inviteToken !== undefined) {
      db.query("UPDATE server_settings SET invite_token = ?, updated_at = ? WHERE id = 1").run(patch.inviteToken, now);
    }
  })();
  return readServerSettings(db);
}

/** Constant-time token comparison, so a wrong invite leaks no prefix. */
export function tokenMatches(expected: string | null, actual: string | null | undefined): boolean {
  if (expected === null || typeof actual !== "string" || actual.length === 0) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type SignupGate =
  | { ok: true }
  | { ok: false; status: 403; error: string };

/**
 * The one place a new account is allowed in. Read at request time, so the freeze switch and a
 * mode change take effect on the very next signup with no restart.
 */
export function signupGate(settings: ServerSettings, invite: string | null | undefined): SignupGate {
  if (settings.frozen) return { ok: false, status: 403, error: "signups are frozen" };
  switch (settings.mode) {
    case RegistrationMode.Open:
      return { ok: true };
    case RegistrationMode.Invite:
      return tokenMatches(settings.inviteToken, invite)
        ? { ok: true }
        : { ok: false, status: 403, error: "this server needs a server invite link" };
    case RegistrationMode.Closed:
      return { ok: false, status: 403, error: "this server is closed to new signups" };
  }
}

/**
 * Bootstrap: the first account, or the first account after every admin is gone, is made a
 * server admin. Returns true when this account was promoted.
 */
export function promoteBootstrapAdmin(db: Database, userId: string): boolean {
  // One statement, so two simultaneous first signups cannot both observe "no admin" and
  // promote each other. The subquery excludes the account being promoted.
  const result = db
    .query(
      `UPDATE user SET role = 'admin'
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM user
           WHERE id <> ?
             AND COALESCE(banned, 0) = 0
             AND (',' || replace(COALESCE(role, ''), ' ', '') || ',') LIKE '%,admin,%'
         )`,
    )
    .run(userId, userId);
  return Number(result.changes) > 0;
}
