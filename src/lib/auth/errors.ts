// Typed auth error so callers branch on instanceof rather than parsing strings.
//
// Background-only.

// Raised when the session can no longer be refreshed and the user must re-pair.
// getAccessToken / forceRefresh reject with this rather than ever returning a
// stale token: a stale token would be rejected by the API and, worse, replaying
// an already-rotated refresh token trips Hydra's reuse detection and revokes the
// whole chain. Because refresh fails closed on any post-send ambiguity (see
// refresh.ts), this is the ONLY terminal failure a refresh can surface -- there
// is deliberately no "transient, retry the old token later" error. The popup
// maps this to a "reconnect" prompt.
export class ReconnectRequiredError extends Error {
  constructor(message = "session can no longer be refreshed; re-pairing required") {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}
