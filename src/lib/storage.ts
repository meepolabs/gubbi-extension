import { z } from "zod";

import { logger } from "./logger";
import {
  PAIR_FAILURE_REASONS,
  SYNC_STATUS_STATES,
  type PairFailureReason,
  type SyncStatusState,
} from "./messages";
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

// Every key this extension writes starts with this prefix.
export const STORAGE_KEY_PREFIX = KEY_PREFIX;

const Keys = {
  cursor: (platform: Platform): string => `${KEY_PREFIX}cursor:${platform}`,
  lease: `${KEY_PREFIX}lease`,
  counters: `${KEY_PREFIX}counters`,
  authBlob: `${KEY_PREFIX}authBlob`,
  pendingAuthFlow: `${KEY_PREFIX}pendingAuthFlow`,
  refreshState: `${KEY_PREFIX}refreshState`,
  pauseState: (platform: Platform): string => `${KEY_PREFIX}pauseState:${platform}`,
  status: (platform: Platform): string => `${KEY_PREFIX}status:${platform}`,
  enabled: (platform: Platform): string => `${KEY_PREFIX}enabled:${platform}`,
  lastRunAt: (platform: Platform): string => `${KEY_PREFIX}lastRunAt:${platform}`,
  syncEvents: `${KEY_PREFIX}syncEvents`,
  lastPairFailure: `${KEY_PREFIX}lastPairFailure`,
  schemaVersion: `${KEY_PREFIX}schema_version`,
  accountGeneration: `${KEY_PREFIX}accountGeneration`,
  // The auth single-flight lock lives in src/lib/locks.ts; only its storage key
  // string is reserved here so the two modules agree on the namespace.
  authLock: `${KEY_PREFIX}authLock`,
} as const;

// The auth single-flight lock's storage key. The lock LOGIC lives in
// src/lib/locks.ts and the auth provider passes this key to withStorageLock;
// exported so both modules agree on the namespace without duplicating the
// literal.
export const AUTH_LOCK_KEY = Keys.authLock;

// The sync single-flight lease's storage key. The lease record is managed
// entirely by withStorageLock (src/lib/locks.ts), to which the orchestrator
// passes this key to guard the whole run. Exported so the lock guard and this
// module agree on the namespace without duplicating the literal.
export const SYNC_LEASE_KEY = Keys.lease;

export const SCHEMA_VERSION_KEY = Keys.schemaVersion;

// Advances on every unpair, so a pairing can tell that a disconnect happened
// while its auth window was open. Survives the account-state sweep.
export const ACCOUNT_GENERATION_KEY = Keys.accountGeneration;

export const platformEnabledKey = Keys.enabled;

// Cap on the content-free event ring buffer. Oldest entries are evicted at
// write time once the buffer would exceed this length.
export const MAX_SYNC_EVENTS = 200;

// Running totals surfaced in the popup.
export const SyncCountersSchema = z.object({
  conversations_uploaded: z.number().int(),
  conversations_skipped: z.number().int(),
  last_run_at: z.iso.datetime().nullable(),
});
export type SyncCounters = z.infer<typeof SyncCountersSchema>;

// Per-platform incremental-sync cursor (an ISO-8601 timestamp).
const CursorSchema = z.iso.datetime();

const PlatformEnabledSchema = z.boolean();

// When a sweep of one platform last reached collect (an ISO-8601 timestamp).
const PlatformLastRunAtSchema = z.iso.datetime();

// OAuth token material plus its connection status. `version` advances on every
// token rotation; refreshState records the version observed before a refresh so
// a concurrent rotation can be detected.
export const AuthBlobSchema = z.object({
  version: z.number().int().min(1),
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string(),
  status: z.enum(["ok", "reconnect_required"]),
  updatedAt: z.iso.datetime(),
});
export type AuthBlob = z.infer<typeof AuthBlobSchema>;

// Transient PKCE state persisted across the launchWebAuthFlow redirect.
export const PendingAuthFlowSchema = z.object({
  state: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
  startedAt: z.iso.datetime(),
});
export type PendingAuthFlow = z.infer<typeof PendingAuthFlowSchema>;

// Marker written before a token refresh begins. `authVersionBefore` lets a
// caller detect that another context rotated the token mid-refresh.
export const RefreshStateSchema = z.object({
  ownerId: z.string(),
  authVersionBefore: z.number().int(),
  startedAt: z.iso.datetime(),
});
export type RefreshState = z.infer<typeof RefreshStateSchema>;

// Per-platform backoff window: sync stays paused until `pausedUntil`.
export const PauseStateSchema = z.object({
  pausedUntil: z.iso.datetime(),
  reason: z.enum([
    "rate_limited",
    "drift",
    "transient",
    "session_lost",
    "waiting_for_tab",
    "org_ambiguous",
  ]),
});
export type PauseState = z.infer<typeof PauseStateSchema>;

// Popup-facing per-platform sync status snapshot. The enum members come from
// messages.ts (the single source of truth for the wire-level union); this schema
// just routes the persisted read through the same validated getItem path every
// other stored value uses, so a stale/unknown value degrades to undefined rather
// than being trusted via a raw cast.
const SyncStatusStateSchema = z.enum(
  SYNC_STATUS_STATES as readonly [SyncStatusState, ...SyncStatusState[]],
);

// A single content-free diagnostic event. Carries timing and a coarse `kind`
// only -- never message text, tokens, PII, or conversation identifiers.
export const SyncEventSchema = z.object({
  at: z.iso.datetime(),
  kind: z.string(),
  platform: PlatformSchema.optional(),
});
export type SyncEvent = z.infer<typeof SyncEventSchema>;

const SyncEventsSchema = z.array(SyncEventSchema);

