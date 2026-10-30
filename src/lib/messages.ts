import type { Platform } from "./schema/ingest";
import type { ConversationSummary } from "./connectors/base";
import type { PairResult, UnpairResult } from "./auth";
import type { PauseState } from "./storage";

// Single message envelope for service-worker <-> content-script <-> popup
// communication. The control surface the extension pages use is documented at
// ControlMessage below. The "type" field is the discriminant. This module is types +
// a guard only; it intentionally pulls in no runtime third-party code so it is
// safe to import from content scripts (all schema/adapter imports are type-only
// and erased at build).
//
// The content script returns RAW platform JSON (unknown) -- it never normalizes
// or Zod-validates. Normalization happens in the background after a
// CONVERSATION_RESULT arrives, which is why CONVERSATION_RESULT carries
// `raw: unknown`, not a validated ConversationPayload.

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
//   org_ambiguous       -- the account has more than one chat-capable
//                          organization and none is chosen by guessing; sync
//                          stays paused until the account has exactly one
export type FailureReason =
  | "no_tab"
  | "session_lost"
  | "rate_limited"
  | "transient_http"
  | "network"
  | "malformed_response"
  | "org_ambiguous";

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
  org_ambiguous: true,
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

// ---- Control surface (popup / options / onboarding -> background) ----------
//
// Control messages are sent with chrome.runtime.sendMessage from an extension
// page. The background answers EVERY control message with exactly one response
// (ControlResponseMap below); none of them is a fire-and-forget event.
//
// Trust rule: the background rejects a control message sent from a tab (a
// content script; sender.tab is set) or from another extension (sender.id is not
// this extension's id) with { ok: false, reason: "forbidden_sender" }, and one
// whose payload does not match its type with "invalid_payload". Neither changes
// any state.
//
// Privacy rule: responses carry only the enumerated fields below. No token,
// raw platform or server response, exception text, or conversation id ever
// crosses this boundary.

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

// Manual "Sync now". Omit platform to sweep every enabled platform. Answered as
// soon as the run is started; progress is read back through STATUS_REQUEST.
export interface SyncStartMessage {
  type: "SYNC_START";
  platform?: Platform;
}

export interface StatusRequestMessage {
  type: "STATUS_REQUEST";
}

// Runs the interactive OAuth pairing in the background (the popup closes when
// the auth window opens). On success every platform marked reconnect_required
// returns to idle and a sync starts.
export interface PairStartMessage {
  type: "PAIR_START";
}

// Disconnect: revoke and clear the account's credentials and sync state.
export interface UnpairMessage {
  type: "UNPAIR";
}

// Per-platform sync switch. Turning a platform off stops future runs; a run
// already in flight finishes.
export interface SetPlatformEnabledMessage {
  type: "SET_PLATFORM_ENABLED";
  platform: Platform;
  enabled: boolean;
}

export type ControlMessage =
  | SyncStartMessage
  | StatusRequestMessage
  | PairStartMessage
  | UnpairMessage
  | SetPlatformEnabledMessage;

export type ControlErrorReason = "forbidden_sender" | "invalid_payload" | "internal";

export interface ControlError {
  ok: false;
  reason: ControlErrorReason;
}

export interface ControlOk {
  ok: true;
}

//   none               -- never paired, or disconnected
//   ok                 -- paired and no definitive token rejection seen
//   reconnect_required -- the token was definitively rejected (stored on the
//                         credentials or on any platform); show "Reconnect"
export type AuthState = "none" | "ok" | "reconnect_required";

export type PauseReason = PauseState["reason"];

// Timestamps are ISO-8601 strings. pausedUntil and pauseReason are null unless a
// backoff window is still running; an expired pause reads as null.
export interface PlatformStatus {
  platform: Platform;
  enabled: boolean;
  status: SyncStatusState;
  pausedUntil: string | null;
  pauseReason: PauseReason | null;
  lastRunAt: string | null;
}

// nextSyncAt is the earliest scheduled sync wake (periodic or continuation), or
// null when none is scheduled or the alarm read failed.
export interface StatusSnapshot {
  ok: true;
  auth: AuthState;
  platforms: PlatformStatus[];
  nextSyncAt: string | null;
}

export interface ControlResponseMap {
  SYNC_START: ControlOk | ControlError;
  STATUS_REQUEST: StatusSnapshot | ControlError;
  PAIR_START: PairResult | ControlError;
  UNPAIR: UnpairResult | ControlError;
  SET_PLATFORM_ENABLED: ControlOk | ControlError;
}

export type ControlResponse<T extends ControlMessage["type"] = ControlMessage["type"]> =
  ControlResponseMap[T];

const CONTROL_MESSAGE_TYPE_PRESENCE: Record<ControlMessage["type"], true> = {
  SYNC_START: true,
  STATUS_REQUEST: true,
  PAIR_START: true,
  UNPAIR: true,
  SET_PLATFORM_ENABLED: true,
};

const CONTROL_MESSAGE_TYPES = new Set<string>(Object.keys(CONTROL_MESSAGE_TYPE_PRESENCE));

// True when value claims a control type. Says nothing about the payload or the
// sender; the background validates both before acting.
export function isControlMessageType(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && CONTROL_MESSAGE_TYPES.has(type);
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
  | PairStartMessage
  | UnpairMessage
  | SetPlatformEnabledMessage;

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
  PAIR_START: true,
  UNPAIR: true,
  SET_PLATFORM_ENABLED: true,
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
