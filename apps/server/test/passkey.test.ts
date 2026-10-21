// Passkeys (#19): a software authenticator walks the real WebAuthn ceremony against the
// plugin's endpoints, so the test proves the server verifies attestations and assertions
// instead of only checking that routes exist. Chromium and Firefox both speak exactly this
// wire format; running it here keeps the browser out of the gate.
import { describe, expect, test } from "bun:test";
import { createApp, type ServerApp } from "../src/index.ts";

const ORIGIN = "http://chat.local";
const RP_ID = "chat.local";
const PASSWORD = "password1234";

interface SignUpPayload {
  token: string;
  recoveryCode: string;
  user: { id: string; username: string };
}

interface RegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  authenticatorSelection?: { residentKey?: string };
  excludeCredentials?: unknown[];
}

interface AuthenticationOptions {
  challenge: string;
  rpId: string;
  allowCredentials?: unknown[];
}

interface AuthResponse {
  session: { token: string; userId: string };
  user: { username: string };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function signUpConfirmed(app: ServerApp, username = "alice"): Promise<SignUpPayload> {
  const res = await app.fetch(
    request("/api/recovery/sign-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as SignUpPayload;
  const confirm = await app.fetch(
    request("/api/recovery/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ group: body.recoveryCode.slice(-5) }),
    }),
  );
  expect(confirm.status).toBe(200);
  return body;
}

function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((cookie) => cookie.length > 0)
    .join("; ");
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** WebCrypto's BufferSource requires an ArrayBuffer-backed view, not any ArrayBufferLike. */
type Bytes = Uint8Array<ArrayBuffer>;

function concat(...arrays: Uint8Array[]): Bytes {
  const length = arrays.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of arrays) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(text: string): Bytes {
  return new TextEncoder().encode(text) as Bytes;
}

function shortBytes(bytes: Uint8Array): Bytes {
  return concat(new Uint8Array([0x58, bytes.length]), bytes);
}

/** The minimal CBOR map an authenticator sends for `none` attestation. */
function attestationObject(authData: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([0xa3]),
    new Uint8Array([0x63]),
    utf8("fmt"),
    new Uint8Array([0x64]),
    utf8("none"),
    new Uint8Array([0x67]),
    utf8("attStmt"),
    new Uint8Array([0xa0]),
    new Uint8Array([0x68]), // text(8)
    utf8("authData"),
    shortBytes(authData),
  );
}

/** COSE_Key for an EC2 P-256 public key, the shape WebAuthn requires. */
function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([0xa5]),
    new Uint8Array([0x01, 0x02]), // 1 (kty): 2 (EC2)
    new Uint8Array([0x03, 0x26]), // 3 (alg): -7 (ES256)
    new Uint8Array([0x20, 0x01]), // -1 (crv): 1 (P-256)
    new Uint8Array([0x21]),
    shortBytes(x), // -2 (x)
    new Uint8Array([0x22]),
    shortBytes(y), // -3 (y)
  );
}

function derInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = bytes.subarray(start);
  const positive = (body[0] ?? 0) < 0x80 ? body : concat(new Uint8Array([0x00]), body);
  return concat(new Uint8Array([0x02, positive.length]), positive);
}

