import { AUTH_ORIGIN, AUTHORIZE_PATH, HYDRA_CLIENT_ID, OAUTH_SCOPE } from "./config";

// Builds the /oauth2/auth URL for the authorization-code + PKCE flow. Pure:
// every dynamic value (redirect_uri, state, code_challenge) is passed in so the
// function is fully testable without chrome.identity or Web Crypto.
//
// Background-only.

export interface AuthorizeUrlParams {
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL(AUTHORIZE_PATH, AUTH_ORIGIN);
  const search = new URLSearchParams({
    response_type: "code",
    client_id: HYDRA_CLIENT_ID,
    redirect_uri: params.redirectUri,
    scope: OAUTH_SCOPE,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
  url.search = search.toString();
  return url.toString();
}
