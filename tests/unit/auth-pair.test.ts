import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pair() runs over the real storage layer on an in-memory chrome.storage stub;
// the guarded-fetch egress (token exchange) and chrome.identity are the mocked
// boundaries. PKCE and authorize-url stay real (pure, fast).

vi.mock("../../src/lib/net/fetch", () => ({
  guardedFetch: vi.fn(),
}));

import { pair } from "../../src/lib/auth";
import { guardedFetch } from "../../src/lib/net/fetch";
import { getAuthBlob, getPendingAuthFlow } from "../../src/lib/storage";
import { stubChromeStorage, type StorageStub } from "../helpers/chrome-stub";

const REDIRECT_URI = "https://abcdef.chromiumapp.org/";

// Captures the `state` that pair() put on the authorize URL, so the stubbed
// launch can echo it back (happy path) or corrupt it (mismatch path).
let lastLaunchedState: string | undefined;

let storage: StorageStub;

function stubIdentity(launch: (url: string) => Promise<string>): void {
  const chromeWithStorage = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  const chromeMock = {
    ...chromeWithStorage,
    identity: {
      getRedirectURL: vi.fn(() => REDIRECT_URI),
      launchWebAuthFlow: vi.fn(async (details: { url: string; interactive: boolean }) => {
        storage.writeLog.push("launch");
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
  lastLaunchedState = undefined;
  storage = stubChromeStorage();
  for (const level of ["info", "warn"] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    const persistIndex = storage.writeLog.indexOf("set:gubbi:pendingAuthFlow");
    const launchIndex = storage.writeLog.indexOf("launch");
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
    const blob = await getAuthBlob();
    expect(blob?.accessToken).toBe("ory_at_abc");
    expect(blob?.refreshToken).toBe("ory_rt_xyz");
    expect(blob?.status).toBe("ok");
    expect(blob?.version).toBe(1);
    expect(Date.parse(blob!.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
    expect(await getPendingAuthFlow()).toBeUndefined();
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
    expect(await getAuthBlob()).toBeUndefined();
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
    expect(await getAuthBlob()).toBeUndefined();
  });

  it("maps an error= redirect to user_cancelled", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ error: "access_denied" }));

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "user_cancelled" });
    expect(await getAuthBlob()).toBeUndefined();
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
    expect(await getAuthBlob()).toBeUndefined();
  });

  it("maps a 5xx token response to network and writes no authBlob", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ code: "auth-code", state: lastLaunchedState! }));
    vi.mocked(guardedFetch).mockResolvedValue(new Response("oops", { status: 503 }));

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "network" });
    expect(await getAuthBlob()).toBeUndefined();
  });

  it("maps a thrown network error to network and writes no authBlob", async () => {
    // Arrange
    stubIdentity(async () => redirectWith({ code: "auth-code", state: lastLaunchedState! }));
    vi.mocked(guardedFetch).mockRejectedValue(new Error("offline"));

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: false, reason: "network" });
    expect(await getAuthBlob()).toBeUndefined();
  });
});

describe("pair (re-pairing over a previous account)", () => {
  it("clears the previous account's sync state and keeps the platform enabled flags", async () => {
    // Arrange
    const previousAccount = {
      "gubbi:authBlob": {
        version: 6,
        accessToken: "at_previous",
        accessTokenExpiresAt: "2026-01-01T00:00:00.000Z",
        refreshToken: "rt_previous",
        status: "reconnect_required",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      "gubbi:cursor:chatgpt": "2026-01-01T00:00:00.000Z",
      "gubbi:cursor:claude": "2026-01-02T00:00:00.000Z",
      "gubbi:pauseState:claude": { pausedUntil: "2099-01-01T00:00:00.000Z", reason: "drift" },
      "gubbi:drift:chatgpt": 2,
      "gubbi:transient:claude": 1,
      "gubbi:counters": { conversations_uploaded: 9, conversations_skipped: 1, last_run_at: null },
      "gubbi:forcedCommit:chatgpt": [{ platformId: "c1", watermark: "2026-01-01T00:00:00Z" }],
      "gubbi:detailStop:claude": { platformId: "c2", failures: 1 },
      "gubbi:status:chatgpt": "reconnect_required",
      "gubbi:refreshState": {
        ownerId: "dead-worker",
        authVersionBefore: 6,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const devicePreferences = { "gubbi:enabled:chatgpt": false, "gubbi:enabled:claude": true };
    Object.assign(storage.store, previousAccount, devicePreferences);
    stubIdentity(async () => redirectWith({ code: "auth-code", state: lastLaunchedState! }));
    vi.mocked(guardedFetch).mockResolvedValue(tokenResponse());

    // Act
    const result = await pair();

    // Assert
    expect(result).toEqual({ ok: true });
    for (const key of Object.keys(previousAccount).filter((key) => key !== "gubbi:authBlob")) {
      expect(storage.store, key).not.toHaveProperty([key]);
    }
    expect(storage.store).toMatchObject(devicePreferences);
    expect(await getAuthBlob()).toMatchObject({ refreshToken: "ory_rt_xyz", version: 1 });
  });
});
