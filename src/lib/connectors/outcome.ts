import type { ConversationSummary, RawFetchOutcome } from "./base";
import type { ListOutcome, ConversationOutcome, FailureReason, OutcomeFailure } from "../messages";
import { HTTP_FORBIDDEN, HTTP_UNAUTHORIZED } from "../net/http-constants";

// Content-safe mappers from a RawFetchOutcome to the message-envelope outcome
// types. Shared by both content scripts so the mapping lives in one place.
//
// CONTENT-SCRIPT ISOLATION: no third-party imports here (the message/base
// imports are type-only and erased at build; http-constants is a plain const
// module with no runtime dependencies).

// HTTP markers the raw fetchers (http.ts failureFromResponse) embed in error
// strings. 401/403 mean the session is gone; any other non-2xx is a retryable
// transient. These are the exact codes the per-platform fetchers can surface.

// classifyError maps a deterministic, first-party error string (produced only by
// http.ts and the per-platform fetch.ts -- never user input) to a FailureReason.
// RawFetchOutcome's `error` variant carries no structured reason, so the markers
// it embeds are the only signal available at this boundary; matching them here
// keeps the classification in one content-safe place. An unrecognized string
// falls back to transient_http (retryable) rather than guessing a terminal
// reason.
function classifyError(error: string): FailureReason {
  if (error.includes("network request failed")) return "network";
  if (error.includes("no active") && error.includes("session")) return "session_lost";
  const statusReason = classifyHttpStatus(error);
  if (statusReason !== null) return statusReason;
  if (
    error.includes("not valid JSON") ||
    error.includes("unexpected") ||
    error.includes("response shape")
  ) {
    return "malformed_response";
  }
  return "transient_http";
}

// failureFromResponse emits "request failed with status <n>"; recover the code.
function classifyHttpStatus(error: string): FailureReason | null {
  const match = /status (\d{3})/.exec(error);
  if (match === null) return null;
  const status = Number(match[1]);
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return "session_lost";
  return "transient_http";
}

function rateLimitedFailure(retryAfterSeconds: number | undefined): OutcomeFailure {
  return retryAfterSeconds === undefined
    ? { ok: false, reason: "rate_limited" }
    : { ok: false, reason: "rate_limited", retryAfterSeconds };
}

// Maps the failure side of any RawFetchOutcome to the typed OutcomeFailure. The
// success side differs per outcome type, so callers handle "ok" themselves.
export function toFailure(
  raw: Extract<RawFetchOutcome<unknown>, { status: "rate_limited" | "error" }>,
): OutcomeFailure {
  if (raw.status === "rate_limited") return rateLimitedFailure(raw.retryAfterSeconds);
  return { ok: false, reason: classifyError(raw.error) };
}

export function toListOutcome(raw: RawFetchOutcome<ConversationSummary[]>): ListOutcome {
  if (raw.status === "ok") return { ok: true, summaries: raw.data };
  return toFailure(raw);
}

export function toConversationOutcome(raw: RawFetchOutcome<unknown>): ConversationOutcome {
  if (raw.status === "ok") return { ok: true, raw: raw.data };
  return toFailure(raw);
}
