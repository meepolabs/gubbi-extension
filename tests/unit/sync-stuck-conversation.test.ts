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

// Drives runSync through the real collectFromTab against a tab that lists like
// the real connectors (newest first, nothing at or before `since`), so a
// conversation whose detail fetch keeps failing is followed across many runs.

const TAB_ID = 7;
const PAST_ANY_PAUSE_MS = 31 * 60 * 1000;
const STOP_LIMIT = 5;
const CURSOR_KEY = "gubbi:cursor:chatgpt";
const COUNTERS_KEY = "gubbi:counters";

type ConversationId = "oldest" | "middle" | "newest";
type DetailFailure = Exclude<ConversationResultMessage["result"], { ok: true }>;

const SERVER_ERROR: DetailFailure = { ok: false, reason: "transient_http" };
const SESSION_LOST: DetailFailure = { ok: false, reason: "session_lost" };

interface FakeTab {
  readonly updatedAt: Record<ConversationId, string>;
  // Decides the detail answer for a conversation on a 1-based run number.
  failureFor: (id: ConversationId, run: number) => DetailFailure | null;
  readonly sendMessage: ReturnType<typeof vi.fn>;
}

function rawConversation(id: ConversationId, updatedAt: string): unknown {
  return {
    ...structuredClone(rawChatGpt),
    conversation_id: id,
    update_time: Date.parse(updatedAt) / 1000,
  };
}

function listing(tab: FakeTab, since: string | undefined): ListResultMessage {
  const ids = (Object.keys(tab.updatedAt) as ConversationId[])
    .filter((id) => since === undefined || Date.parse(tab.updatedAt[id]) > Date.parse(since))
    .sort((a, b) => Date.parse(tab.updatedAt[b]) - Date.parse(tab.updatedAt[a]));
  return {
    type: "LIST_RESULT",
    platform: "chatgpt",
    result: {
      ok: true,
      summaries: ids.map((id) => ({ platform_id: id, title: id, updated_at: tab.updatedAt[id] })),
    },
  };
}

function stubTab(failureFor: FakeTab["failureFor"]): FakeTab {
  let run = 0;
  const tab: FakeTab = {
    updatedAt: {
      oldest: "2026-01-01T00:00:00.000Z",
      middle: "2026-02-01T00:00:00.000Z",
      newest: "2026-03-01T00:00:00.000Z",
    },
    failureFor,
    sendMessage: vi.fn(
      async (
        _tabId: number,
        message: ListRequestMessage | ConversationRequestMessage,
      ): Promise<ListResultMessage | ConversationResultMessage> => {
        if (message.type === "LIST_REQUEST") {
          run += 1;
          return listing(tab, message.since);
        }
        const id = message.conversationId as ConversationId;
        const result: ConversationResultMessage["result"] = tab.failureFor(id, run) ?? {
          ok: true,
          raw: rawConversation(id, tab.updatedAt[id]),
        };
        return { type: "CONVERSATION_RESULT", platform: "chatgpt", conversationId: id, result };
      },
    ),
  };
  vi.stubGlobal("chrome", { ...globalThis.chrome, tabs: { sendMessage: tab.sendMessage } });
  return tab;
}

function failsOn(stuck: ConversationId, failure: DetailFailure): FakeTab["failureFor"] {
  return (id) => (id === stuck ? failure : null);
}

