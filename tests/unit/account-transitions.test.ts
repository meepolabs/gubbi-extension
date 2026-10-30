import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Account transitions (pair, unpair, startup recovery) racing each other and a
// token refresh. Everything runs for real over an in-memory chrome.storage with
// change events, so the storage locks contend as they do in the worker; only the
// network egress and chrome.identity are faked, and each fake can be held open
// to interleave the flows at a chosen point.

vi.mock("../../src/lib/net/fetch", () => ({ guardedFetch: vi.fn() }));

import { forceRefresh, pair, runStartupRecovery, unpair } from "../../src/lib/auth";
import { handleControlMessage, type ControlDeps } from "../../src/lib/control/handlers";
import { guardedFetch } from "../../src/lib/net/fetch";
import { getAuthBlob, setAuthBlob, setRefreshState, type AuthBlob } from "../../src/lib/storage";
import { stubChromeStorageWithEvents } from "../helpers/chrome-stub";

const RUNTIME_ID = "extension-under-test";
const EXTENSION_ORIGIN = `chrome-extension://${RUNTIME_ID}`;
const POPUP_SENDER: chrome.runtime.MessageSender = { id: RUNTIME_ID, origin: EXTENSION_ORIGIN };
const REDIRECT_URI = "https://abcdef.chromiumapp.org/";
const AUTH_BLOB_KEY = "gubbi:authBlob";

interface Gate {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly wait: () => Promise<void>;
}

// A one-shot barrier: `wait` signals `entered` and parks until `release`.
function gate(): Gate {
  let signalEntered = (): void => undefined;
  let release = (): void => undefined;
  const entered = new Promise<void>((resolve) => (signalEntered = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    entered,
    release,
    wait: async () => {
      signalEntered();
      await released;
    },
  };
}

function previousAccountBlob(): AuthBlob {
  return {
    version: 4,
    accessToken: "at_previous",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "rt_previous",
    status: "ok",
    updatedAt: new Date().toISOString(),
  };
}

function tokenResponse(access: string, refresh: string): Response {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function grantOf(init: RequestInit | undefined): string | null {
  return new URLSearchParams(String(init?.body ?? "")).get("grant_type");
}

// The auth server: code exchange and refresh each answer through their own
// handler; revoke always succeeds.
function fakeAuthServer(handlers: {
  readonly exchange?: () => Promise<Response>;
  readonly refresh?: () => Promise<Response>;
}): void {
  vi.mocked(guardedFetch).mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname === "/oauth2/revoke") {
      return new Response(null, { status: 200 });
    }
    const grant = grantOf(init);
    if (grant === "authorization_code" && handlers.exchange) return handlers.exchange();
    if (grant === "refresh_token" && handlers.refresh) return handlers.refresh();
    throw new Error(`unexpected request for grant ${String(grant)}`);
  });
}

function stubIdentityApproving(): void {
  const chromeWithStorage = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  vi.stubGlobal("chrome", {
    ...chromeWithStorage,
    identity: {
      getRedirectURL: vi.fn(() => REDIRECT_URI),
      launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
        const redirect = new URL(REDIRECT_URI);
        redirect.searchParams.set("code", "auth-code");
        redirect.searchParams.set("state", new URL(url).searchParams.get("state") ?? "");
        return redirect.toString();
      }),
    },
  });
}

function controlDeps(startSync: ControlDeps["startSync"]): ControlDeps {
  return {
    runtimeId: RUNTIME_ID,
    extensionOrigin: EXTENSION_ORIGIN,
    ensureRecovered: async () => undefined,
    startSync,
    pair,
    unpair,
    syncAlarmNames: [],
    now: () => Date.now(),
  };
}

type StorageGet = (key: string | null) => Promise<Record<string, unknown>>;

