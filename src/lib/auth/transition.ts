import { LockContendedError, waitForLockReleased, withStorageLock } from "../locks";
import { logger } from "../logger";
import { AUTH_LOCK_KEY, SYNC_LEASE_KEY } from "../storage";
import { REFRESH_LOCK_TTL_MS } from "./refresh";

// Account transitions (pair, unpair, startup recovery) change which credentials
// and sync state the extension holds. They run under the same locks as sync and
// refresh so none of those can write the previous account's state back.
//
// LOCK ORDER: sync lease, then auth lock (see refresh.ts header).
//
// Background-only.

// Must match the orchestrator's lease TTL: a shorter value would judge a live
// sync run stale and take its lease over.
const SYNC_LEASE_TTL_MS = 5 * 60 * 1000;

const LOCK_WAIT_TIMEOUT_MS = 30_000;

export type LockedOutcome<T> =
  | { readonly kind: "ran"; readonly value: T }
  | { readonly kind: "busy" };

const BUSY = { kind: "busy" } as const;

// Run fn under the lock; on contention wait (bounded) for the holder to release
// and try once more. Still contended -> busy, fn never ran. Contention is told
// apart from a LockContendedError thrown by fn itself, which propagates.
async function withLockOrBusy<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<LockedOutcome<T>> {
  let entered = false;
  const run = async (): Promise<LockedOutcome<T>> => {
    entered = true;
    return { kind: "ran", value: await fn() };
  };
  try {
    return await withStorageLock(key, ttlMs, run);
  } catch (error) {
    if (entered || !(error instanceof LockContendedError)) throw error;
  }
  try {
    await waitForLockReleased(key, LOCK_WAIT_TIMEOUT_MS);
    return await withStorageLock(key, ttlMs, run);
  } catch (error) {
    if (entered || !(error instanceof LockContendedError)) throw error;
    logger.info("account transition skipped; lock busy", { key });
    return BUSY;
  }
}

// Run fn holding the auth lock alone, for transitions that touch credentials
// but no sync state.
export function withAuthLockOrBusy<T>(fn: () => Promise<T>): Promise<LockedOutcome<T>> {
  return withLockOrBusy(AUTH_LOCK_KEY, REFRESH_LOCK_TTL_MS, fn);
}

// Run fn holding the sync lease and then the auth lock.
export async function withAccountLocksOrBusy<T>(fn: () => Promise<T>): Promise<LockedOutcome<T>> {
  const outcome = await withLockOrBusy(SYNC_LEASE_KEY, SYNC_LEASE_TTL_MS, () =>
    withAuthLockOrBusy(fn),
  );
  return outcome.kind === "ran" ? outcome.value : BUSY;
}
