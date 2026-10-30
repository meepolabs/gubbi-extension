// Shared auth configuration. All values are PUBLIC client config: the OAuth
// client is a public (no-secret) PKCE client, and the host comes from the same
// build-time VITE_ var the egress allowlist reads. Defaults mirror .env.example.
//
// Background-only.

import { DEFAULT_AUTH_HOST, originOf, resolveEndpointHost } from "../net/endpoint-host.mjs";

const DEFAULT_CLIENT_ID = "journal-extension";

// Undefined when VITE_AUTH_HOST is set to an invalid value: every auth request
// then fails closed instead of reaching the prod issuer.
export const AUTH_ORIGIN = originOf(
  resolveEndpointHost(import.meta.env.VITE_AUTH_HOST, DEFAULT_AUTH_HOST),
);
export const HYDRA_CLIENT_ID = import.meta.env.VITE_HYDRA_CLIENT_ID ?? DEFAULT_CLIENT_ID;

export const AUTHORIZE_PATH = "/oauth2/auth";
export const TOKEN_PATH = "/oauth2/token";

// journal-web requests the same set; offline_access yields the refresh token
// the refresh flow depends on.
export const OAUTH_SCOPE = "journal offline_access";