// The first read of `key` returns what the store held at read time but only
// after the gate is released, so the reader acts on a value that may since have
// changed. Later reads pass straight through.
function holdFirstReadResult(key: string, held: Gate): void {
  const get = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn<StorageGet>>;
  const passThrough = get.getMockImplementation()!;
  let armed = true;
  get.mockImplementation(async (requested) => {
    const result = await passThrough(requested);
    if (armed && requested === key) {
      armed = false;
      await held.wait();
    }
    return result;
  });
}

// True once some caller is parked in waitForLockReleased.
function someoneWaitsForALock(): boolean {
  return vi.mocked(chrome.storage.onChanged.addListener).mock.calls.length > 0;
}

beforeEach(() => {
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("a disconnect during pairing", () => {
  it("keeps credentials absent and starts no sync when the pairing exchange completes after it", async () => {
    // Arrange
    stubChromeStorageWithEvents();
    stubIdentityApproving();
    const exchange = gate();
    fakeAuthServer({
      exchange: async () => {
        await exchange.wait();
        return tokenResponse("at_paired", "rt_paired");
      },
    });
    const startSync = vi.fn();
    const deps = controlDeps(startSync);

    // Act
    const pairing = handleControlMessage({ type: "PAIR_START" }, POPUP_SENDER, deps);
    await exchange.entered;
    const disconnect = await handleControlMessage({ type: "UNPAIR" }, POPUP_SENDER, deps);
    exchange.release();
    const paired = await pairing;

    // Assert
    expect(disconnect).toEqual({ ok: true });
    expect(paired).toEqual({ ok: false, reason: "superseded" });
    expect(await getAuthBlob()).toBeUndefined();
    expect(startSync).not.toHaveBeenCalled();
  });
});

describe("a disconnect during startup recovery", () => {
  it("leaves the credentials absent when recovery had already read the blob", async () => {
    // Arrange: an interrupted refresh makes recovery rewrite the blob.
    const { store } = stubChromeStorageWithEvents();
    await setAuthBlob(previousAccountBlob());
    await setRefreshState({
      ownerId: "dead-worker",
      authVersionBefore: 4,
      startedAt: new Date().toISOString(),
    });
    fakeAuthServer({});
    const recoveryRead = gate();
    holdFirstReadResult(AUTH_BLOB_KEY, recoveryRead);

    // Act
    const recovery = runStartupRecovery();
    await recoveryRead.entered;
    let disconnectSettled = false;
    const disconnect = unpair().finally(() => (disconnectSettled = true));
    await vi.waitFor(() => expect(disconnectSettled || someoneWaitsForALock()).toBe(true));
    recoveryRead.release();
    await recovery;

    // Assert
    expect(await disconnect).toEqual({ ok: true });
    expect(AUTH_BLOB_KEY in store).toBe(false);
  });
});

describe("pairing while a refresh of the previous account is in flight", () => {
  it("keeps the newly paired credentials once the refresh completes", async () => {
    // Arrange
    stubChromeStorageWithEvents();
    stubIdentityApproving();
    await setAuthBlob(previousAccountBlob());
    const refreshPost = gate();
    fakeAuthServer({
      exchange: async () => tokenResponse("at_paired", "rt_paired"),
      refresh: async () => {
        await refreshPost.wait();
        return tokenResponse("at_rotated", "rt_rotated");
      },
    });
    let pairingSettled = false;

    // Act
    const refresh = forceRefresh();
    await refreshPost.entered;
    const pairing = handleControlMessage(
      { type: "PAIR_START" },
      POPUP_SENDER,
      controlDeps(vi.fn()),
    ).finally(() => (pairingSettled = true));
    await vi.waitFor(() => expect(pairingSettled || someoneWaitsForALock()).toBe(true));
    refreshPost.release();
    await refresh;

    // Assert
    expect(await pairing).toEqual({ ok: true });
    expect(await getAuthBlob()).toMatchObject({
      accessToken: "at_paired",
      refreshToken: "rt_paired",
      version: 1,
    });
  });
});
