import { logger } from "../logger";
import type {
  ConversationPayload,
  IngestConversationRequest,
  IngestSource,
} from "../schema/ingest";
import type { AdapterPlatform } from "../connectors/base";
import { NORMALIZERS } from "../connectors/registry";
import type {
  ListRequestMessage,
  ListResultMessage,
  ConversationRequestMessage,
  ConversationResultMessage,
  FailureReason,
} from "../messages";
import type { ConversationSummary } from "../connectors/base";

// Background-side collect seam: drives one platform tab end to end (list ->
// fetch -> normalize) and returns a structured CollectOutcome. The orchestrator
// consumes the outcome and owns lease/scheduling/batching/upload.
// BACKGROUND/LIB ONLY (it reaches the Zod normalizers).

const PLATFORM_TO_SOURCE: Record<AdapterPlatform, IngestSource> = {
  chatgpt: "extension_chatgpt",
  claude: "extension_claude",
};

// Result of normalizing a batch of raw conversations: the valid payloads plus a
// count of those skipped as malformed (a drift signal worth surfacing, never a
// reason to abort the run).
export interface NormalizeBatchResult {
  conversations: ConversationPayload[];
  skipped: number;
}

// Pure: runs each raw conversation through the platform normalizer, dropping
// (and counting) any that fail. Separated from the messaging layer so it is
// unit-testable without chrome.* or the network.
export function normalizeBatch(
  platform: AdapterPlatform,
  raws: readonly unknown[],
): NormalizeBatchResult {
  const normalizer = NORMALIZERS[platform];
  const conversations: ConversationPayload[] = [];
  let skipped = 0;
  for (const raw of raws) {
    const normalized = normalizer.normalizeConversation(raw);
    if (normalized === null) skipped += 1;
    else conversations.push(normalized);
  }
  return { conversations, skipped };
}

// Pure: assembles the ingest request envelope for a platform's normalized
// conversations. The per-batch size cap (MAX_CONVERSATIONS_PER_REQUEST) is
// enforced at the upload layer; this just sets source + payloads.
export function assembleIngestRequest(
  platform: AdapterPlatform,
  conversations: ConversationPayload[],
): IngestConversationRequest {
  return { source: PLATFORM_TO_SOURCE[platform], conversations };
}

// Thin messaging helpers. chrome.tabs.sendMessage resolves with the content
// script's response, but rejects with "Could not establish connection" when the
// tab has no listener (closed, navigated away, or a content script that has not
// loaded yet). A rejection MUST NOT escape collectFromTab as an exception -- the
// orchestrator's pause logic needs a structured outcome -- so each call is
// wrapped and a rejection OR a shape mismatch maps to a typed failure message.
//
// Shape guard: a stale content script (extension updated, tab not reloaded) can
// answer with an old/foreign envelope. A minimal runtime check (the discriminant
// type plus the presence of `result`) catches that version skew and routes it to
// malformed_response instead of trusting an unchecked cast.

function isListResultMessage(value: unknown): value is ListResultMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; result?: unknown };
  return (
    candidate.type === "LIST_RESULT" &&
    typeof candidate.result === "object" &&
    candidate.result !== null
  );
}

function isConversationResultMessage(value: unknown): value is ConversationResultMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; result?: unknown };
  return (
    candidate.type === "CONVERSATION_RESULT" &&
    typeof candidate.result === "object" &&
    candidate.result !== null
  );
}

function listFailure(platform: AdapterPlatform, reason: FailureReason): ListResultMessage {
  return { type: "LIST_RESULT", platform, result: { ok: false, reason } };
}

function conversationFailure(
  platform: AdapterPlatform,
  conversationId: string,
  reason: FailureReason,
): ConversationResultMessage {
  return { type: "CONVERSATION_RESULT", platform, conversationId, result: { ok: false, reason } };
}

async function requestList(
  tabId: number,
  platform: AdapterPlatform,
  since?: string,
): Promise<ListResultMessage> {
  const message: ListRequestMessage =
    since === undefined
      ? { type: "LIST_REQUEST", platform }
      : { type: "LIST_REQUEST", platform, since };
  let response: unknown;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Tab disconnected / no listener: retryable transient, not a crash.
    return listFailure(platform, "transient_http");
  }
  if (!isListResultMessage(response)) return listFailure(platform, "malformed_response");
  return response;
}

