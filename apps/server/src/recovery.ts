import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthInstance } from "./index.ts";
import { FixedWindowCounter, type SignupBudget } from "./limits.ts";
import { promoteBootstrapAdmin, readServerSettings, signupGate } from "./settings.ts";

// Account recovery by code only (ADR 0006). The code is 4 groups of 5 Crockford base32
// characters: 100 bits, shown once, stored as hashes. Signing up is not finished until the
// user types the last group back; redeeming signs in, rotates the code and revokes every
// other session. There is no email recovery and no admin reset.

/** Crockford base32: no I, L, O or U, so the code cannot spell unfortunate words. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_CODE_LENGTH = 20;
export const RECOVERY_GROUP_LENGTH = 5;
const RECOVERY_GROUPS = RECOVERY_CODE_LENGTH / RECOVERY_GROUP_LENGTH;
const HASH_BYTES = 32;

/** A fresh code, unformatted. Each of the 20 characters carries 5 bits. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) {
    code += ALPHABET[byte % ALPHABET.length];
  }
  return code;
}

/** `XXXXX-XXXXX-XXXXX-XXXXX`, the shape a person reads out and writes down. */
export function formatRecoveryCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += RECOVERY_GROUP_LENGTH) {
    groups.push(code.slice(i, i + RECOVERY_GROUP_LENGTH));
  }
  return groups.slice(0, RECOVERY_GROUPS).join("-");
}

/**
 * Accept what a person actually types: lower case, spaces, hyphens, and the Crockford
 * lookalikes O, I and L. Anything else outside the alphabet stays, and then fails to match.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function hashCode(code: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(code, "utf8").digest());
}

function matchesCode(code: string, expected: Uint8Array): boolean {
  const actual = hashCode(code);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The last group is what signup asks the user to type back. */
function tail(code: string): string {
  return code.slice(-RECOVERY_GROUP_LENGTH);
}

interface RecoveryRow {
  user_id: string;
  code_hash: Uint8Array;
  tail_hash: Uint8Array;
  confirmed: number;
  created_at: number;
  updated_at: number;
}

export interface RecoveryLimits {
  /** One fixed window per key. */
  windowMs: number;
  /** Redeem attempts allowed from one IP per window. */
  perIp: number;
  /** Redeem attempts allowed for one username per window. */
  perUsername: number;
}

/** Redeeming is the only unauthenticated endpoint that touches an account, so it is tight. */
export const DEFAULT_RECOVERY_LIMITS: RecoveryLimits = {
  windowMs: 15 * 60 * 1000,
  perIp: 10,
  perUsername: 5,
};

/** Counts one attempt against both the IP and the username window, in the same fixed bucket. */
class RateLimiter {
  private readonly byIp: FixedWindowCounter;
  private readonly byUsername: FixedWindowCounter;

  constructor(limits: RecoveryLimits) {
    this.byIp = new FixedWindowCounter(limits.windowMs, limits.perIp);
    this.byUsername = new FixedWindowCounter(limits.windowMs, limits.perUsername);
  }

