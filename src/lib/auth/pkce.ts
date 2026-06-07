// PKCE (RFC 7636) S256 helpers. Pure and dependency-free: usable in the MV3
// service worker and the Firefox event page, both of which expose Web Crypto
// (crypto.subtle, crypto.getRandomValues) on the global scope.
//
// Background-only by virtue of where it is imported -- nothing here is
// content-script-safe to expose, but it carries no third-party runtime code.

// RFC 7636 bounds the code verifier to 43..128 characters of the unreserved
// set. We emit base64url (a strict subset of that set), so length is the only
// constraint to honor. 32 random bytes -> 43 base64url chars (no padding).
export const VERIFIER_MIN_LEN = 43;
export const VERIFIER_MAX_LEN = 128;

const VERIFIER_BYTES = 32;

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

// base64url without padding, per RFC 7636 (and RFC 4648 section 5).
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// challenge = BASE64URL(SHA256(ASCII(verifier))).
export async function challengeFromVerifier(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

// Generate a fresh verifier (cryptographically random) and its S256 challenge.
export async function generatePkce(): Promise<PkcePair> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES));
  const codeVerifier = base64UrlEncode(randomBytes);
  const codeChallenge = await challengeFromVerifier(codeVerifier);
  return { codeVerifier, codeChallenge };
}

// Cryptographically random opaque value for the OAuth `state` CSRF parameter.
export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES)));
}
