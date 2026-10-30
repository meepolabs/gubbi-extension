import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INGEST_MAX_BODY_BYTES, serializeRequest, uploadConversations } from "../../src/lib/api";
import type { UploadOutcome } from "../../src/lib/api";
import type { AdapterPlatform } from "../../src/lib/connectors/base";
import type {
  ConversationPayload,
  IngestConversationRequest,
  IngestConversationResponse,
} from "../../src/lib/schema/ingest";
import type { CollectOutcome } from "../../src/lib/sync/collect";
import {
  PARTIAL_SAVE_HOLD_LIMIT,
  runSync,
  type RunSyncDeps,
} from "../../src/lib/sync/orchestrator";
import type { TokenProvider } from "../../src/lib/token-provider";
import { stubChromeStorageWithEvents } from "../helpers/chrome-stub";

// When the per-platform cursor may move. A cursor that moves too far skips
// conversations forever; one that never moves re-collects them on every run.
// The source is modeled as a fixed corpus filtered the way both connectors
// filter a listing: a conversation whose watermark is at or before `since` is
// not listed.

const START_MS = Date.parse("2026-06-06T12:00:00.000Z");
// Longer than any pause a single failure sets, so the next run is not skipped.
const PAST_ANY_PAUSE_MS = 2 * 60 * 60 * 1000;
const CURSOR_KEY = "gubbi:cursor:chatgpt";
const PAUSE_KEY = "gubbi:pauseState:chatgpt";
const COUNTERS_KEY = "gubbi:counters";

type Store = Record<string, unknown>;

interface Counters {
  readonly conversations_uploaded: number;
  readonly conversations_skipped: number;
}

function conversation(platformId: string, updatedAt: string, content = "hi"): ConversationPayload {
  return {
    platform: "chatgpt",
    platform_id: platformId,
    title: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: updatedAt,
    messages: [{ role: "user", content }],
  };
}

const utf8 = new TextEncoder();

// A conversation that alone serializes one byte over the ingest body cap.
function overCapConversation(platformId: string, updatedAt: string): ConversationPayload {
  const base = conversation(platformId, updatedAt, "");
  const baseBytes = utf8.encode(
    serializeRequest({ source: "extension_chatgpt", conversations: [base] }),
  ).length;
  return conversation(platformId, updatedAt, "a".repeat(INGEST_MAX_BODY_BYTES + 1 - baseBytes));
}

function minuteOf(dayIso: string, minute: number): string {
  return new Date(Date.parse(dayIso) + minute * 60_000).toISOString();
}

// A listing that honors `since` like the connectors: at-or-before is excluded.
function corpusCollect(corpus: readonly ConversationPayload[]): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (_tabId: number, _platform: AdapterPlatform, since?: string): Promise<CollectOutcome> => {
      const sinceMs = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
      const listed = corpus.filter((c) => Date.parse(c.updated_at ?? c.created_at) > sinceMs);
      return {
        status: "ok",
        request: { source: "extension_chatgpt", conversations: [...listed] },
        complete: true,
        failures: {
          no_tab: 0,
          session_lost: 0,
          rate_limited: 0,
          transient_http: 0,
          network: 0,
          malformed_response: 0,
        },
      };
    },
  );
}

function response(overrides: Partial<IngestConversationResponse>): IngestConversationResponse {
  return {
    conversations_saved: 0,
    conversations_skipped_dedupe: 0,
    extractions_enqueued: 0,
    extractions_skipped_budget: 0,
    extractions_skipped_error: 0,
    budget_exhausted: false,
    ...overrides,
  };
}

function savedAll(request: IngestConversationRequest): UploadOutcome {
  return {
    status: "ok",
    response: response({ conversations_saved: request.conversations.length }),
  };
}

interface Harness {
  readonly store: Store;
  readonly collect: ReturnType<typeof vi.fn>;
  run(): Promise<void>;
}

type Upload = (request: IngestConversationRequest) => Promise<UploadOutcome>;

const savedEverything: Upload = async (request) => savedAll(request);

