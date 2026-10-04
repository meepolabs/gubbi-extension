import { LockContendedError, waitForLockReleased, withStorageLock } from "../locks";
import { getAuthBlob, AUTH_LOCK_KEY, type AuthBlob } from "../storage";
import { ReconnectRequiredError } from "./errors";
import { refreshWithinLock, REFRESH_LOCK_TTL_MS } from "./refresh";

// Concrete TokenProvider (see src/lib/token-provider.ts for the contract).
//
// LOCK-ORDERING INVARIANT: acquires ONLY the auth lock. Never acquires the sync
// lease while holding it (see refresh.ts header).
//
// Background-only: depends on storage (zod) and locks, neither content-safe.

// A token with at least this much life left is returned from cache without a
// network round trip. The margin absorbs clock skew and the latency of an
// in-flight upload batch that grabbed the token just before it expired.
const FRESH_MARGIN_MS = 2 * 60 * 1000;

// How long waitForLockReleased blocks for the in-flight refresh to finish before
// giving up and re-attempting the acquisition itself.
const LOCK_WAIT_TIMEOUT_MS = 30_000;

function isReconnectRequired(
  blob: AuthBlob | undefined,
): blob is undefined | (AuthBlob & { status: "reconnect_required" }) {
  return blob === undefined || blob.status === "reconnect_required";
}

function msUntilExpiry(blob: AuthBlob): number {
  return Date.parse(blob.accessTokenExpiresAt) - Date.now();
}

// A cached token is usable when present, ok, and not within the fresh margin of
// expiry. Used both for the fast path and for the post-wait re-read.
function usableCachedToken(blob: AuthBlob | undefined): string | undefined {
  if (isReconnectRequired(blob)) return undefined;
  if (msUntilExpiry(blob) <= FRESH_MARGIN_MS) return undefined;
  return blob.accessToken;
}

// Acquire the auth lock and run the rotation-safe refresh. On contention (another
// context is already refreshing), wait for it to release, then re-read: if it
// rotated a fresh token, use that without ever calling the token endpoint again
// (replaying would risk the chain); otherwise re-attempt the refresh once.
async function refreshSerialized(): Promise<string> {
  try {
    return await withStorageLock(AUTH_LOCK_KEY, REFRESH_LOCK_TTL_MS, (ownerId) =>
      refreshWithinLock(ownerId),
    );
  } catch (error) {
    if (!(error instanceof LockContendedError)) throw error;

    // Another context holds the lock and is refreshing. Wait for it to finish.
    await waitForLockReleased(AUTH_LOCK_KEY, LOCK_WAIT_TIMEOUT_MS);

    const afterWait = await getAuthBlob();
    if (isReconnectRequired(afterWait)) throw new ReconnectRequiredError();
    const fresh = usableCachedToken(afterWait);
    if (fresh !== undefined) return fresh;

    // The holder released without leaving a usable token (e.g. it refreshed but
    // the new token is still near-expiry, or it cleared the lock without
    // rotating). Re-attempt the refresh ourselves, once.
    return await withStorageLock(AUTH_LOCK_KEY, REFRESH_LOCK_TTL_MS, (ownerId) =>
      refreshWithinLock(ownerId),
    );
  }
}

// Resolve a usable access token, refreshing only when the cached one is within
// the fresh margin. Fast path takes no lock and makes no network call.
async function getAccessToken(): Promise<string> {
  const blob = await getAuthBlob();
  if (isReconnectRequired(blob)) throw new ReconnectRequiredError();

  const cached = usableCachedToken(blob);
  if (cached !== undefined) return cached;

  return refreshSerialized();
}

// Force a refresh regardless of remaining lifetime (orchestrator calls this after
// a server 401). Same lock + contention handling as getAccessToken's slow path.
async function forceRefresh(): Promise<string> {
  const blob = await getAuthBlob();
  if (isReconnectRequired(blob)) throw new ReconnectRequiredError();
  return refreshSerialized();
}

// A frozen TokenProvider the orchestrator wires into the upload client.
export const tokenProvider = Object.freeze({ getAccessToken, forceRefresh });

export { getAccessToken, forceRefresh };
