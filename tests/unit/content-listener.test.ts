import { describe, expect, it, vi } from "vitest";

import { makeContentMessageListener } from "../../src/lib/connectors/content-listener";
import type {
  ConversationSummary,
  RawConversationFetcher,
  RawFetchOutcome,
} from "../../src/lib/connectors/base";
import type { ListResultMessage, ConversationResultMessage } from "../../src/lib/messages";

// A stub fetcher that should never be invoked for an unknown message type.
class StubFetcher implements RawConversationFetcher {
  readonly platform = "chatgpt" as const;
  isSessionActive = vi.fn(async (): Promise<boolean> => true);
  listConversationsRaw = vi.fn(
    async (): Promise<RawFetchOutcome<ConversationSummary[]>> => ({ status: "ok", data: [] }),
  );
  fetchConversationRaw = vi.fn(
    async (): Promise<RawFetchOutcome<unknown>> => ({ status: "ok", data: {} }),
  );
}

// Resolves once a void-launched async listener body has settled and called
// sendResponse. The listener returns true synchronously; the response arrives a
// few microtasks later.
function waitFor<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("content message listener default case", () => {
  it("ignores an unknown message type without throwing and returns false", () => {
    // Arrange
    const fetcher = new StubFetcher();
    const listener = makeContentMessageListener("chatgpt", fetcher);
    const sendResponse = vi.fn();

    // Act
    const handled = listener(
      { type: "STATUS_REQUEST" },
      undefined,
      sendResponse as never,
    );

    // Assert
    expect(handled).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(fetcher.listConversationsRaw).not.toHaveBeenCalled();
    expect(fetcher.fetchConversationRaw).not.toHaveBeenCalled();
  });

  it("ignores a non-extension message without throwing", () => {
    const listener = makeContentMessageListener("claude", new StubFetcher());
    const sendResponse = vi.fn();

    expect(() =>
      listener({ type: "TOTALLY_UNKNOWN", foo: 1 }, undefined, sendResponse as never),
    ).not.toThrow();
    expect(listener({ type: "TOTALLY_UNKNOWN" }, undefined, sendResponse as never)).toBe(false);
  });

  it("ignores a LIST_REQUEST addressed to a different platform", () => {
    const fetcher = new StubFetcher();
    const listener = makeContentMessageListener("chatgpt", fetcher);

    const handled = listener(
      { type: "LIST_REQUEST", platform: "claude" },
      undefined,
      vi.fn() as never,
    );

    expect(handled).toBe(false);
    expect(fetcher.listConversationsRaw).not.toHaveBeenCalled();
  });
});

describe("content message listener happy path", () => {
  it("answers a matching LIST_REQUEST: drives listConversationsRaw, keeps the channel open, sends LIST_RESULT", async () => {
    // Arrange
    const fetcher = new StubFetcher();
    const summaries: ConversationSummary[] = [{ platform_id: "c1", title: "c1", updated_at: null }];
    fetcher.listConversationsRaw.mockResolvedValue({ status: "ok", data: summaries });
    const listener = makeContentMessageListener("chatgpt", fetcher);
    const gate = waitFor<ListResultMessage>();
    const sendResponse = vi.fn((response: ListResultMessage) => gate.resolve(response));

    // Act
    const handled = listener(
      { type: "LIST_REQUEST", platform: "chatgpt" },
      undefined,
      sendResponse as never,
    );

    // Assert: returns true synchronously (MV3 async-sendResponse contract).
    expect(handled).toBe(true);
    expect(fetcher.listConversationsRaw).toHaveBeenCalledTimes(1);
    const response = await gate.promise;
    expect(response).toEqual({
      type: "LIST_RESULT",
      platform: "chatgpt",
      result: { ok: true, summaries },
    });
  });

  it("forwards the since cursor from LIST_REQUEST to listConversationsRaw", async () => {
    // Arrange
    const fetcher = new StubFetcher();
    fetcher.listConversationsRaw.mockResolvedValue({ status: "ok", data: [] });
    const listener = makeContentMessageListener("chatgpt", fetcher);
    const gate = waitFor<ListResultMessage>();

    // Act
    listener(
      { type: "LIST_REQUEST", platform: "chatgpt", since: "2026-02-01T00:00:00.000Z" },
      undefined,
      ((r: ListResultMessage) => gate.resolve(r)) as never,
    );
    await gate.promise;

    // Assert
    expect(fetcher.listConversationsRaw).toHaveBeenCalledWith("2026-02-01T00:00:00.000Z");
  });

  it("answers a matching CONVERSATION_REQUEST: drives fetchConversationRaw, returns true, sends CONVERSATION_RESULT", async () => {
    // Arrange
    const fetcher = new StubFetcher();
    const raw = { conversation_id: "c1", messages: [] };
    fetcher.fetchConversationRaw.mockResolvedValue({ status: "ok", data: raw });
    const listener = makeContentMessageListener("chatgpt", fetcher);
    const gate = waitFor<ConversationResultMessage>();
    const sendResponse = vi.fn((response: ConversationResultMessage) => gate.resolve(response));

    // Act
    const handled = listener(
      { type: "CONVERSATION_REQUEST", platform: "chatgpt", conversationId: "c1" },
      undefined,
      sendResponse as never,
    );

    // Assert
    expect(handled).toBe(true);
    expect(fetcher.fetchConversationRaw).toHaveBeenCalledWith("c1");
    const response = await gate.promise;
    expect(response).toEqual({
      type: "CONVERSATION_RESULT",
      platform: "chatgpt",
      conversationId: "c1",
      result: { ok: true, raw },
    });
  });
});