function derSignature(raw: Uint8Array): Uint8Array {
  const r = derInteger(raw.subarray(0, 32));
  const s = derInteger(raw.subarray(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

async function digest(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

interface Authenticator {
  credentialId: Uint8Array;
  key: CryptoKey;
  publicKey: CryptoKey;
  counter: number;
}

/** One in-memory authenticator: it keeps a P-256 key and signs the challenge it is given. */
async function newAuthenticator(): Promise<Authenticator> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    key: pair.privateKey,
    publicKey: pair.publicKey,
    counter: 0,
  };
}

async function registrationResponse(options: RegistrationOptions, authenticator: Authenticator): Promise<unknown> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", authenticator.publicKey));
  const x = raw.subarray(1, 33);
  const y = raw.subarray(33, 65);
  const rpIdHash = await digest(utf8(options.rp.id));
  const flags = 0x45; // user present, user verified, attested credential data
  const counter = new Uint8Array([0, 0, 0, 0]);
  const aaguid = new Uint8Array(16);
  const length = new Uint8Array([authenticator.credentialId.length >> 8, authenticator.credentialId.length & 0xff]);
  const authData = concat(rpIdHash, new Uint8Array([flags]), counter, aaguid, length, authenticator.credentialId, coseKey(x, y));
  const clientData = JSON.stringify({
    type: "webauthn.create",
    challenge: options.challenge,
    origin: ORIGIN,
    crossOrigin: false,
  });
  return {
    id: b64url(authenticator.credentialId),
    rawId: b64url(authenticator.credentialId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(utf8(clientData)),
      attestationObject: b64url(attestationObject(authData)),
      transports: ["internal"],
    },
  };
}

async function authenticationResponse(options: AuthenticationOptions, authenticator: Authenticator): Promise<unknown> {
  authenticator.counter += 1;
  const rpIdHash = await digest(utf8(options.rpId));
  const counter = new Uint8Array([
    (authenticator.counter >>> 24) & 0xff,
    (authenticator.counter >>> 16) & 0xff,
    (authenticator.counter >>> 8) & 0xff,
    authenticator.counter & 0xff,
  ]);
  const authData = concat(rpIdHash, new Uint8Array([0x05]), counter); // user present, user verified
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge: options.challenge,
    origin: ORIGIN,
    crossOrigin: false,
  });
  const clientDataBytes = utf8(clientData);
  const signed = concat(authData, await digest(clientDataBytes));
  const signature = derSignature(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, authenticator.key, signed)));
  return {
    id: b64url(authenticator.credentialId),
    rawId: b64url(authenticator.credentialId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(clientDataBytes),
      authenticatorData: b64url(authData),
      signature: b64url(signature),
      userHandle: null,
    },
  };
}

async function registrationOptions(app: ServerApp, token: string): Promise<{ options: RegistrationOptions; cookie: string }> {
  const res = await app.fetch(
    request("/api/auth/passkey/generate-register-options", {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
    }),
  );
  expect(res.status).toBe(200);
  return { options: (await res.json()) as RegistrationOptions, cookie: cookieFrom(res) };
}

async function registerPasskey(app: ServerApp, token: string, authenticator?: Authenticator): Promise<{ auth: Authenticator; options: RegistrationOptions }> {
  const auth = authenticator ?? (await newAuthenticator());
  const { options, cookie } = await registrationOptions(app, token);
  const res = await app.fetch(
    request("/api/auth/passkey/verify-registration", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Origin: ORIGIN,
        Cookie: cookie,
      },
      body: JSON.stringify({ response: await registrationResponse(options, auth), name: "Test authenticator" }),
    }),
  );
  expect(res.status).toBe(200);
  return { auth, options };
}

async function authenticationOptions(app: ServerApp): Promise<{ options: AuthenticationOptions; cookie: string }> {
  const res = await app.fetch(
    request("/api/auth/passkey/generate-authenticate-options", { headers: { Origin: ORIGIN } }),
  );
  expect(res.status).toBe(200);
  return { options: (await res.json()) as AuthenticationOptions, cookie: cookieFrom(res) };
}

