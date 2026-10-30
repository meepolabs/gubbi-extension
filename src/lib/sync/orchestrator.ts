import { z } from "zod";

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
  getPlatformEnabled,
  getStatus,
  setCounters,
  setCursor,
  setPauseState,
  setPlatformLastRunAt,
  setStatus,
  SYNC_LEASE_KEY,
} from "../storage";
import {
  INGEST_MAX_BODY_BYTES,
  serializeRequest,
  uploadConversations as realUpload,
  type UploadOutcome,
} from "../api";
import { collectFromTab as realCollect, type CollectOutcome } from "./collect";
import type { AdapterPlatform } from "../connectors/base";
import type {
  IngestConversationRequest,
  IngestConversationResponse,
  ConversationPayload,
} from "../schema/ingest";
import { MAX_CONVERSATIONS_PER_REQUEST } from "../schema/ingest";
import type { SyncStatusState } from "../messages";
import type { TokenProvider } from "../token-provider";
import { timestampMs } from "./timestamps";

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

// Per-batch conversation cap (mirrors the upload client + backend bound). A batch
// is also closed early when its serialized body would exceed INGEST_MAX_BODY_BYTES.
const BATCH_SIZE = MAX_CONVERSATIONS_PER_REQUEST;

// Default backoff when a rate-limit carries no Retry-After hint.
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;

// Shortest pause any rate-limit produces, whatever Retry-After advises.
const MIN_RATE_LIMIT_BACKOFF_MS = 60 * 1000;

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

// A 200 that reports failed saves holds the cursor so the batch is re-sent; this
// many consecutive holds per platform, and the next partial save commits anyway
// and counts its failures as skipped, so one conversation the server can never
// save cannot stall the platform for good.
export const PARTIAL_SAVE_HOLD_LIMIT = 5;

// Transient backoff: a base window grown per consecutive transient failure and
// capped, with jitter so many clients do not retry in lockstep.
const TRANSIENT_BASE_BACKOFF_MS = 60 * 1000;
const TRANSIENT_MAX_BACKOFF_MS = 30 * 60 * 1000;
const TRANSIENT_JITTER_MS = 30 * 1000;

// The platforms a full run considers, in order. Each is swept only if its
// per-platform enabled flag is on at run start.
const ALL_PLATFORMS: readonly AdapterPlatform[] = ["chatgpt", "claude"];

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

// ---- Partial-save hold counter (persisted across wakes) ----------------------

const PARTIAL_SAVE_KEY_PREFIX = "gubbi:partialSave:";

function partialSaveKey(platform: AdapterPlatform): string {
  return `${PARTIAL_SAVE_KEY_PREFIX}${platform}`;
}

