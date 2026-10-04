import { ReconnectRequiredError } from "../auth/errors";
import { tokenProvider as realTokenProvider } from "../auth/provider";
import { logger } from "../logger";
import { LockContendedError, withStorageLock } from "../locks";
import {
  appendSyncEvent,
  clearPauseState,
  getCounters,
  getCursor,
  getPauseState,
  getStatus,
  setCounters,
  setCursor,
  setPauseState,
  setStatus,
  SYNC_LEASE_KEY,
} from "../storage";
import { uploadConversations as realUpload, type UploadOutcome } from "../api";
import { collectFromTab as realCollect, type CollectOutcome } from "./collect";
import type { AdapterPlatform } from "../connectors/base";
import type { IngestConversationRequest, ConversationPayload } from "../schema/ingest";
import { MAX_CONVERSATIONS_PER_REQUEST } from "../schema/ingest";
import type { SyncStatusState } from "../messages";
import type { TokenProvider } from "../token-provider";

// Background sync orchestrator. Wakes on the 30-min alarm or a
// manual SYNC_START and, for each enabled platform, drives:
//   find tab -> collect new conversations -> upload in batches -> advance cursor
// all under a single-flight sync lease that survives MV3 service-worker death.
//
// BACKGROUND/LIB ONLY: it reaches collect (zod normalizers), api (guardedFetch),
// auth (storage + chrome.identity) and the storage zod layer. A content script
// must never import this module. The orchestrator itself performs NO direct
// fetch -- all network IO is behind guardedFetch in api/auth.
//
// Pure-ish: the tab-finder, token provider, collect, upload, clock, and the
// continuation scheduler are injectable so the control flow is unit-testable
// without chrome.* or the network.

// The lease is held for the whole run. Five minutes is well past a normal wake
// (one platform, a handful of upload batches) yet short enough that a crashed
// worker's stale lease is taken over on the next wake rather than wedging sync.
const SYNC_LEASE_TTL_MS = 5 * 60 * 1000;

// Per-batch conversation cap (mirrors the upload client + backend bound).
const BATCH_SIZE = MAX_CONVERSATIONS_PER_REQUEST;

// Default backoff when a rate-limit carries no Retry-After hint.
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;

// Backoff while waiting for a logged-in platform tab to appear. Distinct from
// the rate-limit default (though equal for now) so tuning one never silently
// moves the other -- a tab wait is not a rate-limit condition.
const DEFAULT_TAB_WAIT_BACKOFF_MS = 30 * 60 * 1000;

// Backoff after a connector-drift pause. Distinct constant for the same reason:
// drift is a payload-shape divergence, not a rate-limit condition.
const DEFAULT_DRIFT_BACKOFF_MS = 30 * 60 * 1000;

// Re-collect a hair before the cursor so a conversation updated within the same
// second as the last watermark is not skipped (the server dedupes the overlap).
const CURSOR_REWIND_MS = 60 * 1000;

// Consecutive malformed-conversation runs past this threshold flips a platform to
// the "drift" pause: a sustained normalize failure signals the connector has
// diverged from the platform's payload shape, not one stray bad conversation.
export const DRIFT_THRESHOLD = 5;

// Transient backoff: a base window grown per consecutive transient failure and
// capped, with jitter so many clients do not retry in lockstep.
const TRANSIENT_BASE_BACKOFF_MS = 60 * 1000;
const TRANSIENT_MAX_BACKOFF_MS = 30 * 60 * 1000;
const TRANSIENT_JITTER_MS = 30 * 1000;

// The platforms a run sweeps, in order. Both are enabled for now; a per-platform
// enabled flag would be read here when one exists.
const ENABLED_PLATFORMS: readonly AdapterPlatform[] = ["chatgpt", "claude"];

