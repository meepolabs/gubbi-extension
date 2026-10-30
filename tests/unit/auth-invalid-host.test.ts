import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubChromeStorage } from "../helpers/chrome-stub";

// With VITE_AUTH_HOST set to an invalid value, AUTH_ORIGIN is undefined. The
// token endpoint and revoke calls must fail closed through their normal
// failure paths, never throw past them or send anything.

const INVALID_AUTH_HOST = "auth.example.test:8443";

function okBlob() {
  return {
    version: 3,
    accessToken: "at_old",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: "rt_old",
    status: "ok" as const,
    updatedAt: new Date().toISOString(),
  };
}

async function loadWithInvalidAuthHost() {
  vi.stubEnv("VITE_AUTH_HOST", INVALID_AUTH_HOST);
  vi.resetModules();
  const storage = await import("../../src/lib/storage");
  const refresh = await import("../../src/lib/auth/refresh");
  const revoke = await import("../../src/lib/auth/revoke");
  const errors = await import("../../src/lib/auth/errors");
  return { ...storage, ...refresh, ...revoke, ...errors };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auth with an invalid configured host", () => {
  it("marks reconnect_required and clears the refresh marker instead of throwing a TypeError", async () => {
    // Arrange
    stubChromeStorage();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const m = await loadWithInvalidAuthHost();
    await m.setAuthBlob(okBlob());

    // Act / Assert
    await expect(m.refreshWithinLock("owner-1")).rejects.toBeInstanceOf(m.ReconnectRequiredError);
    expect((await m.getAuthBlob())?.status).toBe("reconnect_required");
    expect(await m.getRefreshState()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still clears local state on unpair without sending a revoke", async () => {
    // Arrange
    stubChromeStorage();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const m = await loadWithInvalidAuthHost();
    await m.setAuthBlob(okBlob());

    // Act
    await m.unpair();

    // Assert
    expect(await m.getAuthBlob()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
