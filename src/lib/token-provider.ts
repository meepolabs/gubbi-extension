// The capabilities the upload client + orchestrator need from auth: a fresh,
// valid access token. This interface lives OUTSIDE src/lib/auth/ on purpose --
// the upload client (src/lib/api.ts) depends on this contract, not on the auth
// module, so the auth -> upload dependency stays inverted (the orchestrator
// wires a concrete provider in). The concrete implementation is in
// src/lib/auth/provider.ts.
export interface TokenProvider {
  // Resolves a usable Hydra access token, refreshing transparently when the
  // cached token is near expiry. Never returns a stale token: rejects with
  // ReconnectRequiredError when re-pairing is required, and with any other
  // error when a token could not be produced right now (e.g. lock contention).
  getAccessToken(): Promise<string>;

  // Forces a refresh regardless of the cached token's remaining lifetime, then
  // resolves the new access token. The orchestrator calls this after a server
  // 401 (the token was rejected even though it was not near expiry -- e.g.
  // server-side revocation or clock skew) before retrying a batch once.
  // Serializes on the same auth lock as getAccessToken. Rejects the same way.
  forceRefresh(): Promise<string>;
}

// The one definitive rejection: the session can no longer be refreshed and the
// user must re-pair. Providers reject with this rather than ever returning a
// stale token: a stale token would be rejected by the API and, worse, replaying
// an already-rotated refresh token trips Hydra's reuse detection and revokes the
// whole chain. Refresh fails closed on any post-send ambiguity, so there is
// deliberately no "transient, retry the old token later" variant. Any other
// rejection is not a reconnect signal.
export class ReconnectRequiredError extends Error {
  constructor(message = "session can no longer be refreshed; re-pairing required") {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}
