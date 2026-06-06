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
} from "../messages";
import type { ConversationSummary } from "../connectors/base";

// Background-side sync orchestration seam (Phase 1b scope: enough to drive one
// platform tab end to end). Lease acquisition, scheduling, batching, and upload
// land in a later milestone (05.08 / 05.09); this module is the clean seam they
// will build on. BACKGROUND/LIB ONLY (it reaches the Zod normalizers).

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
export function normalizeBatch(platform: AdapterPlatform, raws: readonly unknown[]): NormalizeBatchResult {
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
// enforced at the upload layer (05.09); this just sets source + payloads.
export function assembleIngestRequest(
  platform: AdapterPlatform,
  conversations: ConversationPayload[],
): IngestConversationRequest {
  return { source: PLATFORM_TO_SOURCE[platform], conversations };
}

// Thin messaging helpers. chrome.tabs.sendMessage resolves with the content
// script's response; a missing/closed tab rejects, which the caller maps to a
// failed outcome.
function requestList(
  tabId: number,
  platform: AdapterPlatform,
  since?: string,
): Promise<ListResultMessage> {
  const message: ListRequestMessage =
    since === undefined
      ? { type: "LIST_REQUEST", platform }
      : { type: "LIST_REQUEST", platform, since };
  return chrome.tabs.sendMessage(tabId, message) as Promise<ListResultMessage>;
}

function requestConversation(
  tabId: number,
  platform: AdapterPlatform,
  conversationId: string,
): Promise<ConversationResultMessage> {
  const message: ConversationRequestMessage = {
    type: "CONVERSATION_REQUEST",
    platform,
    conversationId,
  };
  return chrome.tabs.sendMessage(tabId, message) as Promise<ConversationResultMessage>;
}

// Outcome of driving one platform tab. A successful run yields the full
// assembled request. A 429 anywhere (list OR conversation) short-circuits the
// run and preserves the backoff signal: the request carries whatever
// conversations were collected BEFORE the 429 (empty on a list-side 429, a
// partial batch on a conversation-side 429), and retryAfterSeconds carries the
// server-advised wait (null when no Retry-After header was present). The 05.08
// scheduler consumes this: on "ok" it uploads and continues; on "rate_limited"
// it uploads the partial request, then backs off for retryAfterSeconds before
// resuming.
export type CollectOutcome =
  | { status: "ok"; request: IngestConversationRequest }
  | {
      status: "rate_limited";
      retryAfterSeconds: number | null;
      request: IngestConversationRequest;
    };

// Drives one platform tab through list -> fetch -> normalize and returns a
// CollectOutcome. Upload is intentionally NOT performed here (05.09). On the
// FIRST rate-limit (list or conversation) the run stops immediately -- no
// further CONVERSATION_REQUESTs are issued -- and the partial batch plus the
// backoff hint are returned so the orchestrator can upload what we have and then
// back off.
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

  const raws: unknown[] = [];
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
    if (conversationOutcome.status === "ok") raws.push(conversationOutcome.raw);
    // status "skip" (parse failure / non-429 error): counted via normalizeBatch
    // skip below, not collected. Keep going.
  }

  const { conversations, skipped } = normalizeBatch(platform, raws);
  if (skipped > 0) logger.warn("skipped malformed conversations", { platform, skipped });
  const request = assembleIngestRequest(platform, conversations);

  return conversationRateLimited
    ? { status: "rate_limited", retryAfterSeconds: conversationRetryAfterSeconds, request }
    : { status: "ok", request };
}

// Retry-After is optional on the wire (undefined when the header was absent);
// normalize to a clean number | null for the outcome contract.
function normalizeRetryAfter(retryAfterSeconds: number | undefined): number | null {
  return retryAfterSeconds ?? null;
}

type ListExtract =
  | { status: "ok"; summaries: ConversationSummary[] }
  | { status: "rate_limited"; retryAfterSeconds: number | null };

function extractSummaries(result: ListResultMessage): ListExtract {
  if (result.result.ok) return { status: "ok", summaries: result.result.summaries };
  if (result.result.rateLimited) {
    logger.warn("list rate limited", {
      platform: result.platform,
      retryAfterSeconds: result.result.retryAfterSeconds,
    });
    return {
      status: "rate_limited",
      retryAfterSeconds: normalizeRetryAfter(result.result.retryAfterSeconds),
    };
  }
  logger.warn("list failed", { platform: result.platform, error: result.result.error });
  // A non-429 list failure yields no summaries; treat as an empty (ok) list so
  // the run completes cleanly with zero conversations rather than backing off.
  return { status: "ok", summaries: [] };
}

type ConversationExtract =
  | { status: "ok"; raw: unknown }
  | { status: "rate_limited"; retryAfterSeconds: number | null }
  | { status: "skip" };

function extractRaw(result: ConversationResultMessage): ConversationExtract {
  if (result.result.ok) return { status: "ok", raw: result.result.raw };
  if (result.result.rateLimited) {
    logger.warn("conversation fetch rate limited", {
      platform: result.platform,
      conversationId: result.conversationId,
      retryAfterSeconds: result.result.retryAfterSeconds,
    });
    return {
      status: "rate_limited",
      retryAfterSeconds: normalizeRetryAfter(result.result.retryAfterSeconds),
    };
  }
  logger.warn("conversation fetch failed", {
    platform: result.platform,
    conversationId: result.conversationId,
    error: result.result.error,
  });
  return { status: "skip" };
}
