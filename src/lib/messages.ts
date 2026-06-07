import type { Platform } from "./schema/ingest";
import type { ConversationSummary } from "./connectors/base";

// Single message envelope for service-worker <-> content-script <-> popup
// communication. The "type" field is the discriminant. This module is types +
// a guard only; it intentionally pulls in no runtime third-party code so it is
// safe to import from content scripts (all schema/adapter imports are type-only
// and erased at build).
//
// The content script returns RAW platform JSON (unknown) -- it never normalizes
// or Zod-validates. Normalization happens in the background after a
// CONVERSATION_RESULT arrives, which is why CONVERSATION_RESULT carries
// `raw: unknown`, not a validated ConversationPayload.

export interface SyncStartMessage {
  type: "SYNC_START";
  platform?: Platform;
}

export interface SyncProgressMessage {
  type: "SYNC_PROGRESS";
  platform: Platform;
  processed: number;
  total: number;
}

export interface SyncDoneMessage {
  type: "SYNC_DONE";
  platform: Platform;
  uploaded: number;
}

export interface SyncErrorMessage {
  type: "SYNC_ERROR";
  platform?: Platform;
  message: string;
}

// Typed failure-reason union for every non-success outcome the orchestrator may
// see. Replaces the old free-text `error: string` dead-end so the orchestrator
// can branch on a stable, exhaustive set of reasons rather than parse prose.
//
//   no_tab              -- no eligible platform tab to drive the fetch.
//                          ORCHESTRATOR-INTERNAL: this reason is produced by the
//                          orchestrator (when findTab returns null) and never
//                          crosses the content<->background message boundary -- a
//                          content script cannot report "no tab". It is kept in
//                          this one union (rather than split out) so the
//                          orchestrator has a single FailureReason vocabulary; the
//                          minor churn of splitting it is not worth it.
//   session_lost        -- the platform session is gone (401/403, or the
//                          fetcher reported no active session)
//   rate_limited        -- HTTP 429; retryAfterSeconds carries the advised wait
//   transient_http      -- any other non-2xx response, retryable
//   network             -- the request never completed (offline, DNS, redirect)
//   malformed_response  -- a 2xx body that was not the expected shape
export type FailureReason =
  | "no_tab"
  | "session_lost"
  | "rate_limited"
  | "transient_http"
  | "network"
  | "malformed_response";

// Runtime mirror of the FailureReason union. The Record below makes adding a
// member to the union without listing it here a tsc error, so this list stays
// exhaustive; tests assert the two stay in sync.
const FAILURE_REASON_PRESENCE: Record<FailureReason, true> = {
  no_tab: true,
  session_lost: true,
  rate_limited: true,
  transient_http: true,
  network: true,
  malformed_response: true,
};

export const FAILURE_REASONS: readonly FailureReason[] = Object.keys(
  FAILURE_REASON_PRESENCE,
) as FailureReason[];

// SHAPE DECISION: rate-limiting is folded INTO FailureReason rather than kept as
// a separate `rateLimited` boolean discriminant. The failure variant is a single
// shape: `{ ok: false; reason; retryAfterSeconds? }`. retryAfterSeconds is the
// server-advised back-off and is only meaningful when reason === "rate_limited"
// (undefined otherwise). messages.ts is the single source of truth for this
// shape; no free-text `error` field exists on the wire.
export interface OutcomeFailure {
  ok: false;
  reason: FailureReason;
  retryAfterSeconds?: number;
}

// LIST_* drives the content fetcher's listConversationsRaw: the content script
// returns a page of lightweight summaries (raw, already plain JSON).
export interface ListRequestMessage {
  type: "LIST_REQUEST";
  platform: Platform;
  since?: string;
}

export type ListOutcome = { ok: true; summaries: ConversationSummary[] } | OutcomeFailure;

export interface ListResultMessage {
  type: "LIST_RESULT";
  platform: Platform;
  result: ListOutcome;
}

// CONVERSATION_* drives the content fetcher's fetchConversationRaw: the content
// script returns one conversation's RAW platform JSON (unknown). The background
// normalizes + Zod-validates it; the content script never does.
export interface ConversationRequestMessage {
  type: "CONVERSATION_REQUEST";
  platform: Platform;
  conversationId: string;
}

export type ConversationOutcome = { ok: true; raw: unknown } | OutcomeFailure;

export interface ConversationResultMessage {
  type: "CONVERSATION_RESULT";
  platform: Platform;
  conversationId: string;
  result: ConversationOutcome;
}

// STATUS_* lets the popup poll the background for the current per-platform sync
// state. STATUS_REQUEST is a bare ping; STATUS_RESULT carries the popup-facing
// state. SyncStatusState is intentionally a small, presentation-oriented union
// (not the orchestrator's internal machine state) -- it is what the popup
// renders, so it changes on UX needs, not on internal control-flow churn.
export type SyncStatusState = "idle" | "syncing" | "paused" | "reconnect_required";

const SYNC_STATUS_STATE_PRESENCE: Record<SyncStatusState, true> = {
  idle: true,
  syncing: true,
  paused: true,
  reconnect_required: true,
};

export const SYNC_STATUS_STATES: readonly SyncStatusState[] = Object.keys(
  SYNC_STATUS_STATE_PRESENCE,
) as SyncStatusState[];

export interface StatusRequestMessage {
  type: "STATUS_REQUEST";
}

export interface StatusResultMessage {
  type: "STATUS_RESULT";
  platform: Platform;
  state: SyncStatusState;
}

export type ExtensionMessage =
  | SyncStartMessage
  | SyncProgressMessage
  | SyncDoneMessage
  | SyncErrorMessage
  | ListRequestMessage
  | ListResultMessage
  | ConversationRequestMessage
  | ConversationResultMessage
  | StatusRequestMessage
  | StatusResultMessage;

// Compile-time exhaustiveness: a Record keyed by the discriminant union requires
// exactly one entry per message type, so adding a member to ExtensionMessage
// without listing it here is a tsc error. The runtime Set is derived from its
// keys.
const MESSAGE_TYPE_PRESENCE: Record<ExtensionMessage["type"], true> = {
  SYNC_START: true,
  SYNC_PROGRESS: true,
  SYNC_DONE: true,
  SYNC_ERROR: true,
  LIST_REQUEST: true,
  LIST_RESULT: true,
  CONVERSATION_REQUEST: true,
  CONVERSATION_RESULT: true,
  STATUS_REQUEST: true,
  STATUS_RESULT: true,
};

const MESSAGE_TYPES = new Set<ExtensionMessage["type"]>(
  Object.keys(MESSAGE_TYPE_PRESENCE) as ExtensionMessage["type"][],
);

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown };
  return (
    typeof candidate.type === "string" &&
    MESSAGE_TYPES.has(candidate.type as ExtensionMessage["type"])
  );
}
