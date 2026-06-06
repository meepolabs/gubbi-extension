import type {
  ConversationSummary,
  RawFetchOutcome,
} from "./base";
import type { ListOutcome, ConversationOutcome } from "../messages";

// Content-safe mappers from a RawFetchOutcome to the message-envelope outcome
// types. Shared by both content scripts so the mapping lives in one place.
//
// CONTENT-SCRIPT ISOLATION: no third-party imports here (the message/base
// imports are type-only and erased at build).

function rateLimitedOutcome(
  retryAfterSeconds: number | undefined,
): { ok: false; rateLimited: true; retryAfterSeconds?: number } {
  return retryAfterSeconds === undefined
    ? { ok: false, rateLimited: true }
    : { ok: false, rateLimited: true, retryAfterSeconds };
}

export function toListOutcome(raw: RawFetchOutcome<ConversationSummary[]>): ListOutcome {
  switch (raw.status) {
    case "ok":
      return { ok: true, summaries: raw.data };
    case "rate_limited":
      return rateLimitedOutcome(raw.retryAfterSeconds);
    case "error":
      return { ok: false, error: raw.error };
  }
}

export function toConversationOutcome(raw: RawFetchOutcome<unknown>): ConversationOutcome {
  switch (raw.status) {
    case "ok":
      return { ok: true, raw: raw.data };
    case "rate_limited":
      return rateLimitedOutcome(raw.retryAfterSeconds);
    case "error":
      return { ok: false, error: raw.error };
  }
}
