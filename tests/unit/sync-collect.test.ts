import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestConversationRequestSchema } from "../../src/lib/schema/ingest";
import { assembleIngestRequest, collectFromTab, normalizeBatch } from "../../src/lib/sync/collect";
import type {
  ListResultMessage,
  ConversationResultMessage,
  ListRequestMessage,
  ConversationRequestMessage,
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
        ? { ok: false, rateLimited: true }
        : { ok: false, rateLimited: true, retryAfterSeconds },
  };
}

function okConversation(conversationId: string, raw: unknown): ConversationResultMessage {
  return { type: "CONVERSATION_RESULT", platform: "chatgpt", conversationId, result: { ok: true, raw } };
}

function rateLimitedConversation(conversationId: string, retryAfterSeconds?: number): ConversationResultMessage {
  return {
    type: "CONVERSATION_RESULT",
    platform: "chatgpt",
    conversationId,
    result:
      retryAfterSeconds === undefined
        ? { ok: false, rateLimited: true }
        : { ok: false, rateLimited: true, retryAfterSeconds },
  };
}

// Returns the spy so each test can assert how many CONVERSATION_REQUESTs were issued.
function stubTab(responses: RoutedResponses): ReturnType<typeof vi.fn> {
  const sendMessage = vi.fn(async (_tabId: number, message: ListRequestMessage | ConversationRequestMessage) => {
    if (message.type === "LIST_REQUEST") return responses.list;
    return responses.conversationById[message.conversationId];
  });
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
        c2: okConversation("c2", { ...structuredClone(rawChatGpt), conversation_id: "chatgpt-conv-0002" }),
      },
    });

    // Act
    const outcome = await collectFromTab(TAB_ID, "chatgpt");

    // Assert
    expect(outcome.status).toBe("ok");
    expect(outcome.request.conversations).toHaveLength(2);
    expect(conversationRequestCount(spy)).toBe(2);
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
        c3: okConversation("c3", { ...structuredClone(rawChatGpt), conversation_id: "chatgpt-conv-0003" }),
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
});
