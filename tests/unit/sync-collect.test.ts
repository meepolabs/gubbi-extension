import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestConversationRequestSchema } from "../../src/lib/schema/ingest";
import { assembleIngestRequest, collectFromTab, normalizeBatch } from "../../src/lib/sync/collect";
import type {
  ListResultMessage,
  ConversationResultMessage,
  ListRequestMessage,
  ConversationRequestMessage,
  FailureReason,
} from "../../src/lib/messages";

import rawChatGpt from "../fixtures/raw-chatgpt-conversation.json";
import rawClaude from "../fixtures/raw-claude-conversation.json";

describe("normalizeBatch", () => {
  it("normalizes valid raws and counts malformed ones as skipped", () => {
    // Arrange: one valid ChatGPT conversation plus two unsalvageable inputs.
    const raws = [structuredClone(rawChatGpt), { not: "a conversation" }, null];

    // Act
    const { conversations, skipped } = normalizeBatch("chatgpt", raws);

    // Assert
    expect(conversations).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("routes claude raws through the claude normalizer", () => {
    // Arrange
    const raws = [structuredClone(rawClaude)];

    // Act
    const { conversations, skipped } = normalizeBatch("claude", raws);

    // Assert
    expect(skipped).toBe(0);
    expect(conversations[0]!.platform).toBe("claude");
  });
});

describe("assembleIngestRequest", () => {
  it("sets the extension_chatgpt source for the chatgpt platform", () => {
    // Arrange
    const { conversations } = normalizeBatch("chatgpt", [structuredClone(rawChatGpt)]);

    // Act
    const request = assembleIngestRequest("chatgpt", conversations);

    // Assert
    expect(request.source).toBe("extension_chatgpt");
    expect(IngestConversationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("sets the extension_claude source for the claude platform", () => {
    // Arrange
    const { conversations } = normalizeBatch("claude", [structuredClone(rawClaude)]);

    // Act
    const request = assembleIngestRequest("claude", conversations);

    // Assert
    expect(request.source).toBe("extension_claude");
    expect(IngestConversationRequestSchema.safeParse(request).success).toBe(true);
  });
});

// collectFromTab drives one tab via chrome.tabs.sendMessage. The stub routes by
// message type (LIST_REQUEST vs CONVERSATION_REQUEST) and lets each test script
// the per-call responses, so we can assert the 429-honoring control flow.
const TAB_ID = 7;

interface RoutedResponses {
  list: ListResultMessage;
  conversationById: Record<string, ConversationResultMessage>;
}

function okList(platformIds: string[]): ListResultMessage {
  return {
    type: "LIST_RESULT",
    platform: "chatgpt",
    result: {
      ok: true,
      summaries: platformIds.map((id) => ({ platform_id: id, title: id, updated_at: null })),
    },
  };
}

function rateLimitedList(retryAfterSeconds?: number): ListResultMessage {
  return {
    type: "LIST_RESULT",
    platform: "chatgpt",
    result:
      retryAfterSeconds === undefined
        ? { ok: false, reason: "rate_limited" }
        : { ok: false, reason: "rate_limited", retryAfterSeconds },
  };
}

function failedList(reason: Exclude<FailureReason, "rate_limited">): ListResultMessage {
  return {
    type: "LIST_RESULT",
    platform: "chatgpt",
    result: { ok: false, reason },
  };
}

function failedConversation(
  conversationId: string,
  reason: Exclude<FailureReason, "rate_limited">,
): ConversationResultMessage {
  return {
    type: "CONVERSATION_RESULT",
    platform: "chatgpt",
    conversationId,
    result: { ok: false, reason },
  };
}

function okConversation(conversationId: string, raw: unknown): ConversationResultMessage {
  return {
    type: "CONVERSATION_RESULT",
    platform: "chatgpt",
    conversationId,
    result: { ok: true, raw },
  };
}

function rateLimitedConversation(
  conversationId: string,
  retryAfterSeconds?: number,
): ConversationResultMessage {
  return {
    type: "CONVERSATION_RESULT",
    platform: "chatgpt",
    conversationId,
    result:
      retryAfterSeconds === undefined
        ? { ok: false, reason: "rate_limited" }
        : { ok: false, reason: "rate_limited", retryAfterSeconds },
  };
}

// Returns the spy so each test can assert how many CONVERSATION_REQUESTs were issued.
function stubTab(responses: RoutedResponses): ReturnType<typeof vi.fn> {
  const sendMessage = vi.fn(
    async (_tabId: number, message: ListRequestMessage | ConversationRequestMessage) => {
      if (message.type === "LIST_REQUEST") return responses.list;
      return responses.conversationById[message.conversationId];
    },
  );
  vi.stubGlobal("chrome", { tabs: { sendMessage } });
  return sendMessage;
}

function conversationRequestCount(spy: ReturnType<typeof vi.fn>): number {
  return spy.mock.calls.filter(([, message]) => message.type === "CONVERSATION_REQUEST").length;
}

describe("collectFromTab", () => {
  beforeEach(() => {
    // Silence the deliberate warn emitted on rate-limit / skip paths.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns status ok with the full batch on the happy path", async () => {
    // Arrange: two summaries, both fetch cleanly into valid conversations.
    const spy = stubTab({
      list: okList(["c1", "c2"]),
      conversationById: {
        c1: okConversation("c1", structuredClone(rawChatGpt)),
        c2: okConversation("c2", {
          ...structuredClone(rawChatGpt),
          conversation_id: "chatgpt-conv-0002",
        }),
      },
    });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.request.conversations).toHaveLength(2);
      expect(outcome.complete).toBe(true);
    }
    expect(conversationRequestCount(spy)).toBe(2);
  });

  it("surfaces a non-429 list failure as the failed variant with the mapped reason", async () => {
    // Arrange: the list call reports a lost session (401/403-class). This must
    // NOT be laundered into an empty-ok run -- it is a real failure.
    const spy = stubTab({ list: failedList("session_lost"), conversationById: {} });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toBe("session_lost");
      expect(outcome.request.conversations).toHaveLength(0);
    }
    // No summaries were ever obtained, so no conversation fetches were issued.
    expect(conversationRequestCount(spy)).toBe(0);
  });

  it("maps a network-class list failure to the failed variant", async () => {
    // Arrange
    stubTab({ list: failedList("network"), conversationById: {} });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.reason).toBe("network");
  });

  it("continues past a single non-429 conversation failure and reports it by reason", async () => {
    // Arrange: three summaries; the second conversation fetch fails (session
    // lost) but the run continues and collects c1 and c3.
    const spy = stubTab({
      list: okList(["c1", "c2", "c3"]),
      conversationById: {
        c1: okConversation("c1", structuredClone(rawChatGpt)),
        c2: failedConversation("c2", "session_lost"),
        c3: okConversation("c3", {
          ...structuredClone(rawChatGpt),
          conversation_id: "chatgpt-conv-0003",
        }),
      },
    });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert: run completes ok with the two good conversations; the failed one
    // is counted under its reason so the orchestrator can detect drift.
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.request.conversations).toHaveLength(2);
      expect(outcome.complete).toBe(true);
      expect(outcome.failures.session_lost).toBe(1);
    }
    expect(conversationRequestCount(spy)).toBe(3); // all three attempted
  });

  it("stops on a list 429: status rate_limited, retryAfter propagated, zero conversation requests", async () => {
    // Arrange
    const spy = stubTab({ list: rateLimitedList(42), conversationById: {} });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("rate_limited");
    if (outcome.status === "rate_limited") {
      expect(outcome.retryAfterSeconds).toBe(42);
      expect(outcome.request.conversations).toHaveLength(0);
    }
    expect(conversationRequestCount(spy)).toBe(0);
  });

  it("carries null retryAfter when a list 429 has no Retry-After header", async () => {
    // Arrange
    stubTab({ list: rateLimitedList(), conversationById: {} });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("rate_limited");
    if (outcome.status === "rate_limited") expect(outcome.retryAfterSeconds).toBeNull();
  });

  it("stops on a conversation 429 mid-loop: rate_limited with the partial batch + retryAfter", async () => {
    // Arrange: three summaries; the second conversation fetch 429s, so the third
    // is never requested and only the first conversation is collected.
    const spy = stubTab({
      list: okList(["c1", "c2", "c3"]),
      conversationById: {
        c1: okConversation("c1", structuredClone(rawChatGpt)),
        c2: rateLimitedConversation("c2", 13),
        c3: okConversation("c3", {
          ...structuredClone(rawChatGpt),
          conversation_id: "chatgpt-conv-0003",
        }),
      },
    });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("rate_limited");
    if (outcome.status === "rate_limited") {
      expect(outcome.retryAfterSeconds).toBe(13);
      expect(outcome.request.conversations).toHaveLength(1); // only c1, collected before the 429
    }
    expect(conversationRequestCount(spy)).toBe(2); // c1 then c2; c3 never requested
  });

  it("maps a sendMessage rejection on the list call to failed{transient_http}, not a throw", async () => {
    // Arrange: a closed/listener-less tab makes chrome.tabs.sendMessage reject
    // with "Could not establish connection". collectFromTab must NOT throw.
    const sendMessage = vi.fn(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    vi.stubGlobal("chrome", { tabs: { sendMessage } });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toBe("transient_http");
      expect(outcome.request.conversations).toHaveLength(0);
    }
  });

  it("maps a shape-mismatched list response to failed{malformed_response}", async () => {
    // Arrange: a stale content script answers with an old/foreign envelope shape.
    const sendMessage = vi.fn(async () => ({ type: "WRONG", payload: 1 }));
    vi.stubGlobal("chrome", { tabs: { sendMessage } });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.reason).toBe("malformed_response");
  });

  it("treats a shape-mismatched conversation response as a per-conversation malformed failure", async () => {
    // Arrange: the list is fine but the conversation fetch returns a foreign
    // shape (version skew). The run continues; the bad one is counted malformed.
    const sendMessage = vi.fn(
      async (_tabId: number, message: ListRequestMessage | ConversationRequestMessage) => {
        if (message.type === "LIST_REQUEST") return okList(["c1"]);
        return { type: "NOT_A_RESULT" };
      },
    );
    vi.stubGlobal("chrome", { tabs: { sendMessage } });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.request.conversations).toHaveLength(0);
      expect(outcome.failures.malformed_response).toBe(1);
    }
  });

  it("maps a sendMessage rejection on a conversation call to a per-conversation transient failure", async () => {
    // Arrange: list ok, but the tab disconnects before the conversation fetch.
    const sendMessage = vi.fn(
      async (_tabId: number, message: ListRequestMessage | ConversationRequestMessage) => {
        if (message.type === "LIST_REQUEST") return okList(["c1"]);
        throw new Error("Could not establish connection.");
      },
    );
    vi.stubGlobal("chrome", { tabs: { sendMessage } });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert: the run completes ok with zero conversations; the failure is tallied.
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.request.conversations).toHaveLength(0);
      expect(outcome.failures.transient_http).toBe(1);
    }
  });
});