async function requestConversation(
  tabId: number,
  platform: AdapterPlatform,
  conversationId: string,
): Promise<ConversationResultMessage> {
  const message: ConversationRequestMessage = {
    type: "CONVERSATION_REQUEST",
    platform,
    conversationId,
  };
  let response: unknown;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return conversationFailure(platform, conversationId, "transient_http");
  }
  if (!isConversationResultMessage(response)) {
    return conversationFailure(platform, conversationId, "malformed_response");
  }
  return response;
}

// Per-reason tally of per-conversation failures observed during a run. A single
// bad conversation never aborts the run (we keep going), but the reason is
// recorded here so the orchestrator can detect drift -- e.g. a sudden spike in
// session_lost across conversations signals a dead session, not one stray
// malformed payload. Every FailureReason is present (zero when unseen) so
// callers can index without an undefined check.
export type FailureCounts = Record<FailureReason, number>;

function emptyFailureCounts(): FailureCounts {
  return {
    no_tab: 0,
    session_lost: 0,
    rate_limited: 0,
    transient_http: 0,
    network: 0,
    malformed_response: 0,
  };
}

// Outcome of driving one platform tab.
//
//   "ok"           -- the listing was driven to its end. `request` carries the
//                     normalized conversations. `failures` tallies any
//                     per-conversation non-429 failures that were skipped over
//                     (drift signal, never fatal). `complete` is false only when
//                     the listing was paginated and a follow-up page remains
//                     (see the pagination seam below); `nextSince` carries the
//                     watermark the orchestrator passes back in to resume.
//   "rate_limited" -- a 429 (list OR conversation) short-circuited the run. The
//                     request carries whatever was collected BEFORE the 429
//                     (empty on a list-side 429, partial on a conversation-side
//                     429); retryAfterSeconds is the server-advised wait (null
//                     when no Retry-After header was present).
//   "failed"       -- a non-429 LIST failure (session lost, network, 5xx, or a
//                     malformed listing). The listing never produced summaries,
//                     so `request` is empty; `reason` is the mapped FailureReason
//                     the orchestrator branches on. This replaces the old
//                     silent-failure path that laundered a real list failure into
//                     an empty "ok" run.
//
// The orchestrator consumes this: on "ok" with complete=true it uploads and
// finishes; on "ok" with complete=false it uploads then schedules a follow-up
// wake with nextSince; on "rate_limited" it uploads the partial request then
// backs off; on "failed" it surfaces the reason (reconnect prompt, retry, etc.)
// instead of reporting a clean empty run.
export type CollectOutcome =
  | {
      status: "ok";
      request: IngestConversationRequest;
      complete: boolean;
      nextSince?: string;
      failures: FailureCounts;
    }
  | {
      status: "rate_limited";
      retryAfterSeconds: number | null;
      request: IngestConversationRequest;
    }
  | {
      status: "failed";
      reason: FailureReason;
      request: IngestConversationRequest;
    };

