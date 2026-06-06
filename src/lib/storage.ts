import { z } from "zod";

import { logger } from "./logger";
import { PlatformSchema, type Platform } from "./schema/ingest";

// Typed wrapper over chrome.storage.local with namespaced keys. This module is
// persistence only -- no business logic lives here.
//
// Stored blobs persist across extension versions and can be stale or partial
// after an upgrade, so every read is validated against a schema. A blob that
// fails validation is treated as ABSENT (the getter resolves to undefined) and
// logged: the caller then re-derives or re-fetches rather than acting on a
// shape the current code no longer understands. Validation never throws to the
// caller -- a corrupt cache entry must not break the sync loop.

const KEY_PREFIX = "gubbi:";

const Keys = {
  cursor: (platform: Platform): string => `${KEY_PREFIX}cursor:${platform}`,
  lease: `${KEY_PREFIX}lease`,
  counters: `${KEY_PREFIX}counters`,
  // TODO(phase-2 auth): the OAuth auth blob (auth / pendingAuthFlow / auth-lock)
  // keys and their schemas land with the auth task -- not here. The legacy
  // device_token key was removed (superseded by that blob).
} as const;

// Single-flight lease guarding against overlapping sync runs.
export const SyncLeaseSchema = z.object({
  run_id: z.string().min(1),
  platform: PlatformSchema,
  heartbeat_at: z.iso.datetime(),
});
export type SyncLease = z.infer<typeof SyncLeaseSchema>;

// Running totals surfaced in the popup.
export const SyncCountersSchema = z.object({
  conversations_uploaded: z.number().int(),
  conversations_skipped: z.number().int(),
  last_run_at: z.iso.datetime().nullable(),
});
export type SyncCounters = z.infer<typeof SyncCountersSchema>;

// Per-platform incremental-sync cursor (an ISO-8601 timestamp).
const CursorSchema = z.iso.datetime();

async function getItem<T>(key: string, parse: (raw: unknown) => T): Promise<T | undefined> {
  const record = await chrome.storage.local.get(key);
  const raw = record[key];
  if (raw === undefined) return undefined;
  try {
    return parse(raw);
  } catch {
    // Stale or partial blob from a prior version: drop it, do not surface it.
    logger.warn("discarded malformed stored value", { key });
    return undefined;
  }
}

async function setItem<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

async function removeItem(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

export function getCursor(platform: Platform): Promise<string | undefined> {
  return getItem(Keys.cursor(platform), (raw) => CursorSchema.parse(raw));
}

export function setCursor(platform: Platform, isoTimestamp: string): Promise<void> {
  return setItem(Keys.cursor(platform), isoTimestamp);
}

export function getLease(): Promise<SyncLease | undefined> {
  return getItem(Keys.lease, (raw) => SyncLeaseSchema.parse(raw));
}

export function setLease(lease: SyncLease): Promise<void> {
  return setItem(Keys.lease, lease);
}

export function clearLease(): Promise<void> {
  return removeItem(Keys.lease);
}

export function getCounters(): Promise<SyncCounters | undefined> {
  return getItem(Keys.counters, (raw) => SyncCountersSchema.parse(raw));
}

export function setCounters(counters: SyncCounters): Promise<void> {
  return setItem(Keys.counters, counters);
}
