import { PlatformSchema } from "./schema/ingest";
import {
  ACCOUNT_GENERATION_KEY,
  AUTH_LOCK_KEY,
  SCHEMA_VERSION_KEY,
  STORAGE_KEY_PREFIX,
  SYNC_LEASE_KEY,
  platformEnabledKey,
} from "./storage";

// Removes everything the paired account owns from chrome.storage.local, so a
// different account paired later never inherits its cursors, pauses or counters.
//
// The sweep is by prefix with a keep-list rather than an enumeration of known
// keys: a key added later is account state by default and is cleared without
// this module having to learn about it.
//
// Background-only.

// The lease and auth lock are kept because unpair and pairing hold both while
// sweeping; removing them would release them early and wake any waiter. The
// enabled flags are a device preference, not account state, and the account
// generation must outlive the account it counts.
function keptKeys(): ReadonlySet<string> {
  return new Set([
    SYNC_LEASE_KEY,
    AUTH_LOCK_KEY,
    SCHEMA_VERSION_KEY,
    ACCOUNT_GENERATION_KEY,
    ...PlatformSchema.options.map((platform) => platformEnabledKey(platform)),
  ]);
}

export async function clearAccountState(): Promise<void> {
  const everything = await chrome.storage.local.get(null);
  const kept = keptKeys();
  const doomed = Object.keys(everything).filter(
    (key) => key.startsWith(STORAGE_KEY_PREFIX) && !kept.has(key),
  );
  if (doomed.length > 0) await chrome.storage.local.remove(doomed);
}