// Drives one platform tab through list -> fetch -> normalize and returns a
// CollectOutcome. Upload is intentionally NOT performed here (the orchestrator
// owns it). On the FIRST rate-limit (list or conversation) the run stops
// immediately -- no further CONVERSATION_REQUESTs are issued -- and the partial
// batch plus the backoff hint are returned so the orchestrator can upload what we
// have and then back off. A tab disconnect or a shape-mismatched response from a
// stale content script is mapped (in the request helpers above) to a structured
// failed/transient outcome, never an uncaught exception.
export async function collectFromTab(
  tabId: number,
  platform: AdapterPlatform,
  since?: string,
): Promise<CollectOutcome> {
  const listResult = await requestList(tabId, platform, since);
  const listOutcome = extractSummaries(listResult);
  if (listOutcome.status === "rate_limited") {
    return {
      status: "rate_limited",
      retryAfterSeconds: listOutcome.retryAfterSeconds,
      request: assembleIngestRequest(platform, []),
    };
  }
  if (listOutcome.status === "failed") {
    // A non-429 list failure is a real failure -- surface the typed reason
    // instead of laundering it into an empty "ok" run.
    return {
      status: "failed",
      reason: listOutcome.reason,
      request: assembleIngestRequest(platform, []),
    };
  }

  const raws: unknown[] = [];
  const failures = emptyFailureCounts();
  let conversationRetryAfterSeconds: number | null = null;
  let conversationRateLimited = false;
  for (const summary of listOutcome.summaries) {
    const conversationResult = await requestConversation(tabId, platform, summary.platform_id);
    const conversationOutcome = extractRaw(conversationResult);
    if (conversationOutcome.status === "rate_limited") {
      conversationRateLimited = true;
      conversationRetryAfterSeconds = conversationOutcome.retryAfterSeconds;
      break; // stop on the first 429; do not hammer the provider further
    }
    if (conversationOutcome.status === "ok") {
      raws.push(conversationOutcome.raw);
    } else {
      // A single non-429 failure (session lost / 5xx / network) never aborts the
      // run; record its reason so the orchestrator can spot drift across the run.
      failures[conversationOutcome.reason] += 1;
    }
  }

  const { conversations, skipped } = normalizeBatch(platform, raws);
  if (skipped > 0) {
    // A 2xx body that did not normalize is a malformed-response failure.
    failures.malformed_response += skipped;
    logger.warn("skipped malformed conversations", { platform, skipped });
  }
  const request = assembleIngestRequest(platform, conversations);

  if (conversationRateLimited) {
    return { status: "rate_limited", retryAfterSeconds: conversationRetryAfterSeconds, request };
  }

  // INTENTIONAL PHASE-2 SEAM (accepted, not a TODO): pagination is a connector
  // concern not yet wired. listConversationsRaw returns a flat summary array with
  // no cursor / hasMore, so a single LIST_RESULT is the complete listing and
  // `complete` is hardcoded true. The orchestrator's continuation path is
  // therefore DORMANT and stays dormant until the connectors expose pagination
  // state -- at which point this sets complete=false + nextSince and the
  // continuation wake activates. The outcome type already carries the fields so
  // the orchestrator can rely on them before the connector wiring lands; no
  // behavior change is implied by their presence today.
  return { status: "ok", request, complete: true, failures };
}

// Retry-After is optional on the wire (undefined when the header was absent);
// normalize to a clean number | null for the outcome contract.
function normalizeRetryAfter(retryAfterSeconds: number | undefined): number | null {
  return retryAfterSeconds ?? null;
}

type ListExtract =
  | { status: "ok"; summaries: ConversationSummary[] }
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "failed"; reason: FailureReason };

function extractSummaries(result: ListResultMessage): ListExtract {
  if (result.result.ok) return { status: "ok", summaries: result.result.summaries };
  if (result.result.reason === "rate_limited") {
    logger.warn("list rate limited", {
      platform: result.platform,
      retryAfterSeconds: result.result.retryAfterSeconds,
    });
    return {
      status: "rate_limited",
      retryAfterSeconds: normalizeRetryAfter(result.result.retryAfterSeconds),
    };
  }
  logger.warn("list failed", { platform: result.platform, reason: result.result.reason });
  // A non-429 list failure is a genuine failure (session lost, network, 5xx,
  // malformed listing) -- surface the typed reason rather than reporting an
  // empty-but-ok run that hides it.
  return { status: "failed", reason: result.result.reason };
}

type ConversationExtract =
  | { status: "ok"; raw: unknown }
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "failed"; reason: FailureReason };

function extractRaw(result: ConversationResultMessage): ConversationExtract {
  if (result.result.ok) return { status: "ok", raw: result.result.raw };
  if (result.result.reason === "rate_limited") {
    // Content-free logging: platform + reason + counts only, never the
    // conversationId (that is user-activity metadata).
    logger.warn("conversation fetch rate limited", {
      platform: result.platform,
      retryAfterSeconds: result.result.retryAfterSeconds,
    });
    return {
      status: "rate_limited",
      retryAfterSeconds: normalizeRetryAfter(result.result.retryAfterSeconds),
    };
  }
  logger.warn("conversation fetch failed", {
    platform: result.platform,
    reason: result.result.reason,
  });
  // Non-429 per-conversation failure: carry the reason up so the run can keep
  // going while still tallying the failure for drift detection.
  return { status: "failed", reason: result.result.reason };
}
