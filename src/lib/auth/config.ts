// Shared auth configuration. All values are PUBLIC client config: the OAuth
// client is a public (no-secret) PKCE client, and the host comes from the same
// build-time VITE_ var the egress allowlist reads. Defaults mirror .env.example.
//
// Background-only.

const DEFAULT_AUTH_HOST = "auth.gubbi.ai";
const DEFAULT_CLIENT_ID = "journal-extension";

// Accepts a bare host ("auth.gubbi.ai") or a full URL; returns the origin.
function authOrigin(): string {
  const configured = import.meta.env.VITE_AUTH_HOST;
  if (!configured) return `https://${DEFAULT_AUTH_HOST}`;
  try {
    return new URL(configured).origin;
  } catch {
    return `https://${configured}`;
  }
}

export const AUTH_ORIGIN = authOrigin();
export const HYDRA_CLIENT_ID = import.meta.env.VITE_HYDRA_CLIENT_ID ?? DEFAULT_CLIENT_ID;

export const AUTHORIZE_PATH = "/oauth2/auth";
export const TOKEN_PATH = "/oauth2/token";

// journal-web requests the same set; offline_access yields the refresh token
// the refresh flow depends on.
export const OAUTH_SCOPE = "journal offline_access";
