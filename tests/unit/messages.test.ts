import { describe, expect, it } from "vitest";

import {
  isExtensionMessage,
  FAILURE_REASONS,
  SYNC_STATUS_STATES,
  type FailureReason,
  type SyncStatusState,
} from "../../src/lib/messages";

describe("isExtensionMessage", () => {
  it("accepts a LIST_REQUEST message", () => {
    expect(isExtensionMessage({ type: "LIST_REQUEST", platform: "chatgpt" })).toBe(true);
  });

  it("accepts a LIST_RESULT message", () => {
    expect(
      isExtensionMessage({
        type: "LIST_RESULT",
        platform: "chatgpt",
        result: { ok: true, summaries: [] },
      }),
    ).toBe(true);
  });

  it("accepts a CONVERSATION_REQUEST message", () => {
    expect(
      isExtensionMessage({
        type: "CONVERSATION_REQUEST",
        platform: "claude",
        conversationId: "c1",
      }),
    ).toBe(true);
  });

  it("accepts a CONVERSATION_RESULT message", () => {
    expect(
      isExtensionMessage({
        type: "CONVERSATION_RESULT",
        platform: "claude",
        conversationId: "c1",
        result: { ok: false, reason: "transient_http" },
      }),
    ).toBe(true);
  });

  it("accepts a STATUS_REQUEST message", () => {
    expect(isExtensionMessage({ type: "STATUS_REQUEST" })).toBe(true);
  });

  it("accepts a STATUS_RESULT message", () => {
    expect(isExtensionMessage({ type: "STATUS_RESULT", platform: "chatgpt", state: "idle" })).toBe(
      true,
    );
  });

  it("rejects an unknown message type", () => {
    expect(isExtensionMessage({ type: "NOT_A_MESSAGE" })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage("SYNC_START")).toBe(false);
    expect(isExtensionMessage(undefined)).toBe(false);
  });
});

describe("FailureReason envelope round-trip", () => {
  const reasons: FailureReason[] = [
    "no_tab",
    "session_lost",
    "rate_limited",
    "transient_http",
    "network",
    "malformed_response",
  ];

  it("exposes exactly the six declared reasons", () => {
    // Guards against a member being added to the union without updating the
    // runtime list (and vice versa).
    expect(new Set(FAILURE_REASONS)).toEqual(new Set(reasons));
    expect(FAILURE_REASONS).toHaveLength(reasons.length);
  });

  it.each(reasons)("round-trips a LIST_RESULT failure with reason %s", (reason) => {
    const message = { type: "LIST_RESULT", platform: "chatgpt", result: { ok: false, reason } };
    expect(isExtensionMessage(message)).toBe(true);
  });

  it.each(reasons)("round-trips a CONVERSATION_RESULT failure with reason %s", (reason) => {
    const message = {
      type: "CONVERSATION_RESULT",
      platform: "claude",
      conversationId: "c1",
      result: { ok: false, reason },
    };
    expect(isExtensionMessage(message)).toBe(true);
  });

  it("carries retryAfterSeconds only as an optional companion to rate_limited", () => {
    const message = {
      type: "LIST_RESULT",
      platform: "chatgpt",
      result: { ok: false, reason: "rate_limited", retryAfterSeconds: 30 },
    };
    expect(isExtensionMessage(message)).toBe(true);
  });
});

describe("SyncStatusState", () => {
  const states: SyncStatusState[] = ["idle", "syncing", "paused", "reconnect_required"];

  it("exposes exactly the four declared states", () => {
    expect(new Set(SYNC_STATUS_STATES)).toEqual(new Set(states));
    expect(SYNC_STATUS_STATES).toHaveLength(states.length);
  });

  it.each(states)("round-trips a STATUS_RESULT with state %s", (state) => {
    expect(isExtensionMessage({ type: "STATUS_RESULT", platform: "claude", state })).toBe(true);
  });
});