// Why the most recent pairing attempt failed, and when. Account state: the
// account-state sweep removes it like any other key.
export const LastPairFailureSchema = z.object({
  reason: z.enum(PAIR_FAILURE_REASONS as readonly [PairFailureReason, ...PairFailureReason[]]),
  at: z.iso.datetime(),
});
export type LastPairFailure = z.infer<typeof LastPairFailureSchema>;

const AccountGenerationSchema = z.number().int().min(0);

// Persisted storage-schema version, read once at startup.
const SchemaVersionSchema = z.number().int();

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

export function getCounters(): Promise<SyncCounters | undefined> {
  return getItem(Keys.counters, (raw) => SyncCountersSchema.parse(raw));
}

export function setCounters(counters: SyncCounters): Promise<void> {
  return setItem(Keys.counters, counters);
}

export function getAuthBlob(): Promise<AuthBlob | undefined> {
  return getItem(Keys.authBlob, (raw) => AuthBlobSchema.parse(raw));
}

export function setAuthBlob(blob: AuthBlob): Promise<void> {
  return setItem(Keys.authBlob, blob);
}

export function clearAuthBlob(): Promise<void> {
  return removeItem(Keys.authBlob);
}

export function getPendingAuthFlow(): Promise<PendingAuthFlow | undefined> {
  return getItem(Keys.pendingAuthFlow, (raw) => PendingAuthFlowSchema.parse(raw));
}

export function setPendingAuthFlow(flow: PendingAuthFlow): Promise<void> {
  return setItem(Keys.pendingAuthFlow, flow);
}

export function clearPendingAuthFlow(): Promise<void> {
  return removeItem(Keys.pendingAuthFlow);
}

export function getRefreshState(): Promise<RefreshState | undefined> {
  return getItem(Keys.refreshState, (raw) => RefreshStateSchema.parse(raw));
}

export function setRefreshState(state: RefreshState): Promise<void> {
  return setItem(Keys.refreshState, state);
}

export function clearRefreshState(): Promise<void> {
  return removeItem(Keys.refreshState);
}

export function getPauseState(platform: Platform): Promise<PauseState | undefined> {
  return getItem(Keys.pauseState(platform), (raw) => PauseStateSchema.parse(raw));
}

export function setPauseState(platform: Platform, state: PauseState): Promise<void> {
  return setItem(Keys.pauseState(platform), state);
}

export function clearPauseState(platform: Platform): Promise<void> {
  return removeItem(Keys.pauseState(platform));
}

// Per-platform popup status snapshot. Read defaults to "idle" when absent or
// unparseable (the validated getItem drops an unknown stored value).
export async function getStatus(platform: Platform): Promise<SyncStatusState> {
  const state = await getItem(Keys.status(platform), (raw) => SyncStatusStateSchema.parse(raw));
  return state ?? "idle";
}

export function setStatus(platform: Platform, state: SyncStatusState): Promise<void> {
  return setItem(Keys.status(platform), state);
}

// A platform is enabled unless the user explicitly turned it off: an absent or
// unparseable value reads as enabled so a corrupt write never silently stops sync.
export async function getPlatformEnabled(platform: Platform): Promise<boolean> {
  const enabled = await getItem(Keys.enabled(platform), (raw) => PlatformEnabledSchema.parse(raw));
  return enabled ?? true;
}

export function setPlatformEnabled(platform: Platform, enabled: boolean): Promise<void> {
  return setItem(Keys.enabled(platform), enabled);
}

export function getPlatformLastRunAt(platform: Platform): Promise<string | undefined> {
  return getItem(Keys.lastRunAt(platform), (raw) => PlatformLastRunAtSchema.parse(raw));
}

export function setPlatformLastRunAt(platform: Platform, isoTimestamp: string): Promise<void> {
  return setItem(Keys.lastRunAt(platform), isoTimestamp);
}

export async function getSyncEvents(): Promise<SyncEvent[]> {
  const events = await getItem(Keys.syncEvents, (raw) => SyncEventsSchema.parse(raw));
  return events ?? [];
}

// Append one event, evicting oldest entries so the buffer never exceeds the
// cap. Builds a new array rather than mutating the stored one.
export async function appendSyncEvent(entry: SyncEvent): Promise<void> {
  const existing = await getSyncEvents();
  const next = [...existing, entry].slice(-MAX_SYNC_EVENTS);
  await setItem(Keys.syncEvents, next);
}

export function getLastPairFailure(): Promise<LastPairFailure | undefined> {
  return getItem(Keys.lastPairFailure, (raw) => LastPairFailureSchema.parse(raw));
}

export function setLastPairFailure(failure: LastPairFailure): Promise<void> {
  return setItem(Keys.lastPairFailure, failure);
}

export function clearLastPairFailure(): Promise<void> {
  return removeItem(Keys.lastPairFailure);
}

export async function getAccountGeneration(): Promise<number> {
  const generation = await getItem(Keys.accountGeneration, (raw) =>
    AccountGenerationSchema.parse(raw),
  );
  return generation ?? 0;
}

export function setAccountGeneration(generation: number): Promise<void> {
  return setItem(Keys.accountGeneration, generation);
}

export function getSchemaVersion(): Promise<number | undefined> {
  return getItem(Keys.schemaVersion, (raw) => SchemaVersionSchema.parse(raw));
}

export function setSchemaVersion(version: number): Promise<void> {
  return setItem(Keys.schemaVersion, version);
}

// Reserved migration seam. No stored-schema migrations exist yet (pre-launch,
// no real user data), so this is intentionally a no-op that returns the current
// version. Future migrations transform `stored` toward `current` here.
export function migrate(_stored: number, current: number): number {
  return current;
}