// `corpus` is read on every run, so a test may add conversations between runs.
function harness(
  corpus: readonly ConversationPayload[],
  upload: Upload = savedEverything,
): Harness {
  const { store } = stubChromeStorageWithEvents();
  const clock = { nowMs: START_MS };
  const collect = corpusCollect(corpus);
  const tokenProvider: TokenProvider = {
    getAccessToken: async () => "token",
    forceRefresh: async () => "token",
  };
  const deps: Partial<RunSyncDeps> = {
    findTab: async () => 7,
    collect: collect as unknown as RunSyncDeps["collect"],
    upload: ((request: IngestConversationRequest) => upload(request)) as RunSyncDeps["upload"],
    tokenProvider,
    now: () => clock.nowMs,
    scheduleContinuation: async () => undefined,
    setStatus: async () => undefined,
    random: () => 0,
  };
  return {
    store,
    collect,
    run: async () => {
      await runSync({ platform: "chatgpt", deps });
      clock.nowMs += PAST_ANY_PAUSE_MS;
    },
  };
}

function countersOf(store: Store): Counters {
  return (
    (store[COUNTERS_KEY] as Counters | undefined) ?? {
      conversations_uploaded: 0,
      conversations_skipped: 0,
    }
  );
}

function pauseReasonOf(store: Store): string | undefined {
  return (store[PAUSE_KEY] as { reason: string } | undefined)?.reason;
}

function sinceOfCall(collect: ReturnType<typeof vi.fn>, call: number): string | undefined {
  return collect.mock.calls[call]?.[2] as string | undefined;
}