function detailIdsPerRun(sendMessage: ReturnType<typeof vi.fn>): string[][] {
  const runs: string[][] = [];
  for (const [, message] of sendMessage.mock.calls) {
    const typed = message as ListRequestMessage | ConversationRequestMessage;
    if (typed.type === "LIST_REQUEST") runs.push([]);
    else runs.at(-1)?.push(typed.conversationId);
  }
  return runs;
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

async function runTimes(
  count: number,
  deps: Partial<RunSyncDeps>,
  clock: { nowMs: number },
): Promise<void> {
  for (let run = 0; run < count; run += 1) {
    await runSync({ platform: "chatgpt", deps });
    clock.nowMs += PAST_ANY_PAUSE_MS;
  }
}

function skippedOf(store: Record<string, unknown>): number {
  const counters = store[COUNTERS_KEY] as { conversations_skipped?: number } | undefined;
  return counters?.conversations_skipped ?? 0;
}

function uploadedIdsOfCall(upload: ReturnType<typeof vi.fn>, call: number): string[] {
  const request = upload.mock.calls[call]?.[0] as IngestConversationRequest | undefined;
  return request?.conversations.map((c) => c.platform_id) ?? [];
}

function startClock(): { nowMs: number } {
  return { nowMs: Date.parse("2026-06-06T12:00:00.000Z") };
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

describe("a conversation whose detail fetch fails with a 500 on every run", () => {
  it("is skipped once after the stop limit, letting newer conversations through", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    const tab = stubTab(failsOn("middle", SERVER_ERROR));
    const clock = startClock();
    const { deps, upload } = makeDeps(clock);

    // Act
    await runTimes(STOP_LIMIT, deps, clock);
    const skippedBeforeSkipRun = skippedOf(store);
    const uploadsBeforeSkipRun = upload.mock.calls.length;
    await runTimes(1, deps, clock);
    const skippedAfterSkipRun = skippedOf(store);
    await runTimes(1, deps, clock);

    // Assert
    const runs = detailIdsPerRun(tab.sendMessage);
    expect(runs.slice(0, STOP_LIMIT)).toEqual(Array(STOP_LIMIT).fill(["oldest", "middle"]));
    expect(skippedBeforeSkipRun).toBe(0);
    expect(runs[STOP_LIMIT]).toEqual(["oldest", "newest"]);
    expect(uploadedIdsOfCall(upload, uploadsBeforeSkipRun)).toEqual(["oldest", "newest"]);
    expect(skippedAfterSkipRun).toBe(1);
    expect(runs[STOP_LIMIT + 1]).not.toContain("middle");
    expect(store[CURSOR_KEY]).toBe(tab.updatedAt.newest);
    expect(skippedOf(store)).toBe(1);
  });

  it("is not fetched again while unchanged, and is fetched once its updated_at moves", async () => {
    // Arrange: the newest conversation is stuck, so the cursor never passes it
    // and only the remembered skip keeps it out of later runs.
    const { store } = stubChromeStorageWithEvents();
    const tab = stubTab(failsOn("newest", SERVER_ERROR));
    const clock = startClock();
    const { deps } = makeDeps(clock);

    // Act
    await runTimes(STOP_LIMIT + 2, deps, clock);
    const runsWhileUnchanged = detailIdsPerRun(tab.sendMessage);
    tab.updatedAt.newest = "2026-04-01T00:00:00.000Z";
    tab.failureFor = () => null;
    await runTimes(1, deps, clock);

    // Assert
    expect(runsWhileUnchanged[STOP_LIMIT - 1]).toContain("newest");
    expect(runsWhileUnchanged[STOP_LIMIT]).not.toContain("newest");
    expect(runsWhileUnchanged[STOP_LIMIT + 1]).not.toContain("newest");
    expect(detailIdsPerRun(tab.sendMessage).at(-1)).toContain("newest");
    expect(store[CURSOR_KEY]).toBe("2026-04-01T00:00:00.000Z");
    expect(skippedOf(store)).toBe(1);
  });

  it("is counted once even when the run that skips it stops for a lost session", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    const tab = stubTab((id, run) => {
      if (id === "middle") return SERVER_ERROR;
      return id === "newest" && run === STOP_LIMIT + 1 ? SESSION_LOST : null;
    });
    const clock = startClock();
    const { deps } = makeDeps(clock);

    // Act
    await runTimes(STOP_LIMIT + 2, deps, clock);

    // Assert
    const runs = detailIdsPerRun(tab.sendMessage);
    expect(runs[STOP_LIMIT]).toEqual(["oldest", "newest"]);
    expect(runs[STOP_LIMIT + 1]).not.toContain("middle");
    expect(skippedOf(store)).toBe(1);
  });

  it("restarts the count after a run that fetches it successfully", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    const succeedsOnRun = STOP_LIMIT;
    const tab = stubTab((id, run) =>
      id === "newest" && run !== succeedsOnRun ? SERVER_ERROR : null,
    );
    const clock = startClock();
    const { deps } = makeDeps(clock);

    // Act
    await runTimes(2 * STOP_LIMIT - 1, deps, clock);

    // Assert
    expect(detailIdsPerRun(tab.sendMessage).at(-1)).toContain("newest");
    expect(skippedOf(store)).toBe(0);
  });
});

describe("stops that do not reach the bound", () => {
  it("never skips a conversation for a lost session, however often it stops there", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    const tab = stubTab(failsOn("middle", SESSION_LOST));
    const clock = startClock();
    const { deps } = makeDeps(clock);

    // Act
    await runTimes(2 * STOP_LIMIT, deps, clock);

    // Assert
    const runs = detailIdsPerRun(tab.sendMessage);
    expect(runs).toHaveLength(2 * STOP_LIMIT);
    expect(runs.every((details) => details.includes("middle"))).toBe(true);
    expect(skippedOf(store)).toBe(0);
  });

  it("never skips either of two conversations whose failures alternate", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    const failingOn = (run: number): ConversationId => (run % 2 === 1 ? "middle" : "oldest");
    const tab = stubTab((id, run) => (id === failingOn(run) ? SERVER_ERROR : null));
    const clock = startClock();
    const { deps } = makeDeps(clock);
    const runCount = 2 * STOP_LIMIT + 2;

    // Act
    await runTimes(runCount, deps, clock);

    // Assert
    const runs = detailIdsPerRun(tab.sendMessage);
    expect(runs).toHaveLength(runCount);
    runs.forEach((details, index) => expect(details.at(-1)).toBe(failingOn(index + 1)));
    expect(skippedOf(store)).toBe(0);
  });
});
