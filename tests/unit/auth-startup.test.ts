import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runStartupRecovery is the ambiguous-refresh detector. It must NEVER call the
// token endpoint -- so guardedFetch is mocked and asserted to be untouched. Real
// storage over an in-memory chrome.storage stub.

vi.mock("../../src/lib/net/fetch", () => ({ guardedFetch: vi.fn() }));

import { guardedFetch } from "../../src/lib/net/fetch";
import { runStartupRecovery } from "../../src/lib/auth/startup";
import {
  getAuthBlob,
  getRefreshState,
  setAuthBlob,
  setRefreshState,
  type AuthBlob,
} from "../../src/lib/storage";
import { stubChromeStorage } from "../helpers/chrome-stub";

function okBlob(version: number): AuthBlob {
  return {
    version,
    accessToken: "at",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "rt",
    status: "ok",
    updatedAt: new Date().toISOString(),
  };
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

describe("runStartupRecovery", () => {
  it("is a no-op when refreshState is absent", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob(2));

    // Act
    await runStartupRecovery();

    // Assert
    expect((await getAuthBlob())?.status).toBe("ok");
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("AMBIGUOUS: version unchanged -> reconnect_required, clears refreshState, no token call", async () => {
    // Arrange: a refresh started (marker at version 4) but the blob still reads
    // version 4 -- the rotation may have happened server-side without a local
    // persist. The old refresh token must NEVER be replayed.
    stubChromeStorage();
    await setAuthBlob(okBlob(4));
    await setRefreshState({
      ownerId: "dead-worker",
      authVersionBefore: 4,
      startedAt: new Date().toISOString(),
    });

    // Act
    await runStartupRecovery();

    // Assert
    expect((await getAuthBlob())?.status).toBe("reconnect_required");
    expect(await getRefreshState()).toBeUndefined();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("SAFE: version bumped -> just clears refreshState, status stays ok", async () => {
    // Arrange: the refresh actually completed (blob at version 5 > marker's 4)
    // but the marker was not cleared. The current token is good.
    stubChromeStorage();
    await setAuthBlob(okBlob(5));
    await setRefreshState({
      ownerId: "crashed-after-persist",
      authVersionBefore: 4,
      startedAt: new Date().toISOString(),
    });

    // Act
    await runStartupRecovery();

    // Assert
    expect((await getAuthBlob())?.status).toBe("ok");
    expect((await getAuthBlob())?.version).toBe(5);
    expect(await getRefreshState()).toBeUndefined();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("clears an orphaned refreshState when no authBlob exists", async () => {
    // Arrange
    stubChromeStorage();
    await setRefreshState({
      ownerId: "x",
      authVersionBefore: 1,
      startedAt: new Date().toISOString(),
    });

    // Act
    await runStartupRecovery();

    // Assert
    expect(await getRefreshState()).toBeUndefined();
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});
