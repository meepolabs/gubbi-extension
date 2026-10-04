import { logger } from "../logger";
import { getAuthBlob, getRefreshState, setAuthBlob, clearRefreshState } from "../storage";

// Startup recovery: the ambiguous-refresh detector. Call ONCE at service-worker
// startup, before any refresh can run.
//
// Background-only.
//
// MV3 service workers are killed aggressively. A refresh can be interrupted
// after refreshState was written but before the new authBlob was persisted -- at
// which point the refresh token may ALREADY have been rotated server-side. We
// cannot tell from the client whether the server consumed it. Replaying it would
// trip Hydra's reuse detection and revoke the whole chain. So the only safe move
// in the ambiguous case is to force reconnect; we NEVER replay.
//
// Truth table (refreshState present):
//   authBlob.version === refreshState.authVersionBefore -> AMBIGUOUS.
//       The local persist never happened; the token may have rotated. Force
//       reconnect_required, clear refreshState, make NO token-endpoint call.
//   authBlob.version  >  refreshState.authVersionBefore -> SAFE.
//       The refresh actually succeeded (new blob persisted) but the marker was
//       not cleared (crash after persist, before clear). The current token is
//       good; just clear refreshState.
//   refreshState absent -> no-op.
export async function runStartupRecovery(): Promise<void> {
  const refreshState = await getRefreshState();
  if (!refreshState) return;

  const blob = await getAuthBlob();

  // No blob at all: nothing to recover into; just drop the orphaned marker.
  if (!blob) {
    await clearRefreshState();
    logger.warn("startup recovery: orphaned refreshState cleared (no authBlob)", {});
    return;
  }

  if (blob.version > refreshState.authVersionBefore) {
    // SAFE: the new token was persisted; only the marker leaked.
    await clearRefreshState();
    logger.info("startup recovery: refresh completed, marker cleared", {});
    return;
  }

  // AMBIGUOUS: version unchanged. The refresh token may have been spent
  // server-side without us persisting the rotation. Force reconnect; never
  // replay the (possibly already-rotated) refresh token.
  await setAuthBlob({
    ...blob,
    status: "reconnect_required",
    updatedAt: new Date().toISOString(),
  });
  await clearRefreshState();
  logger.warn("startup recovery: ambiguous refresh, reconnect required", {});
}
