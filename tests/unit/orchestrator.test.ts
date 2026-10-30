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
import { clearAccountState } from "../../src/lib/account-state";
import { runSync, type RunSyncDeps } from "../../src/lib/sync/orchestrator";
import { INGEST_MAX_BODY_BYTES, serializeRequest, uploadConversations } from "../../src/lib/api";
import { LockContendedError } from "../../src/lib/locks";
import { ClaudeFetcher } from "../../src/lib/connectors/claude/fetch";
import { makeContentMessageListener } from "../../src/lib/connectors/content-listener";
import {
  parseRetryAfter,
  resetSourceRequestTiming,
  setSourceRequestTiming,
} from "../../src/lib/connectors/http";
import { collectFromTab } from "../../src/lib/sync/collect";
import {
  stubChromeStorageWithEvents,
  stubPairedChromeStorage as stubChrome,
} from "../helpers/chrome-stub";

import rawClaudeConversation from "../fixtures/raw-claude-conversation.json";

// The orchestrator goes through storage.ts (cursor/counters/pause/events) and
// locks.ts (lease), both of which use write-then-read-back and onChanged, so the
// stub must persist writes and dispatch changes.

// ---- Builders ----------------------------------------------------------------

const NOW_MS = Date.parse("2026-06-06T12:00:00.000Z");
const DRIFT_BACKOFF_MS = 30 * 60 * 1000;

