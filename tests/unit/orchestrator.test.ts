import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReconnectRequiredError } from "../../src/lib/auth/errors";
import type { UploadOutcome } from "../../src/lib/api";
import type { CollectOutcome, FailureCounts } from "../../src/lib/sync/collect";
import type { AdapterPlatform } from "../../src/lib/connectors/base";
import type {
  IngestConversationRequest,
  IngestConversationResponse,
} from "../../src/lib/schema/ingest";
import type { SyncStatusState } from "../../src/lib/messages";
import type { TokenProvider } from "../../src/lib/token-provider";
import { runSync, type RunSyncDeps } from "../../src/lib/sync/orchestrator";
import { stubChromeStorageWithEvents as stubChrome } from "../helpers/chrome-stub";

// The orchestrator goes through storage.ts (cursor/counters/pause/events) and
// locks.ts (lease), both of which use write-then-read-back and onChanged, so the
// stub must persist writes and dispatch changes.

// ---- Builders ----------------------------------------------------------------

const NOW_MS = Date.parse("2026-06-06T12:00:00.000Z");

function emptyFailures(overrides: Partial<FailureCounts> = {}): FailureCounts {
  return {
    no_tab: 0,
    session_lost: 0,
    rate_limited: 0,
    transient_http: 0,
    network: 0,
    malformed_response: 0,
    ...overrides,
  };
}

function conversation(
  platformId: string,
  updatedAt: string | null,
  createdAt = "2026-01-01T00:00:00.000Z",
): IngestConversationRequest["conversations"][number] {
  return {
    platform: "chatgpt",
    platform_id: platformId,
    title: "",
    created_at: createdAt,
    ...(updatedAt === null ? {} : { updated_at: updatedAt }),
    messages: [{ role: "user", content: "hi" }],
  };
}

function requestOf(
  ...conversations: IngestConversationRequest["conversations"]
): IngestConversationRequest {
  return { source: "extension_chatgpt", conversations };
}

function okResponse(overrides: Partial<IngestConversationResponse> = {}): IngestConversationResponse {
  return {
    conversations_saved: 1,
    conversations_skipped_dedupe: 0,
    extractions_enqueued: 1,
    extractions_skipped_budget: 0,
    extractions_skipped_error: 0,
    budget_exhausted: false,
    ...overrides,
  };
}

function collectOk(
  request: IngestConversationRequest,
  opts: { complete?: boolean; failures?: FailureCounts } = {},
): CollectOutcome {
  return {
    status: "ok",
    request,
    complete: opts.complete ?? true,
    failures: opts.failures ?? emptyFailures(),
  };
}

// A token provider whose calls are observable.
function fakeProvider(overrides?: Partial<TokenProvider>): TokenProvider {
  return {
    getAccessToken: vi.fn(async () => "token"),
    forceRefresh: vi.fn(async () => "token"),
    ...overrides,
  };
}

// Build a full deps object for a single-platform run. Defaults to chatgpt with a
// found tab, a clean collect, and a single ok upload; tests override per case.
interface FakeDepsBundle {
  readonly deps: RunSyncDeps;
  readonly collect: ReturnType<typeof vi.fn>;
  readonly upload: ReturnType<typeof vi.fn>;
  readonly tokenProvider: TokenProvider;
  readonly setStatus: ReturnType<typeof vi.fn>;
  readonly scheduleContinuation: ReturnType<typeof vi.fn>;
  readonly findTab: ReturnType<typeof vi.fn>;
  statuses(): SyncStatusState[];
}

function makeDeps(overrides: Partial<RunSyncDeps> = {}): FakeDepsBundle {
  const recordedStatuses: SyncStatusState[] = [];
  const findTab = vi.fn(async (_p: AdapterPlatform) => 7 as number | null);
  const collect = vi.fn(
    async (_tabId: number, _platform: AdapterPlatform, _since?: string): Promise<CollectOutcome> =>
      collectOk(requestOf(conversation("c1", "2026-02-01T00:00:00.000Z"))),
  );
  const upload = vi.fn(
    async (_req: IngestConversationRequest, _tp: TokenProvider): Promise<UploadOutcome> => ({
      status: "ok",
      response: okResponse(),
    }),
  );
  const tokenProvider = fakeProvider();
  const setStatus = vi.fn(async (_p: AdapterPlatform, state: SyncStatusState) => {
    recordedStatuses.push(state);
  });
  const scheduleContinuation = vi.fn(async () => undefined);

  const deps: RunSyncDeps = {
    findTab,
    collect: collect as unknown as RunSyncDeps["collect"],
    upload: upload as unknown as RunSyncDeps["upload"],
    tokenProvider,
    now: () => NOW_MS,
    scheduleContinuation,
    setStatus,
    random: () => 0,
    ...overrides,
  };

  return {
    deps,
    collect,
    upload,
    tokenProvider,
    setStatus,
    scheduleContinuation,
    findTab,
    statuses: () => recordedStatuses,
  };
}

