import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// unpair() revokes via POST /oauth2/revoke (best effort) then clears ALL local
// auth state. Mocks guardedFetch and uses the real storage layer with an
// in-memory chrome.storage stub.

vi.mock("../../src/lib/net/fetch", () => ({ guardedFetch: vi.fn() }));

import { guardedFetch } from "../../src/lib/net/fetch";
import { unpair } from "../../src/lib/auth/revoke";
import {
  getAuthBlob,
  getRefreshState,
  getPendingAuthFlow,
  getPauseState,
  setAuthBlob,
  setPendingAuthFlow,
  setRefreshState,
  setPauseState,
  type AuthBlob,
} from "../../src/lib/storage";
import { stubChromeStorage, stubChromeStorageWithEvents } from "../helpers/chrome-stub";

function okBlob(): AuthBlob {
  return {
    version: 2,
    accessToken: "at",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "rt_to_revoke",
    status: "ok",
    updatedAt: new Date().toISOString(),
  };
}

const CONSOLE_LEVELS = ["debug", "info", "warn", "error"] as const;

let consoleSpies: MockInstance<(...args: unknown[]) => void>[] = [];

beforeEach(() => {
  consoleSpies = CONSOLE_LEVELS.map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("unpair", () => {
  it("posts /oauth2/revoke with the refresh token, then clears all local state", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob());
    await setPendingAuthFlow({
      state: "s",
      codeVerifier: "v",
      redirectUri: "https://example.com",
      startedAt: new Date().toISOString(),
    });
    await setRefreshState({
      ownerId: "x",
      authVersionBefore: 1,
      startedAt: new Date().toISOString(),
    });
    await setPauseState("chatgpt", {
      pausedUntil: new Date().toISOString(),
      reason: "rate_limited",
    });
    await setPauseState("claude", { pausedUntil: new Date().toISOString(), reason: "transient" });
    vi.mocked(guardedFetch).mockResolvedValue(new Response(null, { status: 200 }));

    // Act
    const result = await unpair();

    // Assert: revoke was called with the correct body.
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(guardedFetch).mock.calls[0]!;
    expect(new URL(input as string).pathname).toBe("/oauth2/revoke");
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("token")).toBe("rt_to_revoke");
    expect(body.get("token_type_hint")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("journal-extension");

    // Assert: all local state cleared.
    expect(await getAuthBlob()).toBeUndefined();
    expect(await getPendingAuthFlow()).toBeUndefined();
    expect(await getRefreshState()).toBeUndefined();
    expect(await getPauseState("chatgpt")).toBeUndefined();
    expect(await getPauseState("claude")).toBeUndefined();
    expect(result).toEqual({ ok: true });
  });

  it("tolerates network failure on the revoke call (still clears local state)", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockRejectedValue(new Error("offline"));

    // Act
    await unpair();

    // Assert: local state cleared despite the revoke failure.
    expect(await getAuthBlob()).toBeUndefined();
    expect(await getRefreshState()).toBeUndefined();
  });

  it("handles missing authBlob gracefully (no revoke call, still clears)", async () => {
    // Arrange
    stubChromeStorage();
    // No authBlob written.
    await setPendingAuthFlow({
      state: "x",
      codeVerifier: "y",
      redirectUri: "https://r.com",
      startedAt: new Date().toISOString(),
    });

    // Act
    await unpair();

    // Assert
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(await getPendingAuthFlow()).toBeUndefined();
  });

  it("sweeps every account-scoped key and keeps the device preferences", async () => {
    // Arrange
    const { store } = stubChromeStorage();
    await setAuthBlob(okBlob());
    const swept = {
      "gubbi:cursor:chatgpt": "2026-01-01T00:00:00Z",
      "gubbi:cursor:claude": "2026-01-01T00:00:00Z",
      "gubbi:pauseState:chatgpt": { pausedUntil: "2026-01-01T00:00:00Z", reason: "drift" },
      "gubbi:drift:chatgpt": 2,
      "gubbi:transient:claude": 1,
      "gubbi:counters": { conversations_uploaded: 3, conversations_skipped: 0, last_run_at: null },
      "gubbi:status:chatgpt": "error",
      "gubbi:lastRunAt:claude": "2026-01-01T00:00:00Z",
      "gubbi:syncEvents": [{ at: "2026-01-01T00:00:00Z", kind: "run_start" }],
      "gubbi:future-key": "anything",
    };
    const kept = {
      "gubbi:schema_version": 1,
      "gubbi:enabled:chatgpt": false,
      "gubbi:enabled:claude": true,
    };
    Object.assign(store, swept, kept, { "gubbi:accountGeneration": 2 });
    vi.mocked(guardedFetch).mockResolvedValue(new Response(null, { status: 200 }));

    // Act
    const result = await unpair();

    // Assert
    expect(result).toEqual({ ok: true });
    expect(store).toEqual({ ...kept, "gubbi:accountGeneration": 3 });
  });

  it("takes the sync lease before the auth lock", async () => {
    // Arrange
    const { writeLog } = stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockResolvedValue(new Response(null, { status: 200 }));

    // Act
    await unpair();

    // Assert
    const leaseAt = writeLog.indexOf("set:gubbi:lease");
    const authLockAt = writeLog.indexOf("set:gubbi:authLock");
    expect(leaseAt).toBeGreaterThanOrEqual(0);
    expect(authLockAt).toBeGreaterThan(leaseAt);
  });

  it("logs a rejected revoke by status only and still clears local state", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockResolvedValue(
      new Response("invalid token rt_to_revoke", { status: 500 }),
    );

    // Act
    const result = await unpair();

    // Assert
    expect(result).toEqual({ ok: true });
    expect(await getAuthBlob()).toBeUndefined();
    const lines = consoleSpies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
    expect(lines.some((line) => line.includes('"status":500'))).toBe(true);
    expect(lines.filter((line) => line.includes("rt_to_revoke"))).toEqual([]);
  });
});

