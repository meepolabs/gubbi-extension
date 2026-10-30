import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/storage", () => ({
  setPendingAuthFlow: vi.fn(async () => undefined),
  clearPendingAuthFlow: vi.fn(async () => undefined),
  getPendingAuthFlow: vi.fn(async () => undefined),
  setAuthBlob: vi.fn(async () => undefined),
}));

// Each test re-imports the consumers after stubbing env, because ALLOWED_HOSTS
// and AUTH_ORIGIN are evaluated once at module load.

async function loadConsumers() {
  vi.resetModules();
  const fetchModule = await import("../../src/lib/net/fetch");
  const authConfig = await import("../../src/lib/auth/config");
  const api = await import("../../src/lib/api");
  const exchange = await import("../../src/lib/auth/exchange");
  const authorizeUrl = await import("../../src/lib/auth/authorize-url");
  const auth = await import("../../src/lib/auth");
  const storage = await import("../../src/lib/storage");
  return { ...fetchModule, ...authConfig, ...api, ...exchange, ...authorizeUrl, ...auth, storage };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("endpoint configuration", () => {
  it("allows exactly the prod hosts when both env vars are unset", async () => {
    // Arrange
    vi.stubEnv("VITE_API_BASE_URL", undefined);
    vi.stubEnv("VITE_AUTH_HOST", undefined);

    // Act
    const { ALLOWED_HOSTS, AUTH_ORIGIN } = await loadConsumers();

    // Assert
    expect(ALLOWED_HOSTS).toEqual(new Set(["api.gubbi.ai", "auth.gubbi.ai"]));
    expect(AUTH_ORIGIN).toBe("https://auth.gubbi.ai");
  });

  it("follows valid configured hosts for the allowlist and the auth origin", async () => {
    // Arrange
    vi.stubEnv("VITE_API_BASE_URL", "https://api.dev.example.test");
    vi.stubEnv("VITE_AUTH_HOST", "auth.dev.example.test");

    // Act
    const { ALLOWED_HOSTS, AUTH_ORIGIN } = await loadConsumers();

    // Assert
    expect(ALLOWED_HOSTS).toEqual(new Set(["api.dev.example.test", "auth.dev.example.test"]));
    expect(AUTH_ORIGIN).toBe("https://auth.dev.example.test");
  });

  it("drops an auth host with a port from the allowlist and blocks requests to it", async () => {
    // Arrange
    vi.stubEnv("VITE_API_BASE_URL", undefined);
    vi.stubEnv("VITE_AUTH_HOST", "auth.example.test:8443");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Act
    const { ALLOWED_HOSTS, AUTH_ORIGIN, guardedFetch } = await loadConsumers();

    // Assert
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('"variable":"VITE_AUTH_HOST"');
    expect(String(warn.mock.calls[0]![0])).not.toContain("auth.example.test");
    expect(ALLOWED_HOSTS).toEqual(new Set(["api.gubbi.ai"]));
    expect(AUTH_ORIGIN).toBeUndefined();
    expect(() => guardedFetch("https://auth.example.test:8443/oauth2/token")).toThrow(
      /disallowed host/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("never falls back to the prod auth host when the configured value is invalid", async () => {
    // Arrange
    vi.stubEnv("VITE_AUTH_HOST", "https://auth.example.test/v1");

    // Act
    const { ALLOWED_HOSTS } = await loadConsumers();

    // Assert
    expect(ALLOWED_HOSTS.has("auth.gubbi.ai")).toBe(false);
  });

  it("uploads nothing and reports network when the api origin is invalid", async () => {
    // Arrange
    vi.stubEnv("VITE_API_BASE_URL", "http://api.example.test");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const getAccessToken = vi.fn().mockResolvedValue("token");
    const forceRefresh = vi.fn().mockResolvedValue("token");
    const { uploadConversations } = await loadConsumers();

    // Act
    const outcome = await uploadConversations({ conversations: [] } as never, {
      getAccessToken,
      forceRefresh,
    });

    // Assert
    expect(outcome).toEqual({ status: "network" });
    expect(spy).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("reports a token exchange as a network failure when the auth host is invalid", async () => {
    // Arrange
    vi.stubEnv("VITE_AUTH_HOST", "auth.example.test:8443");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { exchangeCode } = await loadConsumers();

    // Act
    const result = await exchangeCode({
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "https://abcdef.chromiumapp.org/",
    });

    // Assert
    expect(result).toEqual({ ok: false, reason: "network" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses to build an authorize URL when the auth host is invalid", async () => {
    // Arrange
    vi.stubEnv("VITE_AUTH_HOST", "https://auth.example.test/v1");
    const { buildAuthorizeUrl } = await loadConsumers();

    // Act / Assert
    expect(() =>
      buildAuthorizeUrl({ redirectUri: "https://r.test/", state: "s", codeChallenge: "c" }),
    ).toThrow(/not configured/);
  });

  it("blocks pairing before any pending flow is stored when the auth host is invalid", async () => {
    // Arrange
    vi.stubEnv("VITE_AUTH_HOST", "http://auth.example.test");
    const { pair, storage } = await loadConsumers();

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "network" });
    expect(storage.setPendingAuthFlow).not.toHaveBeenCalled();
  });
});
