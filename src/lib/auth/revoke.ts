import { clearAccountState } from "../account-state";
import { LockContendedError, waitForLockReleased, withStorageLock } from "../locks";
import { logger } from "../logger";
import { guardedFetch } from "../net/fetch";
import { getAuthBlob, AUTH_LOCK_KEY, SYNC_LEASE_KEY } from "../storage";
import { AUTH_ORIGIN, HYDRA_CLIENT_ID } from "./config";
import { REFRESH_LOCK_TTL_MS } from "./refresh";

// Unpair: tear down the local session and best-effort revoke the token server
// side.
//
// LOCK ORDER: sync lease, then auth lock (see refresh.ts header). Holding the
// lease keeps a sync run from writing cursors or counters back after the sweep;
// holding the auth lock keeps a refresh from rotating the token mid-unpair.
//
// Background-only.

const REVOKE_PATH = "/oauth2/revoke";

// Must match the orchestrator's lease TTL: a shorter value would judge a live
// sync run stale and take its lease over.
const SYNC_LEASE_TTL_MS = 5 * 60 * 1000;

const LOCK_WAIT_TIMEOUT_MS = 30_000;

export type UnpairResult = { readonly ok: true } | { readonly ok: false; readonly reason: "busy" };

const BUSY: UnpairResult = { ok: false, reason: "busy" };

// Hydra revokes the whole consent chain on a refresh-token revoke. Any failure
// is tolerated: the local teardown is what logs the user out, and a stranded
// server-side token expires on its own. The response body is never logged; it
// may echo the token.
async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const body = new URLSearchParams({
    token: refreshToken,
    token_type_hint: "refresh_token",
    client_id: HYDRA_CLIENT_ID,
  });
  try {
    const url = new URL(REVOKE_PATH, AUTH_ORIGIN).toString();
    const response = await guardedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      logger.warn("token revoke rejected (ignored)", { status: response.status });
    }
  } catch (error) {
    logger.warn("token revoke request failed (ignored)", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// Run fn under the lock; on contention wait (bounded) for the holder to release
// and try once more. Still contended -> busy, fn never ran.
async function withLockOrBusy(
  key: string,
  ttlMs: number,
  fn: () => Promise<UnpairResult>,
): Promise<UnpairResult> {
  try {
    return await withStorageLock(key, ttlMs, fn);
  } catch (error) {
    if (!(error instanceof LockContendedError)) throw error;
  }
  try {
    await waitForLockReleased(key, LOCK_WAIT_TIMEOUT_MS);
    return await withStorageLock(key, ttlMs, fn);
  } catch (error) {
    if (!(error instanceof LockContendedError)) throw error;
    logger.info("unpair skipped; lock busy", { key });
    return BUSY;
  }
}

async function revokeAndClear(): Promise<UnpairResult> {
  const blob = await getAuthBlob();
  if (blob) await revokeRefreshToken(blob.refreshToken);
  await clearAccountState();
  logger.info("unpaired", {});
  return { ok: true };
}

// Disconnect the extension: revoke the refresh token (best effort) then clear
// the credentials and all account-scoped sync state. Local state is cleared
// even when the revoke fails; nothing is cleared when either lock stays busy.
export function unpair(): Promise<UnpairResult> {
  return withLockOrBusy(SYNC_LEASE_KEY, SYNC_LEASE_TTL_MS, () =>
    withLockOrBusy(AUTH_LOCK_KEY, REFRESH_LOCK_TTL_MS, revokeAndClear),
  );
}
