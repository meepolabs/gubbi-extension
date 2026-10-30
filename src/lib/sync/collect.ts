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
import { timestampMs } from "./timestamps";

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

// Per-reason tally of the per-conversation failures a run skipped over (today
// only malformed_response; a retryable failure stops the run instead), so the
// orchestrator can detect connector drift. Every FailureReason is present (zero
// when unseen) so callers can index without an undefined check.
export type FailureCounts = Record<FailureReason, number>;

function emptyFailureCounts(): FailureCounts {
  return {
    no_tab: 0,
    session_lost: 0,
    rate_limited: 0,
    transient_http: 0,
    network: 0,
    malformed_response: 0,
    org_ambiguous: 0,
  };
}

// Outcome of driving one platform tab.
//
//   "ok"           -- the listing was driven to its end. `request` carries the
//                     normalized conversations. `failures` tallies the
//                     malformed conversations that were skipped over (drift
//                     signal, never fatal). `complete` is false only when
//                     the listing was paginated and a follow-up page remains
//                     (see the pagination seam below); `nextSince` carries the
//                     watermark the orchestrator passes back in to resume.
//   "rate_limited" -- a 429 (list OR conversation) short-circuited the run. The
//                     request carries whatever was collected BEFORE the 429
//                     (empty on a list-side 429; on a conversation-side 429, an
//                     oldest-first prefix of the listing, see detailOrder);
//                     retryAfterSeconds is the server-advised wait (null when no
//                     Retry-After header was present).
//   "failed"       -- a non-429 LIST failure (session lost, network, 5xx, or a
//                     malformed listing), with an empty `request`; or a
//                     retryable non-429 CONVERSATION failure (session lost,
//                     network, 5xx), with the oldest-first prefix collected
//                     before it. `reason` is the mapped FailureReason the
//                     orchestrator branches on.
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
// owns it). Detail is fetched oldest first whatever order the platform lists in.
// On the FIRST rate-limit (list or conversation), or the first retryable
// conversation failure, the run stops immediately -- no further
// CONVERSATION_REQUESTs are issued -- and the partial batch is returned so the
// orchestrator can upload what we have and then back off. A tab disconnect or a shape-mismatched response from a
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
  let stop: DetailStop | null = null;
  for (const summary of detailOrder(listOutcome.summaries)) {
    const conversationResult = await requestConversation(tabId, platform, summary.platform_id);
    const conversationOutcome = extractRaw(conversationResult);
    if (conversationOutcome.status === "ok") {
      raws.push(conversationOutcome.raw);
    } else if (
      conversationOutcome.status === "failed" &&
      conversationOutcome.reason === "malformed_response"
    ) {
      // Retrying cannot fix a body the content script could not shape; count it
      // as drift and move on rather than wedging the run on one conversation.
      failures.malformed_response += 1;
    } else {
      // Any other failure is retryable. Detail runs oldest first, so stopping
      // here leaves an oldest prefix and the cursor never passes this one.
      stop = conversationOutcome;
      break;
    }
  }

  const { conversations, skipped } = normalizeBatch(platform, raws);
  if (skipped > 0) {
    // A 2xx body that did not normalize is a malformed-response failure.
    failures.malformed_response += skipped;
    logger.warn("skipped malformed conversations", { platform, skipped });
  }
  const request = assembleIngestRequest(platform, conversations);

  if (stop?.status === "rate_limited") {
    return { status: "rate_limited", retryAfterSeconds: stop.retryAfterSeconds, request };
  }
  if (stop?.status === "failed") {
    return { status: "failed", reason: stop.reason, request };
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

// The orchestrator commits the newest watermark it uploaded, so a run cut short
// by a 429 or a retryable failure must have collected an oldest prefix: otherwise the cursor jumps past
// the older conversations that were never fetched and they are never re-listed.
// A missing or unparseable updated_at sorts first, so it can never be the one
// left behind; ties keep list order (Array.prototype.sort is stable).
function detailOrder(summaries: readonly ConversationSummary[]): ConversationSummary[] {
  return [...summaries].sort((a, b) => listedAtMs(a) - listedAtMs(b));
}

function listedAtMs(summary: ConversationSummary): number {
  if (summary.updated_at === null) return Number.NEGATIVE_INFINITY;
  const ms = timestampMs(summary.updated_at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
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

type DetailStop = Exclude<ConversationExtract, { status: "ok" }>;

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
  return { status: "failed", reason: result.result.reason };
}
