# 0014. Client library choices within the 150 KB shell budget

Status: accepted (2026-10-14)

## Context
The web and Tauri client shell must stay at or below `150 KB` compressed (`docs/PROTOCOL.md`) so
first load and updates are fast on slow links. Standard SDKs (such as `better-auth/client` or eager
WebAuthn bundles) would consume a large fraction of that budget.

## Decision
- `@levischuck/tiny-cbor` (0.3.6) for CBOR encoding and decoding, wrapped behind
  `packages/protocol/src/cbor.ts` (ADR 0003). It has zero dependencies and is a few kilobytes
  minified.
- `thumbhash` for decoding ~21-25 byte inline image placeholders into blurred data URLs (and
  encoding them during upload, ADR 0011). It is ~1 KB with zero dependencies.
- Plain `fetch` for auth: the client calls BetterAuth endpoints (`/api/auth/*`) directly with
  `fetch` and `Authorization: Bearer <token>` (ADR 0007) instead of bundling `better-auth/client`.
- Lazy `@simplewebauthn/browser`: loaded via dynamic `import()` only when the user opens the passkey
  registration or passkey sign-in screen, keeping it out of the initial app shell bundle.

## Consequences
- The initial app shell stays well inside the `150 KB` compressed budget while supporting CBOR
  `/sync`, ThumbHash placeholders, bearer auth, and optional passkeys.
- Wrapping `tiny-cbor` in `packages/protocol/src/cbor.ts` and calling auth via plain `fetch` keeps
  third-party surface area minimal and easy to audit.
