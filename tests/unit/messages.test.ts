import { describe, expect, it } from "vitest";

import { isExtensionMessage } from "../../src/lib/messages";

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
      isExtensionMessage({ type: "CONVERSATION_REQUEST", platform: "claude", conversationId: "c1" }),
    ).toBe(true);
  });

  it("accepts a CONVERSATION_RESULT message", () => {
    expect(
      isExtensionMessage({
        type: "CONVERSATION_RESULT",
        platform: "claude",
        conversationId: "c1",
        result: { ok: false, error: "boom" },
      }),
    ).toBe(true);
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
