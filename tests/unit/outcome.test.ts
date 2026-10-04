import { describe, expect, it } from "vitest";

import type { ConversationSummary, RawFetchOutcome } from "../../src/lib/connectors/base";
import { toListOutcome, toConversationOutcome } from "../../src/lib/connectors/outcome";
import type { FailureReason } from "../../src/lib/messages";

// The raw fetchers emit deterministic, first-party error strings (see http.ts
// and the per-platform fetch.ts). The mapper classifies those stable markers
// into a typed FailureReason; these tests pin each marker to its reason.

const summaries: ConversationSummary[] = [{ platform_id: "p1", title: "t", updated_at: null }];

describe("toListOutcome", () => {
  it("maps an ok outcome to a success variant", () => {
    const outcome = toListOutcome({ status: "ok", data: summaries });
    expect(outcome).toEqual({ ok: true, summaries });
  });

  it("maps rate_limited to reason rate_limited without retryAfterSeconds", () => {
    const outcome = toListOutcome({ status: "rate_limited" });
    expect(outcome).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("maps rate_limited with a server-advised wait through retryAfterSeconds", () => {
    const outcome = toListOutcome({ status: "rate_limited", retryAfterSeconds: 42 });
    expect(outcome).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 42 });
  });
});

describe("toConversationOutcome", () => {
  it("maps an ok outcome to a success variant carrying raw", () => {
    const outcome = toConversationOutcome({ status: "ok", data: { id: 1 } });
    expect(outcome).toEqual({ ok: true, raw: { id: 1 } });
  });

  it("maps rate_limited to reason rate_limited", () => {
    const outcome = toConversationOutcome({ status: "rate_limited", retryAfterSeconds: 7 });
    expect(outcome).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 7 });
  });
});

// error-string -> FailureReason classification. The error markers below are the
// exact strings produced by the raw fetchers; if those change the mapping must
// follow, so the strings live here verbatim.
const errorCases: ReadonlyArray<[string, FailureReason]> = [
  ["no active ChatGPT session (missing accessToken)", "session_lost"],
  ["no active Claude session (no chat-capable organization)", "session_lost"],
  ["request failed with status 401", "session_lost"],
  ["request failed with status 403", "session_lost"],
  ["request failed with status 500", "transient_http"],
  ["request failed with status 502", "transient_http"],
  ["network request failed: Failed to fetch", "network"],
  ["network request failed", "network"],
  ["response body was not valid JSON", "malformed_response"],
  ["unexpected session response shape", "malformed_response"],
];

describe("error-string classification", () => {
  it.each(errorCases)("maps list error %s to %s", (error, reason) => {
    const outcome = toListOutcome({ status: "error", error });
    expect(outcome).toEqual({ ok: false, reason });
  });

  it.each(errorCases)("maps conversation error %s to %s", (error, reason) => {
    const outcome = toConversationOutcome({ status: "error", error });
    expect(outcome).toEqual({ ok: false, reason });
  });

  it("falls back to transient_http for an unrecognized error string", () => {
    const outcome = toListOutcome({ status: "error", error: "totally opaque failure" });
    expect(outcome).toEqual({ ok: false, reason: "transient_http" });
  });
});

// Type-level guard: the failure variant must NOT carry a free-text error field.
// This is compile-time only; the runtime assertion below documents the intent.
describe("failure variant carries no free-text error", () => {
  it("omits an error field on a mapped failure", () => {
    const outcome: RawFetchOutcome<ConversationSummary[]> = {
      status: "error",
      error: "request failed with status 503",
    };
    const mapped = toListOutcome(outcome);
    expect("error" in mapped).toBe(false);
  });
});
