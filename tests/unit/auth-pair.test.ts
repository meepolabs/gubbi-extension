import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pair() orchestration is mocked at its three boundaries: storage, the
// guarded-fetch egress (token exchange), and chrome.identity.launchWebAuthFlow.
// PKCE and authorize-url stay real (pure, fast). The launch driver in launch.ts
// reads chrome.identity, so we stub that global.

vi.mock("../../src/lib/storage", () => ({
  setPendingAuthFlow: vi.fn(async () => undefined),
  clearPendingAuthFlow: vi.fn(async () => undefined),
  getPendingAuthFlow: vi.fn(async () => undefined),
  setAuthBlob: vi.fn(async () => undefined),
}));

vi.mock("../../src/lib/net/fetch", () => ({
  guardedFetch: vi.fn(),
}));

import { pair } from "../../src/lib/auth";
import { guardedFetch } from "../../src/lib/net/fetch";
import {
  clearPendingAuthFlow,
  setAuthBlob,
  setPendingAuthFlow,
} from "../../src/lib/storage";

const REDIRECT_URI = "https://abcdef.chromiumapp.org/";

// Records the order in which boundary calls fire so the test can assert that the
// pending flow is persisted BEFORE the auth window is launched.
let callLog: string[] = [];

// Captures the `state` that pair() put on the authorize URL, so the stubbed
// launch can echo it back (happy path) or corrupt it (mismatch path).
let lastLaunchedState: string | undefined;

function stubIdentity(launch: (url: string) => Promise<string>): void {
  const chromeMock = {
    identity: {
      getRedirectURL: vi.fn(() => REDIRECT_URI),
      launchWebAuthFlow: vi.fn(async (details: { url: string; interactive: boolean }) => {
        callLog.push("launch");
        const parsed = new URL(details.url);
        lastLaunchedState = parsed.searchParams.get("state") ?? undefined;
        return launch(details.url);
      }),
    },
  };
  vi.stubGlobal("chrome", chromeMock);
}

function redirectWith(params: Record<string, string>): string {
  const url = new URL(REDIRECT_URI);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "ory_at_abc",
      refresh_token: "ory_rt_xyz",
      expires_in: 3600,
      token_type: "bearer",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  callLog = [];
  lastLaunchedState = undefined;
  vi.mocked(setPendingAuthFlow).mockImplementation(async () => {
    callLog.push("setPendingAuthFlow");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("pair (happy path)", () => {
  it("persists pendingAuthFlow BEFORE launching the auth window", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ code: "auth-code", state: lastLaunchedState! }));
    vi.mocked(guardedFetch).mockResolvedValue(tokenResponse());

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: true });
    const persistIndex = callLog.indexOf("setPendingAuthFlow");
    const launchIndex = callLog.indexOf("launch");
    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(launchIndex).toBeGreaterThan(persistIndex);
  });

  it("exchanges the code and writes the authBlob, then clears the pending flow", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ code: "auth-code", state: lastLaunchedState! }));
    vi.mocked(guardedFetch).mockResolvedValue(tokenResponse());

    // Act
    await pair();

    // Assert: token exchange went through the egress guard as form-encoded POST.
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(guardedFetch).mock.calls[0]!;
    const url = new URL(input as string);
    expect(url.pathname).toBe("/oauth2/token");
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("client_id")).toBe("journal-extension");
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);

    // Assert: authBlob written with derived fields, pending flow cleared.
    expect(setAuthBlob).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(setAuthBlob).mock.calls[0]![0];
    expect(blob.accessToken).toBe("ory_at_abc");
    expect(blob.refreshToken).toBe("ory_rt_xyz");
    expect(blob.status).toBe("ok");
    expect(blob.version).toBe(1);
    expect(Date.parse(blob.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
    expect(clearPendingAuthFlow).toHaveBeenCalledTimes(1);
  });
});

describe("pair (state mismatch)", () => {
  it("rejects with state_mismatch and writes no authBlob", async () => {
    // Arrange: launch echoes a DIFFERENT state than the one pair() generated.
    stubIdentity(async () => redirectWith({ code: "auth-code", state: "tampered-state" }));
    vi.mocked(guardedFetch).mockResolvedValue(tokenResponse());

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "state_mismatch" });
    expect(setAuthBlob).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});

describe("pair (user cancel)", () => {
  it("maps a launchWebAuthFlow rejection to user_cancelled", async () => {
    // Arrange
    stubIdentity(async () => {
      throw new Error("The user did not approve access.");
    });

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "user_cancelled" });
    expect(setAuthBlob).not.toHaveBeenCalled();
  });

  it("maps an error= redirect to user_cancelled", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ error: "access_denied" }));

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "user_cancelled" });
    expect(setAuthBlob).not.toHaveBeenCalled();
  });
});

describe("pair (exchange failures)", () => {
  it("maps a 4xx token response to exchange_failed and writes no authBlob", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ code: "auth-code", state: lastLaunchedState! }));
    vi.mocked(guardedFetch).mockResolvedValue(new Response("bad", { status: 400 }));

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "exchange_failed" });
    expect(setAuthBlob).not.toHaveBeenCalled();
  });

  it("maps a 5xx token response to network and writes no authBlob", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ code: "auth-code", state: lastLaunchedState! }));
    vi.mocked(guardedFetch).mockResolvedValue(new Response("oops", { status: 503 }));

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "network" });
    expect(setAuthBlob).not.toHaveBeenCalled();
  });

  it("maps a thrown network error to network and writes no authBlob", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ code: "auth-code", state: lastLaunchedState! }));
    vi.mocked(guardedFetch).mockRejectedValue(new Error("offline"));

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "network" });
    expect(setAuthBlob).not.toHaveBeenCalled();
  });
});
