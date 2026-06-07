import { logger } from "../logger";
import { guardedFetch } from "../net/fetch";
import { HTTP_SERVER_ERROR_FLOOR, HTTP_UNAUTHORIZED } from "../net/http-constants";
import {
  getAuthBlob,
  setAuthBlob,
  setRefreshState,
  clearRefreshState,
  type AuthBlob,
} from "../storage";
import { AUTH_ORIGIN, HYDRA_CLIENT_ID, TOKEN_PATH } from "./config";
import { ReconnectRequiredError } from "./errors";
import { tokenFromBody, type ParsedToken } from "./token-body";

// Rotation-safe refresh primitive.
//
// LOCK-ORDERING INVARIANT: this module acquires ONLY the auth lock. It must
// NEVER acquire the sync lease while holding the auth lock. The orchestrator may
// hold the sync lease and then call into here (lease -> auth lock), which is
// fine; the reverse (auth lock -> lease) is forbidden and would deadlock.
//
// ROTATION SAFETY (the crux of this module). Hydra is configured with ROTATING
// refresh tokens and reuse detection: if an already-rotated (old) refresh token
// is ever replayed, Hydra revokes the ENTIRE token chain and the user is
// silently logged out. The ordering below makes a replay impossible:
//
//   1. Read authBlob, capture versionBefore.
//   2. Persist refreshState{authVersionBefore: versionBefore} BEFORE the POST.
//      This is the "I am about to spend this refresh token" marker; if the
//      worker dies after the server rotates but before we persist the new blob,
//      runStartupRecovery (startup.ts) sees refreshState present with an
//      unchanged version and forces reconnect rather than ever replaying.
//   3. POST grant_type=refresh_token.
//   4. On success, persist the NEW authBlob (version+1, rotated refresh token)
//      BEFORE clearing refreshState and BEFORE releasing the lock. So the new
//      token is durable before the marker is gone.
//   5. THEN clear refreshState. THEN the lock releases (fn returns).
//
// The token endpoint is called AT MOST ONCE per acquired lock, and an old
// refresh token is NEVER retried after a failure.
//
// FAIL-CLOSED ON POST-SEND AMBIGUITY (the safety decision). Once the refresh
// token has been SENT to /oauth2/token, the server MAY already have rotated it,
// even if our side never saw a clean success: a dropped connection, a 5xx, or a
// truncated/unparseable body all leave us unable to tell whether the token was
// consumed. Reusing the old token in that state would later trip Hydra's reuse
// detection and revoke the whole chain. So refresh has exactly TWO terminal
// outcomes: a clean rotated success, or reconnect_required. There is no
// "transient, keep the old token, retry later" arm -- ANY non-success, non-clean
// outcome after the token was sent forces reconnect. The only PRE-send failure
// (no blob / already reconnect_required) also resolves to reconnect, so the old
// token is never re-sent under any path.

// chrome.storage has no atomic CAS; a held lock is taken over only if its
// heartbeat is older than this TTL. A refresh round trip is a single network
// call, so a generous-but-bounded window keeps a healthy refresh from being
// stolen while still freeing a truly dead worker's lock.
export const REFRESH_LOCK_TTL_MS = 120_000;

function nextAuthBlob(token: ParsedToken, versionBefore: number): AuthBlob {
  const now = Date.now();
  return {
    version: versionBefore + 1,
    accessToken: token.accessToken,
    accessTokenExpiresAt: new Date(now + token.expiresInSeconds * 1000).toISOString(),
    refreshToken: token.refreshToken,
    status: "ok",
    updatedAt: new Date(now).toISOString(),
  };
}

// Mark the session unrecoverable: status='reconnect_required' so the popup can
// surface it, and clear refreshState so a later startup recovery does not also
// fire. The refresh token is intentionally left untouched and NEVER retried.
async function markReconnectRequired(blob: AuthBlob): Promise<void> {
  await setAuthBlob({ ...blob, status: "reconnect_required", updatedAt: new Date().toISOString() });
  await clearRefreshState();
}

// The token endpoint has exactly two outcomes. `ok` is a clean parsed success.
// `reconnect` is EVERYTHING ELSE after the token was sent -- a definitive dead
// grant (401 / non-401 4xx) AND every ambiguous post-send failure (network
// throw, 5xx, truncated or unparseable body). The old token must never be reused
// in any reconnect case, so the two are folded into one terminal outcome here.
type TokenEndpointOutcome =
  | { readonly kind: "ok"; readonly token: ParsedToken }
  | { readonly kind: "reconnect" };

async function callTokenEndpoint(refreshToken: string): Promise<TokenEndpointOutcome> {
  const url = new URL(TOKEN_PATH, AUTH_ORIGIN).toString();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: HYDRA_CLIENT_ID,
  });

  let response: Response;
  try {
    response = await guardedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    // Post-send network throw / redirect rejection / disallowed host: AMBIGUOUS.
    // The server may already have rotated the token, so fail closed.
    return { kind: "reconnect" };
  }

  if (!response.ok) {
    // 401 means a definitively dead grant; a 5xx is ambiguous; any other non-2xx
    // (4xx) means the server rejected the grant. All three forbid reusing the old
    // token, so all three resolve to reconnect.
    if (response.status === HTTP_UNAUTHORIZED) return { kind: "reconnect" };
    if (response.status >= HTTP_SERVER_ERROR_FLOOR) return { kind: "reconnect" };
    return { kind: "reconnect" };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // A 2xx with an unparseable body is ambiguous (the server likely rotated):
    // fail closed rather than reuse the old token.
    return { kind: "reconnect" };
  }
  const token = tokenFromBody(parsed);
  if (!token) return { kind: "reconnect" };
  return { kind: "ok", token };
}

// The rotation-safe refresh body. MUST be invoked inside withStorageLock(authLock)
// -- it receives the lock ownerId. Returns the new access token, or rejects with
// ReconnectRequiredError when the grant is dead (caller must NOT retry that case).
//
// Steps 1-5 above run here in order. The new blob persists before refreshState is
// cleared, and both persist before this function returns (which releases the lock).
export async function refreshWithinLock(ownerId: string): Promise<string> {
  const blob = await getAuthBlob();
  if (!blob || blob.status === "reconnect_required") {
    throw new ReconnectRequiredError();
  }

  const versionBefore = blob.version;

  // Marker BEFORE the POST -- "about to spend this refresh token".
  await setRefreshState({
    ownerId,
    authVersionBefore: versionBefore,
    startedAt: new Date().toISOString(),
  });

  const outcome = await callTokenEndpoint(blob.refreshToken);

  if (outcome.kind === "reconnect") {
    // Dead grant OR post-send ambiguity: in either case the old refresh token
    // must NEVER be reused. Mark reconnect_required and stop.
    await markReconnectRequired(blob);
    logger.warn("token refresh failed; reconnect required", {});
    throw new ReconnectRequiredError();
  }

  // Success: persist the new blob (rotated refresh token, version+1) BEFORE
  // clearing the marker and BEFORE the lock releases.
  await setAuthBlob(nextAuthBlob(outcome.token, versionBefore));
  await clearRefreshState();
  logger.info("token refreshed", {});
  return outcome.token.accessToken;
}