// Coarse, content-free event kinds for the diagnostic ring buffer. Never carries
// message text, tokens, PII, or conversation identifiers.
const EVENT = {
  runStart: "run_start",
  runEnd: "run_end",
  leaseAcquired: "lease_acquired",
  leaseContended: "lease_contended",
  pauseSet: "pause_set",
  reconnect: "reconnect_required",
  budgetExhausted: "budget_exhausted",
  continuationScheduled: "continuation_scheduled",
} as const;

// The orchestrator's injectable surface. Everything that touches chrome.*, the
// network, or wall-clock time is a dependency so the control flow is testable in
// isolation. Defaults bind to the real implementations.
export interface RunSyncDeps {
  // Resolves the id of a logged-in tab for the platform, or null when none is
  // open. "Logged in" vs "no tab" is distinguished downstream: no tab here means
  // waiting_for_tab; a tab that is logged out surfaces as collect's session_lost.
  readonly findTab: (platform: AdapterPlatform) => Promise<number | null>;
  readonly collect: typeof realCollect;
  readonly upload: typeof realUpload;
  readonly tokenProvider: TokenProvider;
  readonly now: () => number;
  // Schedules a near-term follow-up wake so a large backfill (collect
  // complete=false) spans multiple service-worker wakes instead of one long run.
  readonly scheduleContinuation: () => Promise<void>;
  // Persists the popup-facing per-platform status snapshot.
  readonly setStatus: (platform: AdapterPlatform, state: SyncStatusState) => Promise<void>;
  // Random in [0, 1) for backoff jitter; injectable for deterministic tests.
  readonly random: () => number;
}

function defaultFindTab(platform: AdapterPlatform): Promise<number | null> {
  const matchUrl = platform === "chatgpt" ? "https://chatgpt.com/*" : "https://claude.ai/*";
  return chrome.tabs.query({ url: matchUrl }).then((tabs) => {
    const tab = tabs.find((candidate) => typeof candidate.id === "number");
    return tab?.id ?? null;
  });
}

function defaultScheduleContinuation(): Promise<void> {
  // A short one-shot alarm so the next backfill page is picked up promptly
  // without waiting the full 30-min period. The periodic alarm keeps firing too.
  return chrome.alarms.create("sync-continuation", { delayInMinutes: 1 });
}

function defaultSetStatus(platform: AdapterPlatform, state: SyncStatusState): Promise<void> {
  return setSyncStatus(platform, state);
}

const realDeps: RunSyncDeps = {
  findTab: defaultFindTab,
  collect: realCollect,
  upload: realUpload,
  tokenProvider: realTokenProvider,
  now: () => Date.now(),
  scheduleContinuation: defaultScheduleContinuation,
  setStatus: defaultSetStatus,
  random: () => Math.random(),
};

// ---- Persisted per-platform status snapshot ----------------------------------
//
// STATUS_REQUEST is answered from this snapshot rather than live run state, so it
// survives a service-worker teardown. The read/write go through storage.ts's
// validated zod layer (getStatus/setStatus) like every other stored value, so an
// unknown persisted value degrades to "idle" rather than being trusted raw.

export function setSyncStatus(platform: AdapterPlatform, state: SyncStatusState): Promise<void> {
  return setStatus(platform, state);
}

export function getSyncStatus(platform: AdapterPlatform): Promise<SyncStatusState> {
  return getStatus(platform);
}

// ---- Drift counter (persisted across wakes) ----------------------------------

const DRIFT_KEY_PREFIX = "gubbi:drift:";

function driftKey(platform: AdapterPlatform): string {
  return `${DRIFT_KEY_PREFIX}${platform}`;
}

