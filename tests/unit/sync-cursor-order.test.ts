import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadOutcome } from "../../src/lib/api";
import type { AdapterPlatform } from "../../src/lib/connectors/base";
import type {
  ConversationRequestMessage,
  ConversationResultMessage,
  ListRequestMessage,
  ListResultMessage,
} from "../../src/lib/messages";
import type { IngestConversationRequest } from "../../src/lib/schema/ingest";
import { collectFromTab } from "../../src/lib/sync/collect";
import { runSync, type RunSyncDeps } from "../../src/lib/sync/orchestrator";
import type { TokenProvider } from "../../src/lib/token-provider";
import { stubChromeStorageWithEvents } from "../helpers/chrome-stub";

import rawChatGpt from "../fixtures/raw-chatgpt-conversation.json";

// Drives runSync through the real collectFromTab, so the order in which detail
// is fetched and the cursor the orchestrator commits are exercised together.

const TAB_ID = 7;
const RETRY_AFTER_SECONDS = 60;

const CONVERSATIONS = {
  oldest: "2026-01-01T00:00:00.000Z",
  middle: "2026-02-01T00:00:00.000Z",
  newest: "2026-03-01T00:00:00.000Z",
} as const;

type ConversationId = keyof typeof CONVERSATIONS;

function rawConversation(id: ConversationId): unknown {
  return {
    ...structuredClone(rawChatGpt),
    conversation_id: id,
    update_time: Date.parse(CONVERSATIONS[id]) / 1000,
  };
}

function newestFirstList(): ListResultMessage {
  const ids: ConversationId[] = ["newest", "middle", "oldest"];
  return {
    type: "LIST_RESULT",
    platform: "chatgpt",
    result: {
      ok: true,
      summaries: ids.map((id) => ({ platform_id: id, title: id, updated_at: CONVERSATIONS[id] })),
    },
  };
}

function conversationResult(
  conversationId: string,
  isSecondDetailRequest: boolean,
): ConversationResultMessage {
  const result: ConversationResultMessage["result"] = isSecondDetailRequest
    ? { ok: false, reason: "rate_limited", retryAfterSeconds: RETRY_AFTER_SECONDS }
    : { ok: true, raw: rawConversation(conversationId as ConversationId) };
  return { type: "CONVERSATION_RESULT", platform: "chatgpt", conversationId, result };
}

// Layers a tab onto the storage stub: the list is newest first and the second
// detail request of the first run answers 429.
function stubTab(): ReturnType<typeof vi.fn> {
  let detailRequests = 0;
  const sendMessage = vi.fn(
    async (_tabId: number, message: ListRequestMessage | ConversationRequestMessage) => {
      if (message.type === "LIST_REQUEST") return newestFirstList();
      detailRequests += 1;
      return conversationResult(message.conversationId, detailRequests === 2);
    },
  );
  vi.stubGlobal("chrome", { ...globalThis.chrome, tabs: { sendMessage } });
  return sendMessage;
}

function listSinces(sendMessage: ReturnType<typeof vi.fn>): Array<string | undefined> {
  return sendMessage.mock.calls
    .map(([, message]) => message as ListRequestMessage | ConversationRequestMessage)
    .filter((message): message is ListRequestMessage => message.type === "LIST_REQUEST")
    .map((message) => message.since);
}

function makeDeps(clock: { nowMs: number }): {
  deps: Partial<RunSyncDeps>;
  upload: ReturnType<typeof vi.fn>;
} {
  const upload = vi.fn(
    async (request: IngestConversationRequest, _tp: TokenProvider): Promise<UploadOutcome> => ({
      status: "ok",
      response: {
        conversations_saved: request.conversations.length,
        conversations_skipped_dedupe: 0,
        extractions_enqueued: request.conversations.length,
        extractions_skipped_budget: 0,
        extractions_skipped_error: 0,
        budget_exhausted: false,
      },
    }),
  );
  const deps: Partial<RunSyncDeps> = {
    findTab: async (_platform: AdapterPlatform) => TAB_ID,
    collect: collectFromTab,
    upload: upload as unknown as RunSyncDeps["upload"],
    tokenProvider: { getAccessToken: async () => "token", forceRefresh: async () => "token" },
    now: () => clock.nowMs,
    scheduleContinuation: async () => undefined,
    setStatus: async () => undefined,
    random: () => 0,
  };
  return { deps, upload };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runSync with a detail fetch truncated by a 429", () => {
  it("commits the oldest watermark and re-lists from before every uncollected conversation", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    const sendMessage = stubTab();
    const clock = { nowMs: Date.parse("2026-06-06T12:00:00.000Z") };
    const { deps, upload } = makeDeps(clock);

    // Act
    await runSync({ platform: "chatgpt", deps });
    const cursorAfterTruncatedRun = store["gubbi:cursor:chatgpt"];
    clock.nowMs += (RETRY_AFTER_SECONDS + 1) * 1000;
    await runSync({ platform: "chatgpt", deps });

    // Assert
    const firstUpload = upload.mock.calls[0]?.[0] as IngestConversationRequest | undefined;
    expect(firstUpload?.conversations.map((c) => c.platform_id)).toEqual(["oldest"]);
    expect(cursorAfterTruncatedRun).toBe(CONVERSATIONS.oldest);
    const secondSince = listSinces(sendMessage)[1];
    expect(secondSince).toBeDefined();
    const secondSinceMs = Date.parse(secondSince ?? "");
    expect(secondSinceMs).toBeLessThan(Date.parse(CONVERSATIONS.middle));
    expect(secondSinceMs).toBeLessThan(Date.parse(CONVERSATIONS.newest));
  });
});