// Read helpers over the in-memory store.
function cursorOf(store: Record<string, unknown>, platform: AdapterPlatform): unknown {
  return store[`gubbi:cursor:${platform}`];
}
function countersOf(store: Record<string, unknown>): { conversations_uploaded: number } | undefined {
  return store["gubbi:counters"] as { conversations_uploaded: number } | undefined;
}
function pauseOf(store: Record<string, unknown>, platform: AdapterPlatform):
  | { reason: string; pausedUntil: string }
  | undefined {
  return store[`gubbi:pauseState:${platform}`] as
    | { reason: string; pausedUntil: string }
    | undefined;
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

describe("runSync clean end-to-end", () => {
  it("collect ok -> upload ok -> cursor at max watermark, counters from saved, idle at end", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(
        requestOf(
          conversation("c1", "2026-02-01T00:00:00.000Z"),
          conversation("c2", "2026-03-15T00:00:00.000Z"),
        ),
      ),
    );
    bundle.upload.mockResolvedValue({
      status: "ok",
      response: okResponse({ conversations_saved: 2 }),
    });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-03-15T00:00:00.000Z");
    expect(countersOf(stub.store)?.conversations_uploaded).toBe(2);
    expect(bundle.statuses().at(-1)).toBe("idle");
  });

  it("counts conversations_saved, not batch length", async () => {
    // Arrange: a 2-conversation batch but the server saved only 1 (one deduped).
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(
        requestOf(
          conversation("c1", "2026-02-01T00:00:00.000Z"),
          conversation("c2", "2026-02-02T00:00:00.000Z"),
        ),
      ),
    );
    bundle.upload.mockResolvedValue({
      status: "ok",
      response: okResponse({ conversations_saved: 1, conversations_skipped_dedupe: 1 }),
    });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(countersOf(stub.store)?.conversations_uploaded).toBe(1);
  });

  it("passes effectiveSince = cursor - 60s to collect", async () => {
    // Arrange: a stored cursor; the next run should re-collect 60s earlier.
    const stub = stubChrome();
    stub.store["gubbi:cursor:chatgpt"] = "2026-02-01T00:01:00.000Z";
    const bundle = makeDeps();

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    const sincePassed = bundle.collect.mock.calls[0]?.[2] as string;
    expect(sincePassed).toBe("2026-02-01T00:00:00.000Z");
  });

  it("passes undefined since on a first run with no cursor", async () => {
    // Arrange
    stubChrome();
    const bundle = makeDeps();

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.collect.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("single-flight lease", () => {
  it("short-circuits a second concurrent runSync (no double sync)", async () => {
    // Arrange: the first run blocks inside collect so it holds the lease while the
    // second run attempts to acquire it.
    stubChrome();
    let releaseCollect = (): void => undefined;
    const collectGate = new Promise<void>((resolve) => {
      releaseCollect = resolve;
    });
    let collectEntered = (): void => undefined;
    const hasEnteredCollect = new Promise<void>((resolve) => {
      collectEntered = resolve;
    });

    const first = makeDeps();
    first.collect.mockImplementation(async () => {
      collectEntered();
      await collectGate;
      return collectOk(requestOf(conversation("c1", "2026-02-01T00:00:00.000Z")));
    });
    const second = makeDeps();

    // Act
    const firstRun = runSync({ platform: "chatgpt", deps: first.deps });
    await hasEnteredCollect;
    await runSync({ platform: "chatgpt", deps: second.deps });

    // Assert: the second run never collected (lease was contended).
    expect(second.collect).not.toHaveBeenCalled();
    releaseCollect();
    await firstRun;
    expect(first.collect).toHaveBeenCalledTimes(1);
  });
});

describe("cursor advances only on a 200", () => {
  it("does not advance the cursor when upload is transient_http", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "transient_http", httpStatus: 503 });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(cursorOf(stub.store, "chatgpt")).toBeUndefined();
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("transient");
  });
});

