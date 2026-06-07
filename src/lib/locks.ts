import { logger } from "./logger";

// Generic storage-backed mutex over chrome.storage.local. Background-only:
// content scripts MUST NOT import this module (it has no business with the
// shared lock keys and the eslint content-bundle rule keeps it out).
//
// chrome.storage.local exposes NO atomic compare-and-set, so acquisition uses
// a write-then-read-back protocol: an acquirer writes its own randomly-chosen
// ownerId, then re-reads the key. The read-back is the arbiter -- whichever
// write landed last in the underlying store is the one every racer observes,
// so AT MOST ONE acquirer sees its own ownerId on read-back.
//
// CONTENTION CONTRACT: an acquirer whose read-back shows a DIFFERENT live owner
// does NOT retry and does NOT block; it rejects immediately with
// LockContendedError. Callers that want to wait for the holder to finish use
// waitForLockReleased (event-driven, never polling) and then re-attempt. This
// keeps withStorageLock itself a single, predictable attempt with no hidden
// spin, and pushes the wait/retry policy to the caller where it belongs.
//
// A held lock is taken over only when STALE: its heartbeatAt is older than the
// caller-supplied ttlMs. While fn runs the holder refreshes heartbeatAt on a
// fixed interval so a healthy holder is never taken over. Release clears the
// key only when the stored ownerId still matches -- a holder that was already
// taken over (because it stalled past ttlMs) must not clobber the new owner.

const HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

// Shape persisted under the lock key. Kept as a plain typed record (not a zod
// schema): the values are written and read only by this module, never by an
// older extension version, so the cross-version staleness concern that drives
// storage.ts's schema validation does not apply here.
interface LockRecord {
  readonly ownerId: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

// Injection seam so tests drive time and timers without real waits. Defaults
// bind to the real clock and the ambient (background) timer functions.
export interface LockDeps {
  readonly now: () => number;
  readonly setInterval: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  readonly setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const realDeps: LockDeps = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

// Raised when the lock is already held by a live owner. Callers may catch it,
// optionally waitForLockReleased, and retry.
export class LockContendedError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`storage lock "${key}" is held by another owner`);
    this.name = "LockContendedError";
    this.key = key;
  }
}

function isLockRecord(raw: unknown): raw is LockRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as Record<string, unknown>;
  return (
    typeof candidate.ownerId === "string" &&
    typeof candidate.acquiredAt === "number" &&
    typeof candidate.heartbeatAt === "number"
  );
}

async function readLock(key: string): Promise<LockRecord | undefined> {
  const record = await chrome.storage.local.get(key);
  const raw = record[key];
  return isLockRecord(raw) ? raw : undefined;
}

// A held lock is contended only while its last heartbeat is within ttlMs;
// beyond that it is stale and takeover-able.
function isLive(current: LockRecord, nowMs: number, ttlMs: number): boolean {
  return nowMs - current.heartbeatAt < ttlMs;
}

// Single acquisition attempt. Resolves with our LockRecord on success; throws
// LockContendedError when a live owner already holds the key. Stale or absent
// locks are overwritten with a fresh ownerId.
async function tryAcquire(key: string, ttlMs: number, deps: LockDeps): Promise<LockRecord> {
  const existing = await readLock(key);
  const nowMs = deps.now();
  if (existing !== undefined && isLive(existing, nowMs, ttlMs)) {
    throw new LockContendedError(key);
  }

  const ownerId = crypto.randomUUID();
  const mine: LockRecord = { ownerId, acquiredAt: nowMs, heartbeatAt: nowMs };
  await chrome.storage.local.set({ [key]: mine });

  // Read-back arbitration: the last write to land wins, and only one racer sees
  // its own ownerId. A different owner here means a concurrent acquirer beat us.
  const readBack = await readLock(key);
  if (readBack === undefined || readBack.ownerId !== ownerId) {
    throw new LockContendedError(key);
  }
  return mine;
}

// Clear the key only if we still hold it. A no-op when another owner has taken
// over (stale takeover), so we never clobber their lock.
async function releaseIfOwner(key: string, ownerId: string): Promise<void> {
  const current = await readLock(key);
  if (current?.ownerId === ownerId) {
    await chrome.storage.local.remove(key);
  }
}

// Refresh heartbeatAt only while we still own the key. If a takeover already
// happened the refresh is dropped rather than reviving our claim.
async function heartbeat(key: string, ownerId: string, nowMs: number): Promise<void> {
  const current = await readLock(key);
  if (current?.ownerId !== ownerId) return;
  const refreshed: LockRecord = { ...current, heartbeatAt: nowMs };
  await chrome.storage.local.set({ [key]: refreshed });
}

// Acquire the lock, run fn, then release. fn receives our ownerId. While fn
// runs we refresh the heartbeat every HEARTBEAT_INTERVAL_MS so a healthy holder
// is never taken over. The lock is released whether fn resolves or rejects, and
// fn's rejection is re-thrown to the caller after release.
export async function withStorageLock<T>(
  key: string,
  ttlMs: number,
  fn: (ownerId: string) => Promise<T>,
  deps: LockDeps = realDeps,
): Promise<T> {
  const mine = await tryAcquire(key, ttlMs, deps);
  const { ownerId } = mine;

  const heartbeatHandle = deps.setInterval(() => {
    void heartbeat(key, ownerId, deps.now()).catch((error: unknown) => {
      logger.warn("lock heartbeat failed", { key, error: String(error) });
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    return await fn(ownerId);
  } finally {
    deps.clearInterval(heartbeatHandle);
    await releaseIfOwner(key, ownerId);
  }
}

// Resolve once the key is observed cleared via chrome.storage.onChanged; reject
// with LockContendedError after timeoutMs. Event-driven -- never polls. Resolves
// immediately if the key is already absent at call time.
export function waitForLockReleased(
  key: string,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  deps: LockDeps = realDeps,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "local") return;
      const change = changes[key];
      // newValue absent (key removed) signals release.
      if (change !== undefined && change.newValue === undefined) {
        finish(resolve);
      }
    };

    const cleanup = (): void => {
      chrome.storage.onChanged.removeListener(listener);
      if (timeoutHandle !== undefined) deps.clearTimeout(timeoutHandle);
    };

    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      done();
    };

    chrome.storage.onChanged.addListener(listener);
    const timeoutHandle = deps.setTimeout(() => {
      finish(() => reject(new LockContendedError(key)));
    }, timeoutMs);

    // Resolve right away if nobody holds the lock; the listener covers the
    // race where release lands between this read and the listener attaching.
    void readLock(key).then((current) => {
      if (current === undefined) finish(resolve);
    });
  });
}
