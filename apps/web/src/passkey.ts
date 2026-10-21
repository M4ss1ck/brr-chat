// The browser half of passkeys (#19). It is its own bundle (`/passkey.js`) because
// @simplewebauthn/browser is only needed by a person who adds or uses a passkey; a password
// user never downloads it (ADR 0014). The app shell imports this file with a computed URL,
// so esbuild cannot inline it, and the service worker caches it after the first ceremony.
import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/** Runs the platform's "create a passkey" prompt. Throws if the person cancels. */
export function createCredential(options: unknown): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
}

/** Runs the platform's "use a passkey" prompt, including the account picker. */
export function getCredential(options: unknown): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON });
}