describe("unpair under contention", () => {
  const LOCK_WAIT_MS = 30_000;

  function liveLock(): { ownerId: string; acquiredAt: number; heartbeatAt: number } {
    return { ownerId: "other", acquiredAt: Date.now(), heartbeatAt: Date.now() };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns busy and clears nothing while a sync run holds the lease throughout", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    await setAuthBlob(okBlob());
    store["gubbi:cursor:chatgpt"] = "2026-01-01T00:00:00Z";
    store["gubbi:lease"] = liveLock();
    vi.mocked(guardedFetch).mockResolvedValue(new Response(null, { status: 200 }));

    // Act
    const outcome = unpair();
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);

    // Assert
    expect(await outcome).toEqual({ ok: false, reason: "busy" });
    expect(await getAuthBlob()).toBeDefined();
    expect(store["gubbi:cursor:chatgpt"]).toBe("2026-01-01T00:00:00Z");
    expect(store["gubbi:lease"]).toMatchObject({ ownerId: "other" });
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("proceeds once the sync run releases the lease during the wait", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    await setAuthBlob(okBlob());
    store["gubbi:lease"] = liveLock();
    vi.mocked(guardedFetch).mockResolvedValue(new Response(null, { status: 200 }));

    // Act
    const outcome = unpair();
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS / 2);
    await chrome.storage.local.remove("gubbi:lease");

    // Assert
    expect(await outcome).toEqual({ ok: true });
    expect(await getAuthBlob()).toBeUndefined();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("returns busy, clears nothing and releases the lease while a refresh holds the auth lock", async () => {
    // Arrange
    const { store } = stubChromeStorageWithEvents();
    await setAuthBlob(okBlob());
    store["gubbi:authLock"] = liveLock();
    vi.mocked(guardedFetch).mockResolvedValue(new Response(null, { status: 200 }));

    // Act
    const outcome = unpair();
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS);

    // Assert
    expect(await outcome).toEqual({ ok: false, reason: "busy" });
    expect(await getAuthBlob()).toBeDefined();
    expect("gubbi:lease" in store).toBe(false);
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});
