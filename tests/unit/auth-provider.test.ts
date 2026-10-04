import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getAccessToken / forceRefresh, exercised over the REAL lock + REAL storage
// (in-memory chrome.storage stub with onChanged dispatch so waitForLockReleased
// works) and a mocked network egress. This lets the concurrent-refresh test
// drive genuine lock contention.

vi.mock("../../src/lib/net/fetch", () => ({ guardedFetch: vi.fn() }));

import { guardedFetch } from "../../src/lib/net/fetch";
import { getAccessToken, forceRefresh } from "../../src/lib/auth/provider";
import { ReconnectRequiredError } from "../../src/lib/auth/errors";
import { setAuthBlob, getAuthBlob, type AuthBlob } from "../../src/lib/storage";
import { stubChromeStorageWithEvents as stubChromeStorage } from "../helpers/chrome-stub";

function blob(overrides: Partial<AuthBlob> = {}): AuthBlob {
  return {
    version: 1,
    accessToken: "at_cached",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "rt_1",
    status: "ok",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function rotatedResponse(access = "at_new", refresh = "rt_new"): Response {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("getAccessToken", () => {
  it("fast path: returns the cached token with no lock and no token call when >2min away", async () => {
    // Arrange
    const stub = stubChromeStorage();
    await setAuthBlob(
      blob({ accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    );

    // Act
    const token = await getAccessToken();

    // Assert
    expect(token).toBe("at_cached");
    expect(guardedFetch).not.toHaveBeenCalled();
    // No lock was taken (auth lock key never written).
    expect(stub.store["gubbi:authLock"]).toBeUndefined();
  });

  it("near-expiry: refreshes and returns the new token", async () => {
    // Arrange: token expires within the 2-min margin.
    stubChromeStorage();
    await setAuthBlob(blob({ accessTokenExpiresAt: new Date(Date.now() + 30_000).toISOString() }));
    vi.mocked(guardedFetch).mockResolvedValue(rotatedResponse());

    // Act
    const token = await getAccessToken();

    // Assert
    expect(token).toBe("at_new");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect((await getAuthBlob())?.version).toBe(2);
  });

  it("rejects ReconnectRequiredError when no blob is present", async () => {
    // Arrange
    stubChromeStorage();

    // Act + Assert
    await expect(getAccessToken()).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("rejects ReconnectRequiredError when status is reconnect_required", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(blob({ status: "reconnect_required" }));

    // Act + Assert
    await expect(getAccessToken()).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});

describe("forceRefresh", () => {
  it("refreshes a still-valid token, ignoring the 2-min margin", async () => {
    // Arrange: token is far from expiry, so getAccessToken would NOT refresh.
    stubChromeStorage();
    await setAuthBlob(
      blob({ accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }),
    );
    vi.mocked(guardedFetch).mockResolvedValue(rotatedResponse());

    // Act
    const token = await forceRefresh();

    // Assert
    expect(token).toBe("at_new");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects ReconnectRequiredError when status is reconnect_required", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(blob({ status: "reconnect_required" }));

    // Act + Assert
    await expect(forceRefresh()).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("concurrent refresh (single-flight)", () => {
  it("the second caller waits, re-reads, and uses the first caller's rotated token without its own token call", async () => {
    // Arrange: both callers see a near-expiry token. The first holds the lock and
    // its refresh is gated so the second caller is guaranteed to hit contention.
    stubChromeStorage();
    await setAuthBlob(blob({ accessTokenExpiresAt: new Date(Date.now() + 30_000).toISOString() }));

    let releaseFetch = (): void => undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchEntered = (): void => undefined;
    const fetchHasEntered = new Promise<void>((resolve) => {
      fetchEntered = resolve;
    });

    vi.mocked(guardedFetch).mockImplementation(async () => {
      fetchEntered();
      await fetchGate;
      // First (and only) token call yields a token >2min away so the waiter sees
      // it as fresh on re-read.
      return rotatedResponse("at_first", "rt_2");
    });

    // Act: start the first refresh; once its fetch is in-flight (lock held),
    // start the second. The second must hit LockContendedError, wait, re-read.
    const first = getAccessToken();
    await fetchHasEntered;
    const second = getAccessToken();

    // Give the second caller a turn to attempt acquisition and start waiting.
    await Promise.resolve();
    await Promise.resolve();

    releaseFetch();
    const [firstToken, secondToken] = await Promise.all([first, second]);

    // Assert: both got the first caller's rotated token; only ONE token call.
    expect(firstToken).toBe("at_first");
    expect(secondToken).toBe("at_first");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect((await getAuthBlob())?.version).toBe(2);
  });
});
