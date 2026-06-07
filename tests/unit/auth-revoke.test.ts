import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { stubChromeStorage } from "../helpers/chrome-stub";

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

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
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
    await setRefreshState({ ownerId: "x", authVersionBefore: 1, startedAt: new Date().toISOString() });
    await setPauseState("chatgpt", { pausedUntil: new Date().toISOString(), reason: "rate_limited" });
    await setPauseState("claude", { pausedUntil: new Date().toISOString(), reason: "transient" });
    vi.mocked(guardedFetch).mockResolvedValue(new Response(null, { status: 200 }));

    // Act
    await unpair();

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
});