  check(ip: string, username: string, now: number = Date.now()): { allowed: boolean; retryAfter: number } {
    const byIp = this.byIp.consume(`ip:${ip}`, now);
    const byUsername = this.byUsername.consume(`user:${username}`, now);
    return {
      allowed: byIp.allowed && byUsername.allowed,
      retryAfter: Math.max(byIp.retryAfter, byUsername.retryAfter, 1),
    };
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function rowFor(db: Database, userId: string): RecoveryRow | null {
  return db
    .query("SELECT user_id, code_hash, tail_hash, confirmed, created_at, updated_at FROM recovery_codes WHERE user_id = ?")
    .get(userId) as RecoveryRow | null;
}

/** A DB from before recovery codes has no row: those accounts are already usable. */
export function isRecoveryConfirmed(db: Database, userId: string): boolean {
  const row = rowFor(db, userId);
  return row === null || row.confirmed === 1;
}

function saveCode(db: Database, userId: string, code: string, confirmed: boolean): void {
  const now = Date.now();
  db.query(
    `INSERT INTO recovery_codes (user_id, code_hash, tail_hash, confirmed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       code_hash = excluded.code_hash,
       tail_hash = excluded.tail_hash,
       confirmed = excluded.confirmed,
       updated_at = excluded.updated_at`,
  ).run(userId, hashCode(code), hashCode(tail(code)), confirmed ? 1 : 0, now, now);
}

/** Issues a code and stores only its hashes. The return value is the one chance to show it. */
export function createRecoveryCode(db: Database, userId: string, confirmed = false): string {
  const code = generateRecoveryCode();
  saveCode(db, userId, code, confirmed);
  return code;
}

/** Replaces an existing code; the old one stops working in the same write. */
export function rotateRecoveryCode(db: Database, userId: string, confirmed = true): string {
  return createRecoveryCode(db, userId, confirmed);
}

function confirmsLastGroup(input: string, row: RecoveryRow): boolean {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length === RECOVERY_CODE_LENGTH) return matchesCode(normalized, row.code_hash);
  return normalized.length === RECOVERY_GROUP_LENGTH && matchesCode(normalized, row.tail_hash);
}

function ipFrom(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return req.headers.get("x-real-ip")?.trim() || "local";
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function field(body: Record<string, unknown> | null, name: string): string {
  const value = body?.[name];
  return typeof value === "string" ? value : "";
}

function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

export interface RecoveryService {
  /** Handles every recovery route, including the sign-up path. Null means "not mine". */
  handle(req: Request, pathname: string, ip?: string): Promise<Response | null>;
}

export function createRecoveryService(
  db: Database,
  auth: AuthInstance,
  limits: RecoveryLimits,
  signupBudget: SignupBudget,
): RecoveryService {
  const limiter = new RateLimiter(limits);

  /** Sign-up goes through BetterAuth, then the new account gets its one recovery code. */
  async function signUp(req: Request, ip: string): Promise<Response> {
    // ADR 0012: signups are budgeted per IP. Reserve before the await so concurrent requests
    // cannot all pass the check; a failed attempt gives the slot back, so a typo is free.
    const now = Date.now();
    const gate = signupBudget.consume(ip, now);
    if (!gate.allowed) {
      return json(
        429,
        { error: "too many signups; try again later" },
        { "Retry-After": String(gate.retryAfter) },
      );
    }
    const raw = await req.arrayBuffer();
    // The invite is ours, not BetterAuth's. Read it before the account exists, then forward
    // the body without it so an unknown field never reaches the user row. A body that is not
    // JSON is left for BetterAuth to reject.
    const bytes = new Uint8Array(raw);
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON: no invite to read, and BetterAuth will answer with its own 400.
    }
    const invite = typeof body?.invite === "string" ? body.invite : null;
    const policy = signupGate(readServerSettings(db), invite);
    if (!policy.ok) {
      signupBudget.refund(ip, now);
      return json(policy.status, { error: policy.error });
    }

    let forwarded = raw;
    if (body !== null && Object.hasOwn(body, "invite")) {
      const { invite: _invite, ...rest } = body;
      forwarded = new TextEncoder().encode(JSON.stringify(rest)).buffer;
    }

    // Our path is an alias; BetterAuth only knows its own sign-up route.
    const authURL = new URL(req.url);
    authURL.pathname = "/api/auth/sign-up/email";
    const upstream = await auth.handler(
      new Request(authURL.toString(), {
        method: "POST",
        headers: req.headers,
        body: forwarded,
      }),
    );
    if (!upstream.ok) {
      signupBudget.refund(ip, now);
      return upstream;
    }

    const payload = (await upstream.json().catch(() => null)) as
      | { token?: unknown; user?: { id?: unknown } | null }
      | null;
    const userId = typeof payload?.user?.id === "string" ? payload.user.id : "";
    if (typeof payload?.token !== "string" || userId.length === 0) {
      return json(500, { error: "sign-up did not return a session" });
    }

    const code = createRecoveryCode(db, userId, false);
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.set("Content-Type", "application/json");
    headers.set("Cache-Control", "no-store");
    return new Response(JSON.stringify({ ...payload, recoveryCode: formatRecoveryCode(code), recoveryConfirmed: false }), {
      status: 200,
      headers,
    });
  }

  async function confirm(req: Request): Promise<Response> {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return json(401, { error: "sign in first" });

    const body = await readJson(req);
    const typed = field(body, "group") || field(body, "code");
    if (normalizeRecoveryCode(typed).length === 0) return json(400, { error: "type the last group of your code" });

    const row = rowFor(db, session.user.id);
    if (!row) return json(409, { error: "this account has no recovery code; regenerate one" });
    if (!confirmsLastGroup(typed, row)) return json(400, { error: "that is not the last group of your code" });

    db.transaction(() => {
      db.query("UPDATE recovery_codes SET confirmed = 1, updated_at = ? WHERE user_id = ?").run(
        Date.now(),
        session.user.id,
      );
      // Bootstrap happens only after signup is finished: an account that never types back its
      // code must not hold the server's only admin role forever (ADR 0017).
      promoteBootstrapAdmin(db, session.user.id);
    })();
    return json(200, { confirmed: true });
  }

  async function regenerate(req: Request): Promise<Response> {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return json(401, { error: "sign in first" });

    const existing = rowFor(db, session.user.id);
    const confirmed = existing === null ? true : existing.confirmed === 1;
    const code = rotateRecoveryCode(db, session.user.id, confirmed);
    return json(200, { recoveryCode: formatRecoveryCode(code), recoveryConfirmed: confirmed });
  }

  async function redeem(req: Request, ip: string): Promise<Response> {
    const body = await readJson(req);
    const username = field(body, "username");
    const code = field(body, "code");
    const key = usernameKey(username);
    if (key.length === 0 || normalizeRecoveryCode(code).length === 0) {
      return json(400, { error: "username and recovery code are both required" });
    }

    const gate = limiter.check(ip, key);
    if (!gate.allowed) {
      return json(429, { error: "too many attempts; try again later" }, { "Retry-After": String(gate.retryAfter) });
    }

    const user = db.query("SELECT id, banned FROM user WHERE lower(username) = ?").get(key) as {
      id: string;
      banned: number | null;
    } | null;
    const row = user ? rowFor(db, user.id) : null;
    // Hash even when there is no row, so an unknown username costs the same as a wrong code.
    const expected = row?.code_hash ?? new Uint8Array(HASH_BYTES);
    const normalized = normalizeRecoveryCode(code);
    const matches = matchesCode(normalized, expected);
    // A server ban is an access ban, not just a session revocation: a recovery code must not
    // mint a fresh session for a banned account (ADR 0012, ADR 0017). The check stays after
    // the hash so a banned username answers in the same time as any other wrong attempt.
    const banned = Number(user?.banned) === 1;
    if (user === null || row === null || banned || normalized.length !== RECOVERY_CODE_LENGTH || !matches) {
      return json(401, { error: "invalid username or recovery code" });
    }

    const ctx = await auth.$context;
    // Every old session dies before the new one is issued: a stolen session cannot survive
    // the recovery it was taken from. The code rotates last: a failure there leaves the old
    // code usable, instead of taking it away without handing back a session.
    await ctx.internalAdapter.deleteUserSessions(user.id);
    const session = await ctx.internalAdapter.createSession(user.id, false);
    const nextCode = rotateRecoveryCode(db, user.id, true);
    // The username plugin's column is not in the base User type BetterAuth exports.
    const account = (await ctx.internalAdapter.findUserById(user.id)) as Record<string, unknown> | null;
    const name = typeof account?.name === "string" ? account.name : username;
    const email = typeof account?.email === "string" ? account.email : "";
    const accountUsername = typeof account?.username === "string" ? account.username : username;

    return json(200, {
      token: session.token,
      user: { id: user.id, username: accountUsername, name, email },
      recoveryCode: formatRecoveryCode(nextCode),
      recoveryConfirmed: true,
    });
  }

  async function status(req: Request): Promise<Response> {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return json(401, { error: "sign in first" });
    return json(200, { confirmed: isRecoveryConfirmed(db, session.user.id) });
  }

  return {
    async handle(req, pathname, ip = ipFrom(req)): Promise<Response | null> {
      if (pathname === "/api/auth/sign-up/email" && req.method === "POST") return signUp(req, ip);
      if (pathname === "/api/recovery/sign-up" && req.method === "POST") return signUp(req, ip);
      if (pathname === "/api/recovery/confirm" && req.method === "POST") return confirm(req);
      if (pathname === "/api/recovery/regenerate" && req.method === "POST") return regenerate(req);
      if (pathname === "/api/recovery/redeem" && req.method === "POST") return redeem(req, ip);
      if (pathname === "/api/recovery/status" && req.method === "GET") return status(req);
      return null;
    },
  };
}