describe("401 refresh-and-retry-once", () => {
  it("forceRefresh once -> retry once -> success advances the cursor", async () => {
    // Arrange: first upload 401, retry after refresh succeeds.
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload
      .mockResolvedValueOnce({ status: "needs_refresh" })
      .mockResolvedValueOnce({ status: "ok", response: okResponse({ conversations_saved: 1 }) });
    bundle.collect.mockResolvedValue(
      collectOk(requestOf(conversation("c1", "2026-04-01T00:00:00.000Z"))),
    );

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.tokenProvider.forceRefresh).toHaveBeenCalledTimes(1);
    expect(bundle.upload).toHaveBeenCalledTimes(2);
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-04-01T00:00:00.000Z");
  });

  it("a second 401 -> reconnect_required, stop, cursor unchanged", async () => {
    // Arrange: both the original and the post-refresh retry return 401.
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "needs_refresh" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.tokenProvider.forceRefresh).toHaveBeenCalledTimes(1);
    expect(bundle.upload).toHaveBeenCalledTimes(2);
    expect(cursorOf(stub.store, "chatgpt")).toBeUndefined();
    expect(bundle.statuses().at(-1)).toBe("reconnect_required");
  });

  it("forceRefresh throwing ReconnectRequiredError -> reconnect_required, stop", async () => {
    // Arrange
    const stub = stubChrome();
    const tokenProvider = fakeProvider({
      forceRefresh: vi.fn(async () => {
        throw new ReconnectRequiredError();
      }),
    });
    const bundle = makeDeps({ tokenProvider });
    bundle.upload.mockResolvedValue({ status: "needs_refresh" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.upload).toHaveBeenCalledTimes(1);
    expect(cursorOf(stub.store, "chatgpt")).toBeUndefined();
    expect(bundle.statuses().at(-1)).toBe("reconnect_required");
  });
});

describe("auth + scope stops", () => {
  it("auth_unavailable -> reconnect_required", async () => {
    // Arrange
    stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "auth_unavailable" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.statuses().at(-1)).toBe("reconnect_required");
  });

  it("insufficient_scope -> reconnect_required", async () => {
    // Arrange
    stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "insufficient_scope" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.statuses().at(-1)).toBe("reconnect_required");
  });

  it("a reconnect on chatgpt aborts the whole run (claude not swept)", async () => {
    // Arrange: a two-platform run where chatgpt hits reconnect.
    stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "auth_unavailable" });

    // Act
    await runSync({ deps: bundle.deps });

    // Assert: findTab was called for chatgpt only (run aborted before claude).
    const platformsProbed = bundle.findTab.mock.calls.map((c) => c[0]);
    expect(platformsProbed).toEqual(["chatgpt"]);
  });
});

describe("budget_exhausted", () => {
  it("advances the cursor and does NOT pause when budget_exhausted is true", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(requestOf(conversation("c1", "2026-05-01T00:00:00.000Z"))),
    );
    bundle.upload.mockResolvedValue({
      status: "ok",
      response: okResponse({ conversations_saved: 1, budget_exhausted: true }),
    });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-05-01T00:00:00.000Z");
    expect(pauseOf(stub.store, "chatgpt")).toBeUndefined();
    expect(bundle.statuses().at(-1)).toBe("idle");
  });
});

describe("rate limiting", () => {
  it("upload rate_limited with Retry-After sets pausedUntil; next run skips the platform", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "rate_limited", retryAfterSeconds: 120 });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert: paused 120s into the future.
    const pause = pauseOf(stub.store, "chatgpt");
    expect(pause?.reason).toBe("rate_limited");
    expect(Date.parse(pause!.pausedUntil)).toBe(NOW_MS + 120_000);

    // A subsequent run while still paused must not collect that platform.
    const second = makeDeps();
    await runSync({ platform: "chatgpt", deps: second.deps });
    expect(second.collect).not.toHaveBeenCalled();
    expect(second.statuses().at(-1)).toBe("paused");
  });

  it("honors a Retry-After of 0 as a real zero wait (not the 30-min default)", async () => {
    // Arrange: a 429 advising "retry now". The old `... || DEFAULT` swallowed 0
    // into the 30-min default; it must instead pause until ~now.
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "rate_limited", retryAfterSeconds: 0 });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    const pause = pauseOf(stub.store, "chatgpt");
    expect(pause?.reason).toBe("rate_limited");
    expect(Date.parse(pause!.pausedUntil)).toBe(NOW_MS);
  });

  it("collect-side rate_limited with retryAfter=0 also pauses at ~now", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue({
      status: "rate_limited",
      retryAfterSeconds: 0,
      request: requestOf(),
    });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    const pause = pauseOf(stub.store, "chatgpt");
    expect(pause?.reason).toBe("rate_limited");
    expect(Date.parse(pause!.pausedUntil)).toBe(NOW_MS);
  });
});