async function authenticate(app: ServerApp, authenticator: Authenticator): Promise<AuthResponse> {
  const { options, cookie } = await authenticationOptions(app);
  const res = await app.fetch(
    request("/api/auth/passkey/verify-authentication", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
      body: JSON.stringify({ response: await authenticationResponse(options, authenticator) }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as AuthResponse;
}

async function syncStatus(app: ServerApp, token: string): Promise<number> {
  const res = await app.fetch(
    request("/sync", {
      method: "POST",
      headers: { "Content-Type": "application/cbor", Authorization: `Bearer ${token}` },
      body: new Uint8Array([0x83, 0x01, 0x00, 0x80]),
    }),
  );
  return res.status;
}

describe("passkeys (#19)", () => {
  test("the registration prompt names the username, never the placeholder email", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const { token } = await signUpConfirmed(app, "alice");
      const { options } = await registrationOptions(app, token);
      expect(options.rp.id).toBe(RP_ID);
      expect(options.rp.name).toBe("brr chat");
      expect(options.user.name).toBe("alice");
      expect(options.user.displayName).toBe("alice");
      // Username-less sign-in only works when the credential is discoverable.
      expect(options.authenticatorSelection?.residentKey).toBe("required");
      expect(JSON.stringify(options)).not.toContain("@chat.local.invalid");
    } finally {
      app.close();
    }
  });

  test("an attested credential is verified and stored against the account", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const body = await signUpConfirmed(app);
      const { auth } = await registerPasskey(app, body.token);
      const row = app.db
        .query("SELECT userId, credentialID, counter, name FROM passkey")
        .get() as { userId: string; credentialID: string; counter: number; name: string } | null;
      expect(row).not.toBeNull();
      expect(row?.userId).toBe(body.user.id);
      expect(row?.credentialID).toBe(b64url(auth.credentialId));
      expect(row?.counter).toBe(0);
      expect(row?.name).toBe("Test authenticator");
    } finally {
      app.close();
    }
  });

  test("sign in with a passkey returns a working bare session and moves the counter", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const body = await signUpConfirmed(app);
      const { auth } = await registerPasskey(app, body.token);

      const signedIn = await authenticate(app, auth);
      expect(signedIn.user.username).toBe("alice");
      expect(signedIn.session.token).toHaveLength(32);
      expect(signedIn.session.token).not.toContain(".");
      expect(await syncStatus(app, signedIn.session.token)).toBe(200);

      const row = app.db.query("SELECT counter FROM passkey").get() as { counter: number } | null;
      expect(row?.counter).toBe(1);
    } finally {
      app.close();
    }
  });

  test("a server-banned account cannot mint a session with a passkey", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const body = await signUpConfirmed(app);
      const { auth } = await registerPasskey(app, body.token);
      app.db.query("UPDATE user SET banned = 1 WHERE id = ?").run(body.user.id);
      app.db.query("DELETE FROM session WHERE userId = ?").run(body.user.id);

      const { options, cookie } = await authenticationOptions(app);
      const res = await app.fetch(
        request("/api/auth/passkey/verify-authentication", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
          body: JSON.stringify({ response: await authenticationResponse(options, auth) }),
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      const sessions = app.db.query("SELECT COUNT(*) AS n FROM session WHERE userId = ?").get(body.user.id) as { n: number };
      // The signup session was revoked by the ban, so no session may survive the attempt.
      expect(sessions.n).toBe(0);
    } finally {
      app.close();
    }
  });

  test("a challenge is single-use, and an unregistered credential is refused", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const body = await signUpConfirmed(app);
      const { auth } = await registerPasskey(app, body.token);

      const { options, cookie } = await authenticationOptions(app);
      const response = await authenticationResponse(options, auth);
      const first = await app.fetch(
        request("/api/auth/passkey/verify-authentication", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
          body: JSON.stringify({ response }),
        }),
      );
      expect(first.status).toBe(200);
      const replay = await app.fetch(
        request("/api/auth/passkey/verify-authentication", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
          body: JSON.stringify({ response }),
        }),
      );
      expect(replay.status).toBe(400);

      const stranger = await newAuthenticator();
      const { options: next, cookie: nextCookie } = await authenticationOptions(app);
      const refused = await app.fetch(
        request("/api/auth/passkey/verify-authentication", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: nextCookie },
          body: JSON.stringify({ response: await authenticationResponse(next, stranger) }),
        }),
      );
      expect(refused.status).toBe(401);
    } finally {
      app.close();
    }
  });

  test("the challenge cookie survives only a same-origin passkey ceremony", async () => {
    const app = await createApp({ dbPath: ":memory:", host: "chat.local" });
    try {
      const body = await signUpConfirmed(app);
      const same = await app.fetch(
        request("/api/auth/passkey/generate-register-options", {
          headers: { Authorization: `Bearer ${body.token}`, Origin: ORIGIN },
        }),
      );
      expect(cookieFrom(same)).toContain("better-auth-passkey");

      // A client served by another origin still reaches the API (ADR 0020), but it gets no
      // cookie at all: this server never hands ambient authority to a foreign origin.
      const foreign = await app.fetch(
        request("/api/auth/passkey/generate-register-options", {
          headers: { Authorization: `Bearer ${body.token}`, Origin: "http://app.example" },
        }),
      );
      expect(foreign.status).toBe(200);
      expect(cookieFrom(foreign)).toBe("");
    } finally {
      app.close();
    }
  });

  test("a TLS proxy keeps the challenge cookie when Origin matches baseURL, not the listener", async () => {
    // The listener is plain http behind a proxy; the browser sees the configured origin.
    const app = await createApp({ dbPath: ":memory:", host: "chat.local", baseURL: "https://chat.example" });
    try {
      const body = await signUpConfirmed(app);
      const res = await app.fetch(
        request("/api/auth/passkey/generate-register-options", {
          headers: { Authorization: `Bearer ${body.token}`, Origin: "https://chat.example" },
        }),
      );
      expect(res.status).toBe(200);
      expect(cookieFrom(res)).toContain("better-auth-passkey");
    } finally {
      app.close();
    }
  });
});
