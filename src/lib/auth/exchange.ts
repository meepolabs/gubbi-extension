import { guardedFetch } from "../net/fetch";
import { HTTP_SERVER_ERROR_FLOOR } from "../net/http-constants";
import { AUTH_ORIGIN, HYDRA_CLIENT_ID, TOKEN_PATH } from "./config";
import { tokenFromBody, type ParsedToken } from "./token-body";

// Authorization-code token exchange. POSTs to /oauth2/token through the egress
// guard (guardedFetch is the only sanctioned outbound path) as
// application/x-www-form-urlencoded, then parses the token response.
//
// Background-only.

export type TokenResponse = ParsedToken;

// Discriminated outcome so the orchestrator can map failures to typed reasons
// without parsing error strings. `exchange_failed` is a 4xx (the grant was
// rejected); `network` is a 5xx, transport failure, or unusable response body.
export type ExchangeResult =
  | { readonly ok: true; readonly token: TokenResponse }
  | { readonly ok: false; readonly reason: "exchange_failed" | "network" };

export interface ExchangeParams {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export async function exchangeCode(params: ExchangeParams): Promise<ExchangeResult> {
  const url = new URL(TOKEN_PATH, AUTH_ORIGIN).toString();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: HYDRA_CLIENT_ID,
    code_verifier: params.codeVerifier,
  });

  let response: Response;
  try {
    response = await guardedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    // Transport failure, redirect rejection, or disallowed host.
    return { ok: false, reason: "network" };
  }

  if (!response.ok) {
    const reason = response.status >= HTTP_SERVER_ERROR_FLOOR ? "network" : "exchange_failed";
    return { ok: false, reason };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "network" };
  }

  const token = tokenFromBody(parsed);
  if (!token) return { ok: false, reason: "exchange_failed" };
  return { ok: true, token };
}