describe("transient backoff growth (M4)", () => {
  it("two consecutive transient failures back off longer than one; a success resets", async () => {
    // Arrange: random()=0 so the jitter term is 0 and the grown window is
    // deterministic. Each subsequent wake uses a `now` past the prior pause window
    // (otherwise syncPlatform would short-circuit on the active pause), so the
    // backoff is measured as pausedUntil - now per run.
    const fixedRandom = (): number => 0;
    const stub = stubChrome();

    // Wake 1: first transient failure (consecutive -> 1).
    const now1 = NOW_MS;
    const run1 = makeDeps({ random: fixedRandom, now: () => now1 });
    run1.upload.mockResolvedValue({ status: "transient_http", httpStatus: 503 });
    await runSync({ platform: "chatgpt", deps: run1.deps });
    const backoff1 = Date.parse(pauseOf(stub.store, "chatgpt")!.pausedUntil) - now1;

    // Wake 2: well past the first pause, second consecutive transient (-> 2).
    const now2 = NOW_MS + 60 * 60 * 1000;
    const run2 = makeDeps({ random: fixedRandom, now: () => now2 });
    run2.upload.mockResolvedValue({ status: "transient_http", httpStatus: 503 });
    await runSync({ platform: "chatgpt", deps: run2.deps });
    const backoff2 = Date.parse(pauseOf(stub.store, "chatgpt")!.pausedUntil) - now2;

    // Assert: the second backoff is strictly larger than the first.
    expect(backoff2).toBeGreaterThan(backoff1);

    // Wake 3: a clean run clears the streak.
    const now3 = NOW_MS + 2 * 60 * 60 * 1000;
    const cleanRun = makeDeps({ random: fixedRandom, now: () => now3 });
    await runSync({ platform: "chatgpt", deps: cleanRun.deps });

    // Wake 4: a transient again starts from the base window, equal to backoff1.
    const now4 = NOW_MS + 3 * 60 * 60 * 1000;
    const run4 = makeDeps({ random: fixedRandom, now: () => now4 });
    run4.upload.mockResolvedValue({ status: "transient_http", httpStatus: 503 });
    await runSync({ platform: "chatgpt", deps: run4.deps });
    const backoff4 = Date.parse(pauseOf(stub.store, "chatgpt")!.pausedUntil) - now4;
    expect(backoff4).toBe(backoff1);
  });
});

describe("collect failures", () => {
  it("failed{session_lost} -> partial uploaded, pause session_lost, cursor at partial only", async () => {
    // Arrange: collect failed but carried a partial batch (one conversation).
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue({
      status: "failed",
      reason: "session_lost",
      request: requestOf(conversation("partial", "2026-02-10T00:00:00.000Z")),
    });
    bundle.upload.mockResolvedValue({
      status: "ok",
      response: okResponse({ conversations_saved: 1 }),
    });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert: the partial batch was uploaded and the cursor advanced only to it.
    expect(bundle.upload).toHaveBeenCalledTimes(1);
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-02-10T00:00:00.000Z");
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("session_lost");
  });

  it("waiting_for_tab when no logged-in tab is found", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps({ findTab: vi.fn(async () => null) });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.collect).not.toHaveBeenCalled();
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("waiting_for_tab");
    expect(bundle.statuses().at(-1)).toBe("paused");
  });
});

