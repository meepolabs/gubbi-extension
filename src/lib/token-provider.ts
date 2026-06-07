// The capabilities the upload client + orchestrator need from auth: a fresh,
// valid access token. This interface lives OUTSIDE src/lib/auth/ on purpose --
// the upload client (src/lib/api.ts) depends on this contract, not on the auth
// module, so the auth -> upload dependency stays inverted (the orchestrator
// wires a concrete provider in). The concrete implementation is in
// src/lib/auth/provider.ts.
export interface TokenProvider {
  // Resolves a usable Hydra access token, refreshing transparently when the
  // cached token is near expiry. Rejects (does not return a stale token) when
  // the session can no longer be refreshed and re-pairing is required.
  getAccessToken(): Promise<string>;

  // Forces a refresh regardless of the cached token's remaining lifetime, then
  // resolves the new access token. The orchestrator calls this after a server
  // 401 (the token was rejected even though it was not near expiry -- e.g.
  // server-side revocation or clock skew) before retrying a batch once.
  // Serializes on the same auth lock as getAccessToken. Rejects when the
  // session can no longer be refreshed and re-pairing is required.
  forceRefresh(): Promise<string>;
}