// Answers like the ingest endpoint: a 200 whose body reports one conversation
// whose save failed, every other conversation saved.
function partialSaveFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_input: URL | string, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as IngestConversationRequest;
    const body = response({
      conversations_saved: sent.conversations.length - 1,
      extractions_skipped_error: 1,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const unusedProvider: TokenProvider = {
  getAccessToken: async () => "token",
  forceRefresh: async () => "token",
};

function sentPlatformIds(fetchMock: ReturnType<typeof vi.fn>, call: number): string[] {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  const sent = JSON.parse(String(init?.body)) as IngestConversationRequest;
  return sent.conversations.map((c) => c.platform_id);
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

describe("a 200 that reports a failed save, through the real upload client", () => {
  it("holds the cursor, counts what saved, pauses, and re-sends the same conversations", async () => {
    // Arrange
    const corpus = [
      conversation("a", "2026-02-01T00:00:00.000Z"),
      conversation("b", "2026-02-02T00:00:00.000Z"),
    ];
    const h = harness(corpus, (request) => uploadConversations(request, unusedProvider));
    const fetchMock = partialSaveFetch();
    vi.stubGlobal("fetch", fetchMock);
    h.store[CURSOR_KEY] = "2026-01-15T00:00:00.000Z";

    // Act
    await h.run();
    const cursorAfterRun1 = h.store[CURSOR_KEY];
    const pauseAfterRun1 = pauseReasonOf(h.store);
    const countersAfterRun1 = countersOf(h.store);
    await h.run();

    // Assert
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cursorAfterRun1).toBe("2026-01-15T00:00:00.000Z");
    expect(pauseAfterRun1).toBe("transient");
    expect(countersAfterRun1.conversations_uploaded).toBe(1);
    expect(countersAfterRun1.conversations_skipped).toBe(0);
    expect(sentPlatformIds(fetchMock, 1)).toEqual(sentPlatformIds(fetchMock, 0));
    expect(sentPlatformIds(fetchMock, 0)).toEqual(["a", "b"]);
  });
});

// An ingest double that dedupes on platform_id like the server and fails the
// save of every id in `failing`, which a test may edit between runs.
function fakeServer(failing: Set<string>): { upload: Upload; sends: string[][] } {
  const saved = new Set<string>();
  const sends: string[][] = [];
  const upload: Upload = async (request) => {
    const ids = request.conversations.map((c) => c.platform_id);
    sends.push(ids);
    let conversationsSaved = 0;
    let dedupe = 0;
    let errors = 0;
    for (const id of ids) {
      if (failing.has(id)) errors += 1;
      else if (saved.has(id)) dedupe += 1;
      else {
        saved.add(id);
        conversationsSaved += 1;
      }
    }
    return {
      status: "ok",
      response: response({
        conversations_saved: conversationsSaved,
        conversations_skipped_dedupe: dedupe,
        extractions_skipped_error: errors,
      }),
    };
  };
  return { upload, sends };
}

const DAY = "2026-02-01T00:00:00.000Z";

describe("consecutive partial saves", () => {
  it("holds the cursor for the first holds, then commits once and counts the failures once", async () => {
    // Arrange
    const corpus = [
      conversation("ok1", minuteOf(DAY, 1)),
      conversation("bad1", minuteOf(DAY, 2)),
      conversation("bad2", minuteOf(DAY, 3)),
    ];
    const server = fakeServer(new Set(["bad1", "bad2"]));
    const h = harness(corpus, server.upload);
    const cursorsAfterHolds: unknown[] = [];

    // Act
    for (let hold = 1; hold <= PARTIAL_SAVE_HOLD_LIMIT; hold += 1) {
      await h.run();
      cursorsAfterHolds.push(h.store[CURSOR_KEY]);
    }
    const skippedBeforeCommit = countersOf(h.store).conversations_skipped;
    await h.run();
    const cursorAfterCommit = h.store[CURSOR_KEY];
    const pauseAfterCommit = h.store[PAUSE_KEY];
    const transientAfterCommit = h.store["gubbi:transient:chatgpt"];
    await h.run();

    // Assert
    expect(cursorsAfterHolds).toEqual(Array(PARTIAL_SAVE_HOLD_LIMIT).fill(undefined));
    expect(skippedBeforeCommit).toBe(0);
    expect(cursorAfterCommit).toBe(minuteOf(DAY, 3));
    expect(pauseAfterCommit).toBeUndefined();
    expect(transientAfterCommit).toBeUndefined();
    expect(countersOf(h.store).conversations_skipped).toBe(2);
    expect(countersOf(h.store).conversations_uploaded).toBe(1);
    expect(server.sends).toHaveLength(PARTIAL_SAVE_HOLD_LIMIT + 2);
  });

  it("restarts the hold streak after a clean save", async () => {
    // Arrange
    const corpus: ConversationPayload[] = [conversation("first", minuteOf(DAY, 1))];
    const failing = new Set(["first"]);
    const server = fakeServer(failing);
    const h = harness(corpus, server.upload);
    for (let hold = 1; hold < PARTIAL_SAVE_HOLD_LIMIT; hold += 1) await h.run();
    failing.clear();
    await h.run();
    const cursorAfterClean = h.store[CURSOR_KEY];
    corpus.push(conversation("second", minuteOf(DAY, 30)));
    failing.add("second");

    // Act
    for (let hold = 1; hold <= PARTIAL_SAVE_HOLD_LIMIT; hold += 1) await h.run();

    // Assert
    expect(cursorAfterClean).toBe(minuteOf(DAY, 1));
    expect(h.store[CURSOR_KEY]).toBe(minuteOf(DAY, 1));
    expect(pauseReasonOf(h.store)).toBe("transient");
    expect(countersOf(h.store).conversations_skipped).toBe(0);
  });

  it("does not upload the batches after a partially saved one", async () => {
    // Arrange: 51 conversations make two batches; the first holds a failure.
    const corpus = Array.from({ length: 51 }, (_, i) => conversation(`c${i}`, minuteOf(DAY, i)));
    const server = fakeServer(new Set(["c0"]));
    const h = harness(corpus, server.upload);

    // Act
    await h.run();

    // Assert
    expect(server.sends).toHaveLength(1);
    expect(h.store[CURSOR_KEY]).toBeUndefined();
    expect(countersOf(h.store).conversations_uploaded).toBe(49);
  });
});

describe("conversations dropped as larger than the body cap", () => {
  it("counts a newest-only drop once and lists past it on the next run", async () => {
    // Arrange
    const big = overCapConversation("big", minuteOf(DAY, 10));
    const corpus: ConversationPayload[] = [conversation("small", minuteOf(DAY, 1)), big];
    const server = fakeServer(new Set());
    const h = harness(corpus, server.upload);

    // Act
    await h.run();
    await h.run();
    corpus.push(conversation("newer", new Date(Date.parse(minuteOf(DAY, 10)) + 1).toISOString()));
    await h.run();

    // Assert
    const run2Since = sinceOfCall(h.collect, 1);
    expect(run2Since).toBeDefined();
    expect(Date.parse(run2Since ?? "")).toBeGreaterThanOrEqual(Date.parse(minuteOf(DAY, 10)));
    expect(countersOf(h.store).conversations_skipped).toBe(1);
    expect(server.sends).toEqual([["small"], ["newer"]]);
  });

  it("counts a drop near the run clock once although the next run lists it again", async () => {
    // Arrange: the cursor may not pass the clock, so this drop is re-listed.
    const big = overCapConversation("big", new Date(START_MS - 10_000).toISOString());
    const h = harness([big], fakeServer(new Set()).upload);

    // Act
    await h.run();
    const cursorAfterRun1 = h.store[CURSOR_KEY];
    await h.run();

    // Assert
    expect(cursorAfterRun1).toBe(new Date(START_MS).toISOString());
    expect(countersOf(h.store).conversations_skipped).toBe(1);
  });

  it("keeps the cursor before a drop when a later batch pauses, then counts the drop once", async () => {
    // Arrange: batch one holds minutes 0-49, the drop is at minute 50, and
    // batch two (minute 51) fails on the first run only.
    const corpus = [
      ...Array.from({ length: 50 }, (_, i) => conversation(`c${i}`, minuteOf(DAY, i))),
      overCapConversation("big", minuteOf(DAY, 50)),
      conversation("last", minuteOf(DAY, 51)),
    ];
    const server = fakeServer(new Set());
    let calls = 0;
    const h = harness(corpus, async (request) => {
      calls += 1;
      return calls === 2 ? { status: "transient_http", httpStatus: 503 } : server.upload(request);
    });

    // Act
    await h.run();
    const cursorAfterPause = h.store[CURSOR_KEY];
    const skippedAfterPause = countersOf(h.store).conversations_skipped;
    await h.run();
    await h.run();

    // Assert
    expect(cursorAfterPause).toBe(minuteOf(DAY, 49));
    expect(skippedAfterPause).toBe(0);
    expect(h.store[CURSOR_KEY]).toBe(minuteOf(DAY, 51));
    expect(countersOf(h.store).conversations_skipped).toBe(1);
    expect(countersOf(h.store).conversations_uploaded).toBe(51);
  });
  it("does not push past a drop when a rate limit cut the listing short", async () => {
    // Arrange: detail stopped at a 429 right after the drop, so "unfetched",
    // sharing the drop's watermark, was never collected and must be listed again.
    const big = overCapConversation("big", minuteOf(DAY, 10));
    const unfetched = conversation("unfetched", minuteOf(DAY, 10));
    const h = harness([conversation("small", minuteOf(DAY, 1)), big, unfetched]);
    h.collect.mockImplementationOnce(
      async (): Promise<CollectOutcome> => ({
        status: "rate_limited",
        retryAfterSeconds: 60,
        request: {
          source: "extension_chatgpt",
          conversations: [conversation("small", minuteOf(DAY, 1)), big],
        },
      }),
    );

    // Act
    await h.run();
    await h.run();

    // Assert
    const run2Since = sinceOfCall(h.collect, 1);
    expect(Date.parse(run2Since ?? "")).toBeLessThan(Date.parse(unfetched.updated_at ?? ""));
    expect(countersOf(h.store).conversations_skipped).toBe(1);
  });
});

describe("cursor direction", () => {
  it("keeps the cursor when the rewind window re-lists only older conversations", async () => {
    // Arrange
    const cursor = minuteOf(DAY, 10);
    const h = harness([
      conversation("recent", new Date(Date.parse(cursor) - 30_000).toISOString()),
    ]);
    h.store[CURSOR_KEY] = cursor;

    // Act
    await h.run();

    // Assert
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(h.store[CURSOR_KEY]).toBe(cursor);
  });
});