describe("drift detection", () => {
  it("5 consecutive malformed -> drift pause", async () => {
    // Arrange: one run reporting 6 malformed conversations crosses the threshold.
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(requestOf(conversation("c1", "2026-02-01T00:00:00.000Z")), {
        failures: emptyFailures({ malformed_response: 6 }),
      }),
    );

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("drift");
  });

  it("accumulates malformed across runs before flipping to drift", async () => {
    // Arrange: three runs of 2 malformed each (=6) cross the threshold of 5.
    const stub = stubChrome();
    const collectWith = (): CollectOutcome =>
      collectOk(requestOf(conversation("c1", "2026-02-01T00:00:00.000Z")), {
        failures: emptyFailures({ malformed_response: 2 }),
      });

    const run1 = makeDeps();
    run1.collect.mockResolvedValue(collectWith());
    await runSync({ platform: "chatgpt", deps: run1.deps });
    expect(pauseOf(stub.store, "chatgpt")?.reason).not.toBe("drift");

    const run2 = makeDeps();
    run2.collect.mockResolvedValue(collectWith());
    await runSync({ platform: "chatgpt", deps: run2.deps });
    expect(pauseOf(stub.store, "chatgpt")?.reason).not.toBe("drift");

    // Act: the third run pushes the streak to 6 > 5.
    const run3 = makeDeps();
    run3.collect.mockResolvedValue(collectWith());
    await runSync({ platform: "chatgpt", deps: run3.deps });

    // Assert
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("drift");
  });

  it("a clean collect resets the drift streak even when the upload then pauses (M2)", async () => {
    // Arrange: build a partial drift streak (4 malformed, below the threshold).
    const stub = stubChrome();
    const seedRun = makeDeps();
    seedRun.collect.mockResolvedValue(
      collectOk(requestOf(conversation("c1", "2026-02-01T00:00:00.000Z")), {
        failures: emptyFailures({ malformed_response: 4 }),
      }),
    );
    await runSync({ platform: "chatgpt", deps: seedRun.deps });
    expect(stub.store["gubbi:drift:chatgpt"]).toBe(4);

    // Act: a CLEAN collect (0 malformed) whose upload then hits a transient pause.
    // The streak must reset from the collect result, independent of the pause.
    const cleanThenPaused = makeDeps();
    cleanThenPaused.collect.mockResolvedValue(
      collectOk(requestOf(conversation("c2", "2026-02-02T00:00:00.000Z")), {
        failures: emptyFailures({ malformed_response: 0 }),
      }),
    );
    cleanThenPaused.upload.mockResolvedValue({ status: "transient_http", httpStatus: 503 });
    await runSync({ platform: "chatgpt", deps: cleanThenPaused.deps });

    // Assert: the drift streak was cleared (not left at 4), and the pause is the
    // transient one from the upload -- NOT drift.
    expect(stub.store["gubbi:drift:chatgpt"]).toBeUndefined();
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("transient");
  });
});

describe("continuation wake", () => {
  it("schedules a continuation when collect reports complete=false", async () => {
    // Arrange
    stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(requestOf(conversation("c1", "2026-02-01T00:00:00.000Z")), { complete: false }),
    );

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.scheduleContinuation).toHaveBeenCalledTimes(1);
  });

  it("does NOT schedule a continuation when collect is complete", async () => {
    // Arrange
    stubChrome();
    const bundle = makeDeps();

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.scheduleContinuation).not.toHaveBeenCalled();
  });
});

describe("batching", () => {
  it("splits more than 50 conversations into <=50 batches in watermark order", async () => {
    // Arrange: 51 conversations with ascending watermarks (built in reverse to
    // prove the orchestrator sorts before batching). Watermarks are minute-spaced
    // ISO timestamps so string order matches chronological order.
    const stub = stubChrome();
    const conversations = Array.from({ length: 51 }, (_, i) => {
      const minute = String(i).padStart(2, "0");
      return conversation(`c${i}`, `2026-02-01T00:${minute}:00.000Z`);
    }).reverse();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(collectOk(requestOf(...conversations)));
    bundle.upload.mockResolvedValue({
      status: "ok",
      response: okResponse({ conversations_saved: 1 }),
    });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert: two batches (50 + 1), each within the cap.
    expect(bundle.upload).toHaveBeenCalledTimes(2);
    const sizes = bundle.upload.mock.calls.map(
      (c) => (c[0] as IngestConversationRequest).conversations.length,
    );
    expect(sizes).toEqual([50, 1]);
    // Final cursor is the global max watermark (minute 50).
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-02-01T00:50:00.000Z");
  });
});