async function getPartialSaveCount(platform: AdapterPlatform): Promise<number> {
  const record = await chrome.storage.local.get(partialSaveKey(platform));
  const raw = record[partialSaveKey(platform)];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

async function setPartialSaveCount(platform: AdapterPlatform, count: number): Promise<void> {
  await chrome.storage.local.set({ [partialSaveKey(platform)]: count });
}

async function clearPartialSaveCount(platform: AdapterPlatform): Promise<void> {
  await chrome.storage.local.remove(partialSaveKey(platform));
}

// ---- Force-committed conversations (persisted across wakes) -----------------
//
// The server reports only how many saves failed, not which, so a forced commit
// remembers every conversation of its batch by id and watermark. A remembered
// conversation is left out of later uploads: one that saved would only dedupe,
// and one that keeps failing would otherwise start a new hold cycle each time
// the rewind window lists it again. A change gives it a new watermark, so it is
// sent again.

const FORCED_COMMIT_KEY_PREFIX = "gubbi:forcedCommit:";

const FingerprintsSchema = z.array(
  z.object({ platformId: z.string(), watermark: z.string() }).readonly(),
);

type Fingerprint = z.infer<typeof FingerprintsSchema>[number];

function forcedCommitKey(platform: AdapterPlatform): string {
  return `${FORCED_COMMIT_KEY_PREFIX}${platform}`;
}

async function getForcedCommits(platform: AdapterPlatform): Promise<Fingerprint[]> {
  const record = await chrome.storage.local.get(forcedCommitKey(platform));
  const raw = record[forcedCommitKey(platform)];
  const parsed = FingerprintsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

async function setForcedCommits(
  platform: AdapterPlatform,
  fingerprints: readonly Fingerprint[],
): Promise<void> {
  if (fingerprints.length === 0) {
    await chrome.storage.local.remove(forcedCommitKey(platform));
    return;
  }
  await chrome.storage.local.set({ [forcedCommitKey(platform)]: fingerprints });
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

const FRACTIONAL_SECONDS = /T\d{2}:\d{2}:\d{2}[.,](\d+)/;

// Digits of the fractional second beyond milliseconds, which Date.parse drops.
// Platforms keep microseconds, so two distinct instants can share a millisecond.
// Offsets are whole minutes, so they never change these digits.
function subMillisecondDigits(timestamp: string): string {
  const match = FRACTIONAL_SECONDS.exec(timestamp);
  return match?.[1]?.slice(3) ?? "";
}

// Orders timestamps by instant: they may carry differing UTC offsets, so text
// order is not time order.
function compareTimestamps(a: string, b: string): number {
  const msDiff = timestampMs(a) - timestampMs(b);
  if (msDiff !== 0) return msDiff;
  const aDigits = subMillisecondDigits(a);
  const bDigits = subMillisecondDigits(b);
  const width = Math.max(aDigits.length, bDigits.length);
  const aPadded = aDigits.padEnd(width, "0");
  const bPadded = bDigits.padEnd(width, "0");
  if (aPadded === bPadded) return 0;
  return aPadded < bPadded ? -1 : 1;
}

function compareWatermarks(a: ConversationPayload, b: ConversationPayload): number {
  return compareTimestamps(watermarkOf(a), watermarkOf(b));
}

function laterTimestamp(a: string, b: string): string {
  return compareTimestamps(a, b) >= 0 ? a : b;
}

// The effective `since` passed to collect: the stored cursor rewound by
// CURSOR_REWIND_MS (so same-second updates are not skipped), or undefined on a
// first run with no cursor yet.
function effectiveSince(cursorIso: string | undefined): string | undefined {
  if (cursorIso === undefined) return undefined;
  return isoFromMs(Date.parse(cursorIso) - CURSOR_REWIND_MS);
}

const utf8 = new TextEncoder();

function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

// Byte separating adjacent conversations in the serialized array.
const ARRAY_SEPARATOR_BYTES = 1;

interface BatchPlan {
  readonly batches: IngestConversationRequest[];
  // Conversations whose request alone would exceed the body cap; never uploaded.
  readonly dropped: readonly ConversationPayload[];
}

// Split a request's conversations into batches of at most BATCH_SIZE whose
// serialized body stays within INGEST_MAX_BODY_BYTES, in ascending watermark
// order so the cursor advances monotonically as batches succeed. The body size
// is summed per conversation (each serialized once) rather than re-serializing
// the growing batch; this equals serializeRequest of the batch because
// JSON.stringify without indentation joins array items with a single comma.
function toBatches(request: IngestConversationRequest): BatchPlan {
  const sorted = [...request.conversations].sort(compareWatermarks);
  const envelopeBytes = utf8Bytes(serializeRequest({ source: request.source, conversations: [] }));
  const batches: IngestConversationRequest[] = [];
  const dropped: ConversationPayload[] = [];
  let current: ConversationPayload[] = [];
  let currentBytes = envelopeBytes;

  for (const conversation of sorted) {
    const conversationBytes = utf8Bytes(JSON.stringify(conversation));
    if (envelopeBytes + conversationBytes > INGEST_MAX_BODY_BYTES) {
      dropped.push(conversation);
      continue;
    }
    const added = conversationBytes + (current.length > 0 ? ARRAY_SEPARATOR_BYTES : 0);
    if (current.length >= BATCH_SIZE || currentBytes + added > INGEST_MAX_BODY_BYTES) {
      batches.push({ source: request.source, conversations: current });
      current = [conversation];
      currentBytes = envelopeBytes + conversationBytes;
      continue;
    }
    current.push(conversation);
    currentBytes += added;
  }
  if (current.length > 0) batches.push({ source: request.source, conversations: current });
  return { batches, dropped };
}

// A dropped conversation is counted in the run whose cursor first moves past
// it, so it is counted once however often it is re-listed: a run that stops
// before it does not count it, and a later run starting past it does not either.
async function recordDroppedOversize(
  platform: AdapterPlatform,
  dropped: readonly ConversationPayload[],
  cursorBefore: string | undefined,
): Promise<void> {
  const cursorAfter = await getCursor(platform);
  if (cursorAfter === undefined) return;
  const passed = dropped.filter(
    (conversation) =>
      (cursorBefore === undefined ||
        compareTimestamps(watermarkOf(conversation), cursorBefore) > 0) &&
      compareTimestamps(watermarkOf(conversation), cursorAfter) <= 0,
  ).length;
  if (passed === 0) return;
  logger.warn("dropped conversations larger than the request body cap", {
    platform,
    dropped: passed,
    maxBodyBytes: INGEST_MAX_BODY_BYTES,
  });
  await addCounters({ skipped: passed });
}

function newestWatermark(conversations: readonly ConversationPayload[]): string | undefined {
  let max: ConversationPayload | undefined;
  for (const conversation of conversations) {
    if (max === undefined || compareWatermarks(conversation, max) > 0) max = conversation;
  }
  return max === undefined ? undefined : watermarkOf(max);
}

// The cursor only ever moves forward, so a batch re-sent from the rewind window
// can never pull it back before conversations already committed.
async function advanceCursor(platform: AdapterPlatform, candidate: string): Promise<void> {
  const current = await getCursor(platform);
  if (current === undefined || compareTimestamps(candidate, current) > 0) {
    await setCursor(platform, candidate);
  }
}

interface CounterDelta {
  readonly uploaded?: number;
  readonly skipped?: number;
  readonly nowMs?: number;
}

async function addCounters(delta: CounterDelta): Promise<void> {
  const existing = (await getCounters()) ?? {
    conversations_uploaded: 0,
    conversations_skipped: 0,
    last_run_at: null,
  };
  await setCounters({
    conversations_uploaded: existing.conversations_uploaded + (delta.uploaded ?? 0),
    conversations_skipped: existing.conversations_skipped + (delta.skipped ?? 0),
    last_run_at: delta.nowMs === undefined ? existing.last_run_at : isoFromMs(delta.nowMs),
  });
}

// Cursor + counters advance TOGETHER after a 200 so a crash between the two
// writes at worst re-uploads a batch the server dedupes on
// (user_id, platform, platform_id) -- idempotent. Counters track
// conversations_saved (server truth), never batch length, so a dedupe-skipped
// re-upload never double-counts.
async function commitBatch(
  platform: AdapterPlatform,
  batch: IngestConversationRequest,
  delta: CounterDelta,
): Promise<void> {
  const watermark = newestWatermark(batch.conversations);
  if (watermark !== undefined) await advanceCursor(platform, watermark);
  await addCounters(delta);
}

// Where the cursor goes once every batch of a request committed: the newest
// watermark of the whole request, dropped conversations included. When the
// listing was complete, a dropped conversation is also pushed past the collect
// rewind so the next listing excludes it; that is safe because every listed
// conversation up to it has committed. The push stops at the moment the run
// listed, so a conversation changed after that is still listed next time.
function completedRequestCursor(
  plan: BatchPlan,
  request: IngestConversationRequest,
  listing: ListingScope,
): string | undefined {
  const newest = newestWatermark(request.conversations);
  const newestDrop = newestWatermark(plan.dropped);
  if (newest === undefined || newestDrop === undefined || !listing.isComplete) return newest;
  const pastDropMs = Math.min(timestampMs(newestDrop) + CURSOR_REWIND_MS, listing.listedAtMs);
  return laterTimestamp(newest, isoFromMs(pastDropMs));
}

// Backoff window for a transient failure, grown per consecutive failure and
// capped, with bounded jitter.
function transientBackoffMs(consecutive: number, random: () => number): number {
  const grown = TRANSIENT_BASE_BACKOFF_MS * Math.max(1, consecutive);
  const capped = Math.min(grown, TRANSIENT_MAX_BACKOFF_MS);
  return capped + Math.floor(random() * TRANSIENT_JITTER_MS);
}

// Backoff window for a rate-limit. A server-advised Retry-After is honored but
// floored, so a "retry now" (0) or a tiny hint still yields a real pause rather
// than an immediate re-hit of the API that just throttled us. Only an ABSENT hint
// (null/undefined) falls back to the default window.
function rateLimitBackoffMs(retryAfterSeconds: number | null | undefined): number {
  if (retryAfterSeconds === null || retryAfterSeconds === undefined) {
    return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  }
  return Math.max(retryAfterSeconds * 1000, MIN_RATE_LIMIT_BACKOFF_MS);
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

// What the collect behind a request covered: whether the listing was complete
// (not cut short), and when it was taken.
interface ListingScope {
  readonly isComplete: boolean;
  readonly listedAtMs: number;
}

async function uploadBatches(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  listed: IngestConversationRequest,
  listing: ListingScope,
): Promise<UploadLoopResult> {
  const request = await withoutForcedCommits(platform, listed);
  const plan = toBatches(request);
  const cursorBefore = await getCursor(platform);
  const result = await uploadAllBatches(deps, platform, plan);
  if (result.kind === "complete") {
    const target = completedRequestCursor(plan, request, listing);
    if (target !== undefined) await advanceCursor(platform, target);
  }
  await recordDroppedOversize(platform, plan.dropped, cursorBefore);
  await pruneForcedCommits(platform);
  return result;
}

function isSameConversation(conversation: ConversationPayload, fingerprint: Fingerprint): boolean {
  return (
    conversation.platform_id === fingerprint.platformId &&
    compareTimestamps(watermarkOf(conversation), fingerprint.watermark) === 0
  );
}

async function withoutForcedCommits(
  platform: AdapterPlatform,
  request: IngestConversationRequest,
): Promise<IngestConversationRequest> {
  const remembered = await getForcedCommits(platform);
  if (remembered.length === 0) return request;
  return {
    ...request,
    conversations: request.conversations.filter(
      (conversation) =>
        !remembered.some((fingerprint) => isSameConversation(conversation, fingerprint)),
    ),
  };
}

async function rememberForcedCommit(
  platform: AdapterPlatform,
  batch: IngestConversationRequest,
): Promise<void> {
  const remembered = await getForcedCommits(platform);
  const added = batch.conversations.map((conversation) => ({
    platformId: conversation.platform_id,
    watermark: watermarkOf(conversation),
  }));
  await setForcedCommits(platform, [...remembered, ...added]);
}

// A conversation at or before the listing's `since` is not listed again unless
// it changes, so its fingerprint can go; this keeps the set to the conversations
// inside the rewind window of the cursor.
async function pruneForcedCommits(platform: AdapterPlatform): Promise<void> {
  const remembered = await getForcedCommits(platform);
  const since = effectiveSince(await getCursor(platform));
  if (remembered.length === 0 || since === undefined) return;
  const kept = remembered.filter(
    (fingerprint) => compareTimestamps(fingerprint.watermark, since) > 0,
  );
  if (kept.length !== remembered.length) await setForcedCommits(platform, kept);
}

async function uploadAllBatches(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  plan: BatchPlan,
): Promise<UploadLoopResult> {
  for (const batch of plan.batches) {
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
      if (outcome.response.extractions_skipped_error > 0) {
        return applyPartialSave(deps, platform, batch, outcome.response);
      }
      await commitBatch(platform, batch, {
        uploaded: outcome.response.conversations_saved,
        nowMs: deps.now(),
      });
      // A clean batch resets the consecutive-transient streak so a later isolated
      // transient blip starts the backoff from the base window again.
      await clearTransientCount(platform);
      await clearPartialSaveCount(platform);
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
      // The server rejected a batch the client sized under the cap, so the two
      // sides disagree on the limit. Re-sending would hit the same rejection on
      // every run; pause as drift instead.
      logger.error("upload rejected as oversize despite byte-aware batching", {
        platform,
        conversations: batch.conversations.length,
      });
      await pause(deps, platform, "drift", deps.now() + DEFAULT_DRIFT_BACKOFF_MS);
      return { kind: "paused" };
    }
    default: {
      // Exhaustiveness guard: every UploadOutcome status is handled above.
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// A 200 whose body reports failed saves. What saved is counted now; the cursor
// stays so the whole batch is re-sent (the server dedupes the saved ones), and
// the later batches wait, since committing them would move the cursor past the
// failed conversations.
async function applyPartialSave(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  batch: IngestConversationRequest,
  response: IngestConversationResponse,
): Promise<SingleBatchResult> {
  const holds = await getPartialSaveCount(platform);
  if (holds >= PARTIAL_SAVE_HOLD_LIMIT) {
    logger.warn("committing a partially saved batch after repeated holds", {
      platform,
      failed: response.extractions_skipped_error,
    });
    await commitBatch(platform, batch, {
      uploaded: response.conversations_saved,
      skipped: response.extractions_skipped_error,
      nowMs: deps.now(),
    });
    await rememberForcedCommit(platform, batch);
    await clearTransientCount(platform);
    await clearPartialSaveCount(platform);
    return { kind: "continue" };
  }
  await addCounters({ uploaded: response.conversations_saved, nowMs: deps.now() });
  await setPartialSaveCount(platform, holds + 1);
  const consecutive = await bumpTransientCount(platform);
  await pause(
    deps,
    platform,
    "transient",
    deps.now() + transientBackoffMs(consecutive, deps.random),
  );
  return { kind: "paused" };
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
  const listedAtMs = deps.now();
  await setPlatformLastRunAt(platform, isoFromMs(listedAtMs));
  const outcome = await deps.collect(tabId, platform, since);

  return consumeCollectOutcome(deps, platform, outcome, listedAtMs);
}

async function consumeCollectOutcome(
  deps: RunSyncDeps,
  platform: AdapterPlatform,
  outcome: CollectOutcome,
  listedAtMs: number,
): Promise<PlatformResult> {
  const truncated: ListingScope = { isComplete: false, listedAtMs };
  if (outcome.status === "failed") {
    // Upload whatever partial batch was collected before the list failure, then
    // pause by the mapped reason. Cursor never advances past the uncollected
    // remainder -- commitBatch only moves it to the partial batch's watermark.
    const upload = await uploadBatches(deps, platform, outcome.request, truncated);
    if (upload.kind === "reconnect") return "abort_run";
    if (upload.kind === "paused") return "continue";
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
    const upload = await uploadBatches(deps, platform, outcome.request, truncated);
    if (upload.kind === "reconnect") return "abort_run";
    if (upload.kind === "paused") return "continue";
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

  const upload = await uploadBatches(deps, platform, outcome.request, {
    isComplete: outcome.complete,
    listedAtMs,
  });
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

async function enabledPlatforms(
  candidates: readonly AdapterPlatform[],
): Promise<AdapterPlatform[]> {
  const flags = await Promise.all(candidates.map((platform) => getPlatformEnabled(platform)));
  return candidates.filter((_platform, index) => flags[index]);
}

// Run one sync sweep under the single-flight lease. A second concurrent call
// short-circuits (LockContendedError) so two wakes never double-sync.
export async function runSync(options: RunSyncOptions = {}): Promise<void> {
  const deps: RunSyncDeps = { ...realDeps, ...(options.deps ?? {}) };
  const candidates = options.platform !== undefined ? [options.platform] : ALL_PLATFORMS;

  try {
    await withStorageLock(SYNC_LEASE_KEY, SYNC_LEASE_TTL_MS, async () => {
      await appendSyncEvent({ at: isoFromMs(deps.now()), kind: EVENT.runStart });
      await appendSyncEvent({ at: isoFromMs(deps.now()), kind: EVENT.leaseAcquired });

      // Flags are snapshotted here: turning a platform off mid-run stops future
      // runs only, never the sweep already in flight.
      const platforms = await enabledPlatforms(candidates);
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