function emptyFailures(overrides: Partial<FailureCounts> = {}): FailureCounts {
  return {
    no_tab: 0,
    session_lost: 0,
    rate_limited: 0,
    transient_http: 0,
    network: 0,
    malformed_response: 0,
    org_ambiguous: 0,
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

function okResponse(
  overrides: Partial<IngestConversationResponse> = {},
): IngestConversationResponse {
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
function countersOf(
  store: Record<string, unknown>,
): { conversations_uploaded: number; conversations_skipped: number } | undefined {
  return store["gubbi:counters"] as
    | { conversations_uploaded: number; conversations_skipped: number }
    | undefined;
}
function pauseOf(
  store: Record<string, unknown>,
  platform: AdapterPlatform,
): { reason: string; pausedUntil: string } | undefined {
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
  vi.unstubAllEnvs();
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

describe("token unavailable without a definitive rejection", () => {
  it("forceRefresh rejecting with a plain Error after a 401 -> transient pause, no reconnect", async () => {
    // Arrange
    const stub = stubChrome();
    const tokenProvider = fakeProvider({
      forceRefresh: vi.fn(async () => {
        throw new Error("storage write failed");
      }),
    });
    const bundle = makeDeps({ tokenProvider });
    bundle.upload.mockResolvedValue({ status: "needs_refresh" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.upload).toHaveBeenCalledTimes(1);
    expect(cursorOf(stub.store, "chatgpt")).toBeUndefined();
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("transient");
    expect(bundle.statuses()).not.toContain("reconnect_required");
    expect(bundle.statuses().at(-1)).toBe("paused");
  });

  it("forceRefresh rejecting with LockContendedError after a 401 -> transient pause, no reconnect", async () => {
    // Arrange
    const stub = stubChrome();
    const tokenProvider = fakeProvider({
      forceRefresh: vi.fn(async () => {
        throw new LockContendedError("gubbi:authLock");
      }),
    });
    const bundle = makeDeps({ tokenProvider });
    bundle.upload.mockResolvedValue({ status: "needs_refresh" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("transient");
    expect(bundle.statuses()).not.toContain("reconnect_required");
  });

  it("token_unavailable -> transient pause, cursor unchanged, no reconnect", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "token_unavailable" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(cursorOf(stub.store, "chatgpt")).toBeUndefined();
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("transient");
    expect(bundle.statuses()).not.toContain("reconnect_required");
  });

  it("getAccessToken rejecting with LockContendedError through the real upload client -> transient pause, no reconnect", async () => {
    // Arrange
    const stub = stubChrome();
    const tokenProvider = fakeProvider({
      getAccessToken: vi.fn(async () => {
        throw new LockContendedError("gubbi:authLock");
      }),
    });
    const bundle = makeDeps({ tokenProvider, upload: uploadConversations });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(tokenProvider.getAccessToken).toHaveBeenCalled();
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("transient");
    expect(bundle.statuses()).not.toContain("reconnect_required");
  });

  it("getAccessToken rejecting with ReconnectRequiredError through the real upload client -> reconnect_required", async () => {
    // Arrange
    stubChrome();
    const tokenProvider = fakeProvider({
      getAccessToken: vi.fn(async () => {
        throw new ReconnectRequiredError();
      }),
    });
    const bundle = makeDeps({ tokenProvider, upload: uploadConversations });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
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

  it("floors an upload Retry-After of 0 at a 60 s pause", async () => {
    // Arrange: a 429 advising "retry now" must not let the next wake hammer the API.
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "rate_limited", retryAfterSeconds: 0 });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    const pause = pauseOf(stub.store, "chatgpt");
    expect(pause?.reason).toBe("rate_limited");
    expect(Date.parse(pause!.pausedUntil)).toBe(NOW_MS + 60_000);
  });

  it("floors a source Retry-After of 0 at a 60 s pause", async () => {
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
    expect(Date.parse(pause!.pausedUntil)).toBe(NOW_MS + 60_000);
  });

  it("pauses for the 30 min default when a 429 carries no Retry-After", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "rate_limited", retryAfterSeconds: null });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    const pause = pauseOf(stub.store, "chatgpt");
    expect(pause?.reason).toBe("rate_limited");
    expect(Date.parse(pause!.pausedUntil)).toBe(NOW_MS + 30 * 60_000);
  });

  // Retry-After values whose seconds overflow a Date: the header parser hands
  // them through, so the pause must cap them rather than throw mid-run.
  it.each([
    { name: "a 13-digit Retry-After", header: "8640000000000" },
    { name: "a 400-digit Retry-After", header: "9".repeat(400) },
    { name: "a ten-year Retry-After", header: "315360000" },
  ])("caps $name at a 24 h pause and leaves the platform paused", async ({ header }) => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    const retryAfterSeconds = parseRetryAfter(
      new Response(null, { status: 429, headers: { "retry-after": header } }),
    );
    bundle.upload.mockResolvedValue({
      status: "rate_limited",
      retryAfterSeconds: retryAfterSeconds ?? null,
    });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    const pause = pauseOf(stub.store, "chatgpt");
    expect(pause?.reason).toBe("rate_limited");
    expect(Date.parse(pause!.pausedUntil)).toBe(NOW_MS + 24 * 60 * 60_000);
    expect(bundle.statuses().at(-1)).toBe("paused");
  });

  it.each([
    { name: "NaN from upload", via: "upload", retryAfterSeconds: Number.NaN },
    { name: "a string from upload", via: "upload", retryAfterSeconds: "soon" },
    { name: "a string from collect", via: "collect", retryAfterSeconds: "soon" },
  ] as const)(
    "pauses for the 30 min default when Retry-After is $name",
    async ({ via, retryAfterSeconds }) => {
      // Arrange: a stale content script can reply with any JSON value here.
      const stub = stubChrome();
      const bundle = makeDeps();
      const hint = retryAfterSeconds as unknown as number;
      if (via === "upload") {
        bundle.upload.mockResolvedValue({ status: "rate_limited", retryAfterSeconds: hint });
      } else {
        bundle.collect.mockResolvedValue({
          status: "rate_limited",
          retryAfterSeconds: hint,
          request: requestOf(),
        });
      }

      // Act
      await runSync({ platform: "chatgpt", deps: bundle.deps });

      // Assert
      const pause = pauseOf(stub.store, "chatgpt");
      expect(Date.parse(pause!.pausedUntil)).toBe(NOW_MS + 30 * 60_000);
      expect(bundle.statuses().at(-1)).toBe("paused");
    },
  );
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

  it.each([
    {
      name: "failed",
      outcome: {
        status: "failed",
        reason: "transient",
        request: requestOf(conversation("partial", "2026-02-10T00:00:00.000Z")),
      },
    },
    {
      name: "rate_limited",
      outcome: {
        status: "rate_limited",
        retryAfterSeconds: 60,
        request: requestOf(conversation("partial", "2026-02-10T00:00:00.000Z")),
      },
    },
  ] as const)(
    "a $name partial collect keeps the drift pause from an oversize_batch upload",
    async ({ outcome }) => {
      // Arrange
      const stub = stubChrome();
      const bundle = makeDeps();
      bundle.collect.mockResolvedValue(outcome);
      bundle.upload.mockResolvedValue({ status: "oversize_batch" });

      // Act
      await runSync({ platform: "chatgpt", deps: bundle.deps });

      // Assert
      expect(bundle.upload).toHaveBeenCalledTimes(1);
      expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("drift");
      expect(cursorOf(stub.store, "chatgpt")).toBeUndefined();
    },
  );

  it("failed{org_ambiguous} -> pause org_ambiguous for the drift window, no transient bump", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue({
      status: "failed",
      reason: "org_ambiguous",
      request: requestOf(),
    });

    // Act
    await runSync({ platform: "claude", deps: bundle.deps });

    // Assert
    const paused = pauseOf(stub.store, "claude");
    expect(paused?.reason).toBe("org_ambiguous");
    expect(Date.parse(paused!.pausedUntil) - NOW_MS).toBe(DRIFT_BACKOFF_MS);
    expect(stub.store["gubbi:transient:claude"]).toBeUndefined();
    expect(bundle.upload).not.toHaveBeenCalled();
    expect(bundle.statuses().at(-1)).toBe("paused");
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

// Drives the real content side: chrome.tabs.sendMessage is routed into the
// Claude content listener backed by a real ClaudeFetcher over a stubbed fetch,
// and the real collectFromTab is the orchestrator's collect.
function routeTabsToClaudeContent(): void {
  const listener = makeContentMessageListener("claude", new ClaudeFetcher());
  const tabs = {
    sendMessage: vi.fn(
      (_tabId: number, message: unknown) =>
        new Promise((resolve) => {
          listener(message, undefined, resolve);
        }),
    ),
  };
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.tabs = tabs;
}

function stubClaudeSite(organizations: unknown): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const body = url.endsWith("/api/organizations")
      ? organizations
      : url.includes("/chat_conversations_v2")
        ? {
            data: [{ uuid: "conv-1", name: "", updated_at: "2026-02-01T00:00:00Z" }],
            has_more: false,
          }
        : rawClaudeConversation;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  return urls;
}

describe("Claude organization resolution through the content side", () => {
  beforeEach(() => {
    setSourceRequestTiming({ spacingMs: 0 });
  });

  afterEach(() => {
    resetSourceRequestTiming();
  });

  it("pauses as org_ambiguous with no conversation requests when two chat orgs exist", async () => {
    // Arrange
    const stub = stubChrome();
    routeTabsToClaudeContent();
    const urls = stubClaudeSite([
      { uuid: "org-chat-1", capabilities: ["chat"] },
      { uuid: "org-chat-2", capabilities: ["chat"] },
    ]);
    const bundle = makeDeps({ collect: collectFromTab });

    // Act
    await runSync({ platform: "claude", deps: bundle.deps });

    // Assert
    expect(pauseOf(stub.store, "claude")?.reason).toBe("org_ambiguous");
    expect(urls.filter((u) => u.includes("/chat_conversations"))).toEqual([]);
    expect(bundle.upload).not.toHaveBeenCalled();
    expect(bundle.statuses().at(-1)).toBe("paused");
  });

  it("syncs a single chat org end to end with one organizations request", async () => {
    // Arrange
    const stub = stubChrome();
    routeTabsToClaudeContent();
    const urls = stubClaudeSite([
      { uuid: "org-chat", capabilities: ["chat"] },
      { uuid: "org-api", capabilities: ["api"] },
    ]);
    const bundle = makeDeps({ collect: collectFromTab });

    // Act
    await runSync({ platform: "claude", deps: bundle.deps });

    // Assert
    expect(bundle.upload).toHaveBeenCalledTimes(1);
    expect(pauseOf(stub.store, "claude")).toBeUndefined();
    expect(urls.filter((u) => u.endsWith("/api/organizations"))).toHaveLength(1);
    expect(bundle.statuses().at(-1)).toBe("idle");
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

describe("watermarks with UTC offsets", () => {
  it("orders batches and picks the cursor by instant, not by text", async () => {
    // Arrange: "early" sorts after "late" as text but is three hours earlier as
    // an instant, and "textMax" is the text maximum of the first batch while
    // "early" is its latest instant. 50 conversations fill the first batch, the
    // second batch ("late") fails, so the cursor must stop before "late".
    const stub = stubChrome();
    const filler = Array.from({ length: 48 }, (_, i) =>
      conversation(`f${i}`, `2026-02-01T00:${String(i).padStart(2, "0")}:00.000Z`),
    );
    const textMax = conversation("textMax", "2026-02-02T09:30:00.000+06:00");
    const early = conversation("early", "2026-02-02T09:00:00.000+05:00");
    const late = conversation("late", "2026-02-02T07:00:00.000Z");
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(collectOk(requestOf(late, early, textMax, ...filler)));
    bundle.upload
      .mockResolvedValueOnce({ status: "ok", response: okResponse({ conversations_saved: 50 }) })
      .mockResolvedValue({ status: "transient_http" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.upload).toHaveBeenCalledTimes(2);
    const batches = bundle.upload.mock.calls.map((c) =>
      (c[0] as IngestConversationRequest).conversations.map((conv) => conv.platform_id),
    );
    expect(batches[0]).toEqual(expect.arrayContaining(["early", "textMax"]));
    expect(batches[1]).toEqual(["late"]);
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-02-02T09:00:00.000+05:00");
  });

  it("reads a watermark with no zone designator as UTC", async () => {
    // Arrange: as text the zoneless value sorts first; as UTC it is the later
    // instant, so it must become the cursor. A local zone ahead of UTC makes a
    // local-time reading of it the earlier instant.
    vi.stubEnv("TZ", "Asia/Kolkata");
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(
        requestOf(
          conversation("zoneless", "2026-02-02T06:00:00"),
          conversation("offset", "2026-02-02T10:00:00+05:00"),
        ),
      ),
    );

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-02-02T06:00:00");
  });
});

describe("watermarks with sub-millisecond precision", () => {
  it("orders same-millisecond watermarks by their full fractional second", async () => {
    // Arrange: both watermarks fall in the same millisecond, so only the
    // microsecond digits order them. The later one comes first from the
    // collector; 49 earlier conversations put the boundary between the two, and
    // the second batch fails, so the cursor must stop at the earlier one.
    const stub = stubChrome();
    const earlier = Array.from({ length: 49 }, (_, i) =>
      conversation(`e${i}`, `2026-02-01T00:${String(i).padStart(2, "0")}:00.000Z`),
    );
    const laterMicros = conversation("laterMicros", "2026-02-02T00:00:00.000999Z");
    const earlierMicros = conversation("earlierMicros", "2026-02-02T00:00:00.000001Z");
    const run1 = makeDeps();
    run1.collect.mockResolvedValue(collectOk(requestOf(...earlier, laterMicros, earlierMicros)));
    run1.upload
      .mockResolvedValueOnce({ status: "ok", response: okResponse({ conversations_saved: 50 }) })
      .mockResolvedValue({ status: "transient_http", httpStatus: 503 });

    // Act: the failed run, then a later wake past the backoff window.
    await runSync({ platform: "chatgpt", deps: run1.deps });
    const cursorAfterFailure = cursorOf(stub.store, "chatgpt");
    const run2 = makeDeps({ now: () => NOW_MS + 60 * 60 * 1000 });
    await runSync({ platform: "chatgpt", deps: run2.deps });
    const since = run2.collect.mock.calls[0]?.[2] as string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.includes("/chat_conversations")
        ? {
            data: [{ uuid: "laterMicros", name: "", updated_at: "2026-02-02T00:00:00.000999Z" }],
            has_more: false,
          }
        : [{ uuid: "org", capabilities: ["chat"] }];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const listed = await new ClaudeFetcher().listConversationsRaw(since);

    // Assert
    const batches = run1.upload.mock.calls.map((c) =>
      (c[0] as IngestConversationRequest).conversations.map((conv) => conv.platform_id),
    );
    expect(batches[1]).toEqual(["laterMicros"]);
    expect(cursorAfterFailure).toBe("2026-02-02T00:00:00.000001Z");
    expect(since).toBeDefined();
    expect(listed.status === "ok" ? listed.data.map((s) => s.platform_id) : []).toEqual([
      "laterMicros",
    ]);
  });
});

// ---- Byte-cap helpers ----------------------------------------------------------

const utf8 = new TextEncoder();

function bodyBytes(request: IngestConversationRequest): number {
  return utf8.encode(serializeRequest(request)).length;
}

// A conversation whose single message content is padded with `filler` so the
// conversation's own serialized JSON grows by `fillerCount` repetitions.
function paddedConversation(
  platformId: string,
  updatedAt: string,
  fillerCount: number,
  filler = "a",
): IngestConversationRequest["conversations"][number] {
  return {
    ...conversation(platformId, updatedAt),
    messages: [{ role: "user", content: filler.repeat(fillerCount) }],
  };
}

// Pads a conversation so a request holding only it serializes to exactly
// `targetBytes` UTF-8 bytes.
function conversationWithRequestBytes(
  platformId: string,
  updatedAt: string,
  targetBytes: number,
): IngestConversationRequest["conversations"][number] {
  const base = bodyBytes(requestOf(paddedConversation(platformId, updatedAt, 0)));
  return paddedConversation(platformId, updatedAt, targetBytes - base);
}

function uploadedBatches(upload: ReturnType<typeof vi.fn>): IngestConversationRequest[] {
  return upload.mock.calls.map((c) => c[0] as IngestConversationRequest);
}

function uploadedIds(upload: ReturnType<typeof vi.fn>): string[][] {
  return uploadedBatches(upload).map((b) => b.conversations.map((c) => c.platform_id));
}

describe("byte-aware batching", () => {
  it("splits two conversations each at 60% of the body cap into two batches", async () => {
    // Arrange
    stubChrome();
    const size = Math.floor(INGEST_MAX_BODY_BYTES * 0.6);
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(
        requestOf(
          conversationWithRequestBytes("late", "2026-02-02T00:00:00.000Z", size),
          conversationWithRequestBytes("early", "2026-02-01T00:00:00.000Z", size),
        ),
      ),
    );

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(uploadedIds(bundle.upload)).toEqual([["early"], ["late"]]);
    for (const batch of uploadedBatches(bundle.upload)) {
      expect(bodyBytes(batch)).toBeLessThanOrEqual(INGEST_MAX_BODY_BYTES);
    }
  });

  it.each([
    { name: "exactly the cap goes as one batch", extraBytes: 0, expectedBatches: 1 },
    { name: "one byte over the cap splits into two batches", extraBytes: 1, expectedBatches: 2 },
  ])("a two-conversation request of $name", async ({ extraBytes, expectedBatches }) => {
    // Arrange: size the second conversation so the combined request serializes to
    // the cap plus extraBytes.
    stubChrome();
    const first = paddedConversation("c1", "2026-02-01T00:00:00.000Z", 1000);
    const secondBase = paddedConversation("c2", "2026-02-02T00:00:00.000Z", 0);
    const baseBytes = bodyBytes(requestOf(first, secondBase));
    const second = paddedConversation(
      "c2",
      "2026-02-02T00:00:00.000Z",
      INGEST_MAX_BODY_BYTES + extraBytes - baseBytes,
    );
    expect(bodyBytes(requestOf(first, second))).toBe(INGEST_MAX_BODY_BYTES + extraBytes);
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(collectOk(requestOf(first, second)));

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.upload).toHaveBeenCalledTimes(expectedBatches);
    if (expectedBatches === 1) {
      expect(bodyBytes(uploadedBatches(bundle.upload)[0]!)).toBe(INGEST_MAX_BODY_BYTES);
    }
  });

  it("drops a single over-cap conversation, counts it skipped, keeps watermark order", async () => {
    // Arrange: built in reverse so the orchestrator must sort; the middle
    // conversation alone serializes one byte over the cap.
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(
        requestOf(
          conversation("c3", "2026-02-03T00:00:00.000Z"),
          conversationWithRequestBytes(
            "big",
            "2026-02-02T00:00:00.000Z",
            INGEST_MAX_BODY_BYTES + 1,
          ),
          conversation("c1", "2026-02-01T00:00:00.000Z"),
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
    expect(uploadedIds(bundle.upload)).toEqual([["c1", "c3"]]);
    expect(countersOf(stub.store)?.conversations_skipped).toBe(1);
    expect(countersOf(stub.store)?.conversations_uploaded).toBe(2);
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-02-03T00:00:00.000Z");
  });

  it("measures the cap in UTF-8 bytes, not string length", async () => {
    // Arrange: content under the cap in UTF-16 code units but over it in bytes
    // (each "e-acute" is one code unit and two UTF-8 bytes).
    const stub = stubChrome();
    const multibyte = paddedConversation(
      "wide",
      "2026-02-02T00:00:00.000Z",
      Math.ceil(INGEST_MAX_BODY_BYTES / 2),
      "\u00e9",
    );
    expect(serializeRequest(requestOf(multibyte)).length).toBeLessThan(INGEST_MAX_BODY_BYTES);
    expect(bodyBytes(requestOf(multibyte))).toBeGreaterThan(INGEST_MAX_BODY_BYTES);
    const bundle = makeDeps();
    bundle.collect.mockResolvedValue(
      collectOk(requestOf(multibyte, conversation("c1", "2026-02-01T00:00:00.000Z"))),
    );

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(uploadedIds(bundle.upload)).toEqual([["c1"]]);
    expect(countersOf(stub.store)?.conversations_skipped).toBe(1);
  });
});

describe("oversize_batch from the server", () => {
  it("sets a drift pause and uploads the batch once with no retry", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.upload.mockResolvedValue({ status: "oversize_batch" });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.upload).toHaveBeenCalledTimes(1);
    expect(pauseOf(stub.store, "chatgpt")?.reason).toBe("drift");
    expect(cursorOf(stub.store, "chatgpt")).toBeUndefined();
    expect(bundle.statuses().at(-1)).toBe("paused");
  });
});

describe("per-platform enabled flag", () => {
  it("skips a disabled platform in a full run", async () => {
    // Arrange
    const stub = stubChrome();
    stub.store["gubbi:enabled:claude"] = false;
    const bundle = makeDeps();

    // Act
    await runSync({ deps: bundle.deps });

    // Assert
    expect(bundle.collect.mock.calls.map((call) => call[1])).toEqual(["chatgpt"]);
  });

  it("skips a disabled platform in a manual single-platform run", async () => {
    // Arrange
    const stub = stubChrome();
    stub.store["gubbi:enabled:claude"] = false;
    const bundle = makeDeps();

    // Act
    await runSync({ platform: "claude", deps: bundle.deps });

    // Assert
    expect(bundle.findTab).not.toHaveBeenCalled();
    expect(bundle.collect).not.toHaveBeenCalled();
  });

  it("finishes the in-flight upload when the flag is turned off during collect", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    bundle.collect.mockImplementation(async () => {
      stub.store["gubbi:enabled:chatgpt"] = false;
      return collectOk(requestOf(conversation("c1", "2026-02-01T00:00:00.000Z")));
    });

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.upload).toHaveBeenCalledTimes(1);
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("per-platform lastRunAt", () => {
  it("records the injected clock when a sweep reaches collect", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(stub.store["gubbi:lastRunAt:chatgpt"]).toBe(new Date(NOW_MS).toISOString());
    expect(stub.store["gubbi:lastRunAt:claude"]).toBeUndefined();
  });

  it("leaves lastRunAt unchanged when the sweep is skipped by an active pause", async () => {
    // Arrange
    const stub = stubChrome();
    const previous = "2026-06-01T00:00:00.000Z";
    stub.store["gubbi:lastRunAt:chatgpt"] = previous;
    stub.store["gubbi:pauseState:chatgpt"] = {
      pausedUntil: new Date(NOW_MS + 60_000).toISOString(),
      reason: "rate_limited",
    };
    const bundle = makeDeps();

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.collect).not.toHaveBeenCalled();
    expect(stub.store["gubbi:lastRunAt:chatgpt"]).toBe(previous);
  });
});

describe("unpaired runs", () => {
  it("does nothing and writes nothing when no account is paired", async () => {
    // Arrange
    const stub = stubChromeStorageWithEvents();
    const bundle = makeDeps();

    // Act
    await runSync({ deps: bundle.deps });

    // Assert
    expect(bundle.findTab).not.toHaveBeenCalled();
    expect(bundle.collect).not.toHaveBeenCalled();
    expect(bundle.setStatus).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(stub.store).toEqual({});
  });

  it("syncs as before when an account is paired", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();

    // Act
    await runSync({ platform: "chatgpt", deps: bundle.deps });

    // Assert
    expect(bundle.collect).toHaveBeenCalledTimes(1);
    expect(bundle.upload).toHaveBeenCalledTimes(1);
    expect(cursorOf(stub.store, "chatgpt")).toBe("2026-02-01T00:00:00.000Z");
    expect(stub.store["gubbi:lastRunAt:chatgpt"]).toBe(new Date(NOW_MS).toISOString());
  });

  it("recreates no account state after the account is cleared", async () => {
    // Arrange
    const stub = stubChrome();
    const bundle = makeDeps();
    await runSync({ deps: bundle.deps });
    expect(stub.store["gubbi:syncEvents"]).toBeDefined();
    await clearAccountState();
    const afterUnpair = structuredClone(stub.store);
    bundle.collect.mockClear();

    // Act
    await runSync({ deps: bundle.deps });

    // Assert
    expect(bundle.collect).not.toHaveBeenCalled();
    expect(stub.store).toEqual(afterUnpair);
  });
});
