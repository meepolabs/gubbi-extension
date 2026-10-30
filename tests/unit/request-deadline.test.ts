import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each caller of the egress guard, driven through the REAL guardedFetch with
// global fetch stubbed to stall, so the deadline is exercised end to end and the
// caller's own catch path decides the outcome.

import { INGEST_UPLOAD_TIMEOUT_MS, uploadConversations } from "../../src/lib/api";
import { ReconnectRequiredError } from "../../src/lib/auth/errors";
import { exchangeCode } from "../../src/lib/auth/exchange";
import { forceRefresh } from "../../src/lib/auth/provider";
import { unpair } from "../../src/lib/auth/revoke";
import { DEFAULT_FETCH_TIMEOUT_MS } from "../../src/lib/net/fetch";
import type { IngestConversationRequest } from "../../src/lib/schema/ingest";
import { getAuthBlob, setAuthBlob, type AuthBlob } from "../../src/lib/storage";
import type { TokenProvider } from "../../src/lib/token-provider";
import { stubChromeStorageWithEvents } from "../helpers/chrome-stub";

function track<T>(promise: Promise<T>): {
  readonly state: () => string;
  readonly value: () => T | undefined;
  readonly error: () => unknown;
} {
  let state = "pending";
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (result) => {
      state = "resolved";
      value = result;
    },
    (reason: unknown) => {
      state = "rejected";
      error = reason;
    },
  );
  return { state: () => state, value: () => value, error: () => error };
}

function stallRequest(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
}

function stallBody(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
  });
}

function okBlob(): AuthBlob {
  return {
    version: 1,
    accessToken: "at_cached",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "rt_1",
    status: "ok",
    updatedAt: new Date().toISOString(),
  };
}

const uploadRequest: IngestConversationRequest = {
  source: "extension_chatgpt",
  conversations: [
    {
      platform: "chatgpt",
      platform_id: "p1",
      title: "",
      created_at: "2026-01-01T00:00:00Z",
      messages: [{ role: "user", content: "hi" }],
    },
  ],
};

const provider: TokenProvider = {
  getAccessToken: async () => "at_test",
  forceRefresh: async () => "at_test",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request deadline at each caller", () => {
  it("resolves an upload whose body never finishes to a network outcome at the upload deadline", async () => {
    // Arrange
    stallBody();

    // Act
    const outcome = track(uploadConversations(uploadRequest, provider));
    await vi.advanceTimersByTimeAsync(INGEST_UPLOAD_TIMEOUT_MS - 1);
    const beforeDeadline = outcome.state();
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(beforeDeadline).toBe("pending");
    expect(outcome.value()).toEqual({ status: "network" });
  });

  it("rejects a stalled forced refresh with ReconnectRequiredError and persists reconnect_required", async () => {
    // Arrange
    stubChromeStorageWithEvents();
    await setAuthBlob(okBlob());
    stallRequest();

    // Act
    const outcome = track(forceRefresh());
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS - 1);
    const beforeDeadline = outcome.state();
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(beforeDeadline).toBe("pending");
    expect(outcome.error()).toBeInstanceOf(ReconnectRequiredError);
    expect((await getAuthBlob())?.status).toBe("reconnect_required");
  });

  it("maps a stalled code exchange to the network reason at the default deadline", async () => {
    // Arrange
    stallBody();

    // Act
    const outcome = track(
      exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "https://example.test/cb" }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS);

    // Assert
    expect(outcome.value()).toEqual({ ok: false, reason: "network" });
  });

  it("finishes unpairing after a stalled revoke reaches the default deadline", async () => {
    // Arrange
    stubChromeStorageWithEvents();
    await setAuthBlob(okBlob());
    stallRequest();

    // Act
    const outcome = track(unpair());
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS);

    // Assert
    expect(outcome.value()).toEqual({ ok: true });
    expect(await getAuthBlob()).toBeUndefined();
  });
});