async function getDriftCount(platform: AdapterPlatform): Promise<number> {
  const record = await chrome.storage.local.get(driftKey(platform));
  const raw = record[driftKey(platform)];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

async function setDriftCount(platform: AdapterPlatform, count: number): Promise<void> {
  await chrome.storage.local.set({ [driftKey(platform)]: count });
}

async function clearDriftCount(platform: AdapterPlatform): Promise<void> {
  await chrome.storage.local.remove(driftKey(platform));
}

// ---- Transient-failure counter (persisted across wakes) ----------------------
//
// Counts CONSECUTIVE transient failures per platform so the backoff window can
// grow across wakes (a single wake is one attempt). Incremented on a transient
// pause, reset on any successful/clean batch -- mirrors the drift counter.

const TRANSIENT_KEY_PREFIX = "gubbi:transient:";

function transientKey(platform: AdapterPlatform): string {
  return `${TRANSIENT_KEY_PREFIX}${platform}`;
}

async function getTransientCount(platform: AdapterPlatform): Promise<number> {
  const record = await chrome.storage.local.get(transientKey(platform));
  const raw = record[transientKey(platform)];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

async function setTransientCount(platform: AdapterPlatform, count: number): Promise<void> {
  await chrome.storage.local.set({ [transientKey(platform)]: count });
}

async function clearTransientCount(platform: AdapterPlatform): Promise<void> {
  await chrome.storage.local.remove(transientKey(platform));
}

// Record one more consecutive transient failure and return the new count, so the
// caller can size the growing backoff window.
async function bumpTransientCount(platform: AdapterPlatform): Promise<number> {
  const next = (await getTransientCount(platform)) + 1;
  await setTransientCount(platform, next);
  return next;
}

// ---- Helpers -----------------------------------------------------------------

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

// The watermark a conversation advances the cursor to: updated_at when present,
// else created_at. Used for both batch ordering and cursor advancement.
function watermarkOf(conversation: ConversationPayload): string {
  return conversation.updated_at ?? conversation.created_at;
}

// The effective `since` passed to collect: the stored cursor rewound by
// CURSOR_REWIND_MS (so same-second updates are not skipped), or undefined on a
// first run with no cursor yet.
function effectiveSince(cursorIso: string | undefined): string | undefined {
  if (cursorIso === undefined) return undefined;
  return isoFromMs(Date.parse(cursorIso) - CURSOR_REWIND_MS);
}

// Split a request's conversations into <= BATCH_SIZE batches, each in ascending
// watermark order, so the cursor advances monotonically as batches succeed.
function toBatches(request: IngestConversationRequest): IngestConversationRequest[] {
  const sorted = [...request.conversations].sort((a, b) =>
    watermarkOf(a) < watermarkOf(b) ? -1 : watermarkOf(a) > watermarkOf(b) ? 1 : 0,
  );
  const batches: IngestConversationRequest[] = [];
  for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
    batches.push({ source: request.source, conversations: sorted.slice(i, i + BATCH_SIZE) });
  }
  return batches;
}

function maxWatermark(batch: IngestConversationRequest): string | undefined {
  let max: string | undefined;
  for (const conversation of batch.conversations) {
    const wm = watermarkOf(conversation);
    if (max === undefined || wm > max) max = wm;
  }
  return max;
}

// Cursor + counters advance TOGETHER after a 200 so a crash between the two
// writes at worst re-uploads a batch the server dedupes on
// (user_id, platform, platform_id) -- idempotent. Counters track
// conversations_saved (server truth), never batch length, so a dedupe-skipped
// re-upload never double-counts.
async function commitBatch(
  platform: AdapterPlatform,
  batch: IngestConversationRequest,
  conversationsSaved: number,
  nowMs: number,
): Promise<void> {
  const watermark = maxWatermark(batch);
  if (watermark !== undefined) await setCursor(platform, watermark);

  const existing = (await getCounters()) ?? {
    conversations_uploaded: 0,
    conversations_skipped: 0,
    last_run_at: null,
  };
  await setCounters({
    ...existing,
    conversations_uploaded: existing.conversations_uploaded + conversationsSaved,
    last_run_at: isoFromMs(nowMs),
  });
}

// Backoff window for a transient failure, grown per consecutive failure and
// capped, with bounded jitter.
function transientBackoffMs(consecutive: number, random: () => number): number {
  const grown = TRANSIENT_BASE_BACKOFF_MS * Math.max(1, consecutive);
  const capped = Math.min(grown, TRANSIENT_MAX_BACKOFF_MS);
  return capped + Math.floor(random() * TRANSIENT_JITTER_MS);
}

// Backoff window for a rate-limit. A server-advised Retry-After of 0 means
// "retry now" and must be honored as a real zero wait -- only an ABSENT hint
// (null/undefined) falls back to the default window. Branch on null/undefined
// explicitly so a legitimate 0 is not swallowed by `|| DEFAULT`.
function rateLimitBackoffMs(retryAfterSeconds: number | null | undefined): number {
  if (retryAfterSeconds === null || retryAfterSeconds === undefined) {
    return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  }
  return retryAfterSeconds * 1000;
}

async function pause(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  reason: "rate_limited" | "drift" | "transient" | "session_lost" | "waiting_for_tab",
  untilMs: number,
): Promise<void> {
  await setPauseState(platform, { pausedUntil: isoFromMs(untilMs), reason });
  await deps.setStatus(platform, "paused");
  await appendSyncEvent({ at: isoFromMs(deps.now()), kind: EVENT.pauseSet, platform });
}

// Outcome of a single platform sweep, so the run loop knows whether a hard stop
// (reconnect) should abort the remaining platforms too.
type PlatformResult = "continue" | "abort_run";

// ---- Upload loop -------------------------------------------------------------
//
// Uploads each batch in ascending-watermark order. Returns when the request is
// fully uploaded, or stops early on a pause/reconnect condition.

type UploadLoopResult =
  | { kind: "complete" }
  | { kind: "paused" } // pause already set; stop this platform, continue run
  | { kind: "reconnect" }; // status set reconnect_required; abort the whole run

async function uploadBatches(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  request: IngestConversationRequest,
): Promise<UploadLoopResult> {
  const batches = toBatches(request);
  for (const batch of batches) {
    const result = await uploadOneBatch(deps, platform, batch);
    if (result.kind !== "continue") return result;
  }
  return { kind: "complete" };
}

type SingleBatchResult = { kind: "continue" } | { kind: "paused" } | { kind: "reconnect" };

async function uploadOneBatch(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  batch: IngestConversationRequest,
): Promise<SingleBatchResult> {
  let outcome = await deps.upload(batch, deps.tokenProvider);

  if (outcome.status === "needs_refresh") {
    // Server rejected an otherwise-valid token (401). Force ONE refresh, then
    // retry THE SAME batch ONCE. A second 401 -- or a refresh that reports the
    // session is unrecoverable -- means re-pairing is required: stop the run.
    //
    // forceRefresh now fails closed: its only rejection is ReconnectRequiredError
    // (refresh has no transient/retry arm any more). The defensive catch-all keeps
    // an UNEXPECTED throw from escaping past the lease wrapper unhandled -- it ends
    // the run cleanly via reconnect (status set, lease released) instead.
    try {
      await deps.tokenProvider.forceRefresh();
    } catch (error) {
      if (!(error instanceof ReconnectRequiredError)) {
        logger.error("unexpected forceRefresh failure", { platform, error: String(error) });
      }
      return reconnect(deps, platform);
    }
    outcome = await deps.upload(batch, deps.tokenProvider);
    if (outcome.status === "needs_refresh") return reconnect(deps, platform);
  }

  return applyUploadOutcome(deps, platform, batch, outcome);
}

async function applyUploadOutcome(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  batch: IngestConversationRequest,
  outcome: UploadOutcome,
): Promise<SingleBatchResult> {
  switch (outcome.status) {
    case "ok": {
      await commitBatch(platform, batch, outcome.response.conversations_saved, deps.now());
      // A clean batch resets the consecutive-transient streak so a later isolated
      // transient blip starts the backoff from the base window again.
      await clearTransientCount(platform);
      if (outcome.response.budget_exhausted) {
        // The batch SAVED -- extraction is paused server-side by budget, not a
        // failure. Keep advancing the cursor; surface a non-error note only.
        await appendSyncEvent({
          at: isoFromMs(deps.now()),
          kind: EVENT.budgetExhausted,
          platform,
        });
      }
      return { kind: "continue" };
    }
    case "needs_refresh":
      // Reached only as the post-retry 401; treated as reconnect by the caller.
      return reconnect(deps, platform);
    case "auth_unavailable":
    case "insufficient_scope":
      return reconnect(deps, platform);
    case "rate_limited": {
      await pause(
        deps,
        platform,
        "rate_limited",
        deps.now() + rateLimitBackoffMs(outcome.retryAfterSeconds),
      );
      return { kind: "paused" };
    }
    case "transient_http":
    case "network":
    case "malformed_response": {
      // No inner retry loop beyond the single 401 forceRefresh-retry-once. A
      // malformed 2xx body is treated as transient: back off and retry later.
      // The backoff grows with the persisted consecutive-transient streak.
      const consecutive = await bumpTransientCount(platform);
      await pause(
        deps,
        platform,
        "transient",
        deps.now() + transientBackoffMs(consecutive, deps.random),
      );
      return { kind: "paused" };
    }
    case "oversize_batch": {
      // Cannot happen -- batches are capped at BATCH_SIZE. A programming error if
      // it does; stop rather than loop.
      logger.error("oversize batch reached upload despite batching", { platform });
      return { kind: "paused" };
    }
    default: {
      // Exhaustiveness guard: every UploadOutcome status is handled above.
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

async function reconnect(deps: RunSyncDeps, platform: AdapterPlatform): Promise<SingleBatchResult> {
  await deps.setStatus(platform, "reconnect_required");
  await appendSyncEvent({ at: isoFromMs(deps.now()), kind: EVENT.reconnect, platform });
  return { kind: "reconnect" };
}

// ---- Per-platform sweep ------------------------------------------------------

async function syncPlatform(deps: RunSyncDeps, platform: AdapterPlatform): Promise<PlatformResult> {
  // Honor an active backoff window: skip without collecting.
  const paused = await getPauseState(platform);
  if (paused !== undefined && Date.parse(paused.pausedUntil) > deps.now()) {
    await deps.setStatus(platform, "paused");
    return "continue";
  }

  const tabId = await deps.findTab(platform);
  if (tabId === null) {
    await pause(deps, platform, "waiting_for_tab", deps.now() + DEFAULT_TAB_WAIT_BACKOFF_MS);
    return "continue";
  }

  await deps.setStatus(platform, "syncing");

  const cursor = await getCursor(platform);
  const since = effectiveSince(cursor);
  const outcome = await deps.collect(tabId, platform, since);

  return consumeCollectOutcome(deps, platform, outcome);
}

async function consumeCollectOutcome(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  outcome: CollectOutcome,
): Promise<PlatformResult> {
  if (outcome.status === "failed") {
    // Upload whatever partial batch was collected before the list failure, then
    // pause by the mapped reason. Cursor never advances past the uncollected
    // remainder -- commitBatch only moves it to the partial batch's watermark.
    const upload = await uploadBatches(deps, platform, outcome.request);
    if (upload.kind === "reconnect") return "abort_run";
    if (outcome.reason === "session_lost") {
      await pause(deps, platform, "session_lost", deps.now() + DEFAULT_RATE_LIMIT_BACKOFF_MS);
      return "continue";
    }
    const consecutive = await bumpTransientCount(platform);
    await pause(
      deps,
      platform,
      "transient",
      deps.now() + transientBackoffMs(consecutive, deps.random),
    );
    return "continue";
  }

  if (outcome.status === "rate_limited") {
    const upload = await uploadBatches(deps, platform, outcome.request);
    if (upload.kind === "reconnect") return "abort_run";
    await pause(
      deps,
      platform,
      "rate_limited",
      deps.now() + rateLimitBackoffMs(outcome.retryAfterSeconds),
    );
    return "continue";
  }

  // status === "ok".
  //
  // Update drift tracking from THIS collect's malformed tally BEFORE uploading,
  // so the consecutive-malformed streak reflects the collect result regardless of
  // whether the subsequent upload later pauses. A clean collect (0 malformed)
  // resets the streak even when the upload then hits a transient pause -- only
  // then is "consecutive" truly consecutive. If the streak crosses the drift
  // threshold the platform is paused for drift and the upload is skipped this
  // wake.
  const driftResult = await updateDrift(deps, platform, outcome.failures.malformed_response);
  if (driftResult === "paused") return "continue";

  const upload = await uploadBatches(deps, platform, outcome.request);
  if (upload.kind === "reconnect") return "abort_run";
  if (upload.kind === "paused") return "continue";

  if (!outcome.complete) {
    // A backfill page remains; schedule a near-term wake so it resumes promptly.
    await deps.scheduleContinuation();
    await appendSyncEvent({
      at: isoFromMs(deps.now()),
      kind: EVENT.continuationScheduled,
      platform,
    });
    await deps.setStatus(platform, "syncing");
    return "continue";
  }

  // Clean, complete sweep: clear any prior pause and settle to idle.
  await clearPauseState(platform);
  await deps.setStatus(platform, "idle");
  return "continue";
}

// Accumulate consecutive malformed counts across wakes. A run with zero malformed
// resets the streak; one past DRIFT_THRESHOLD flips the platform to drift pause.
async function updateDrift(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  malformedThisRun: number,
): Promise<"ok" | "paused"> {
  if (malformedThisRun === 0) {
    await clearDriftCount(platform);
    return "ok";
  }
  const next = (await getDriftCount(platform)) + malformedThisRun;
  if (next > DRIFT_THRESHOLD) {
    await clearDriftCount(platform);
    await pause(deps, platform, "drift", deps.now() + DEFAULT_DRIFT_BACKOFF_MS);
    return "paused";
  }
  await setDriftCount(platform, next);
  return "ok";
}

// ---- Public entry ------------------------------------------------------------

export interface RunSyncOptions {
  // Restrict the sweep to a single platform (manual "Sync now" for one platform).
  readonly platform?: AdapterPlatform;
  // Override any subset of the real dependencies (tests inject fakes).
  readonly deps?: Partial<RunSyncDeps>;
}

// Run one sync sweep under the single-flight lease. A second concurrent call
// short-circuits (LockContendedError) so two wakes never double-sync.
export async function runSync(options: RunSyncOptions = {}): Promise<void> {
  const deps: RunSyncDeps = { ...realDeps, ...(options.deps ?? {}) };
  const platforms = options.platform !== undefined ? [options.platform] : ENABLED_PLATFORMS;

  try {
    await withStorageLock(SYNC_LEASE_KEY, SYNC_LEASE_TTL_MS, async () => {
      await appendSyncEvent({ at: isoFromMs(deps.now()), kind: EVENT.runStart });
      await appendSyncEvent({ at: isoFromMs(deps.now()), kind: EVENT.leaseAcquired });

      for (const platform of platforms) {
        const result = await syncPlatform(deps, platform);
        if (result === "abort_run") break;
      }

      await appendSyncEvent({ at: isoFromMs(deps.now()), kind: EVENT.runEnd });
    });
  } catch (error) {
    if (error instanceof LockContendedError) {
      // Another wake already holds the lease; this invocation is a no-op.
      await appendSyncEvent({ at: isoFromMs(deps.now()), kind: EVENT.leaseContended });
      logger.info("sync lease contended; skipping overlapping run", {});
      return;
    }
    throw error;
  }
}
