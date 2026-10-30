import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PairResult, UnpairResult } from "../../src/lib/auth";
import { handleControlMessage, type ControlDeps } from "../../src/lib/control/handlers";
import type { StatusSnapshot } from "../../src/lib/messages";
import {
  getPlatformEnabled,
  getStatus,
  setAuthBlob,
  setPauseState,
  setPlatformEnabled,
  setPlatformLastRunAt,
  setStatus,
  type AuthBlob,
} from "../../src/lib/storage";
import { stubChromeStorage, type StorageStub } from "../helpers/chrome-stub";

// Control handlers run against the real storage layer over an in-memory
// chrome.storage stub; pair/unpair/sync/recovery are injected fakes.

const RUNTIME_ID = "extension-under-test";
const EXTENSION_ORIGIN = `chrome-extension://${RUNTIME_ID}`;
const POPUP_SENDER: chrome.runtime.MessageSender = {
  id: RUNTIME_ID,
  url: `${EXTENSION_ORIGIN}/popup.html`,
  origin: EXTENSION_ORIGIN,
};
const TAB_SENDER: chrome.runtime.MessageSender = {
  id: RUNTIME_ID,
  tab: { id: 7 } as chrome.tabs.Tab,
  url: "https://chatgpt.com/c/abc",
  origin: "https://chatgpt.com",
};
const FOREIGN_SENDER: chrome.runtime.MessageSender = {
  id: "some-other-extension",
  url: "chrome-extension://some-other-extension/popup.html",
  origin: "chrome-extension://some-other-extension",
};

const SEEDED_ACCESS_TOKEN = "seeded-access-token-7f3a91";
const SEEDED_REFRESH_TOKEN = "seeded-refresh-token-c40e22";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");
const PERIODIC_AT_MS = NOW_MS + 18 * 60_000;
const CONTINUATION_AT_MS = NOW_MS + 60_000;

function blob(status: AuthBlob["status"] = "ok"): AuthBlob {
  return {
    version: 3,
    accessToken: SEEDED_ACCESS_TOKEN,
    accessTokenExpiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    refreshToken: SEEDED_REFRESH_TOKEN,
    status,
    updatedAt: new Date(NOW_MS).toISOString(),
  };
}

let storage: StorageStub;
let alarms: Record<string, { name: string; scheduledTime: number } | undefined>;
let alarmsGet: ReturnType<typeof vi.fn>;

function stubChrome(): void {
  storage = stubChromeStorage();
  alarms = {};
  alarmsGet = vi.fn(async (name: string) => alarms[name]);
  const chromeWithStorage = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  vi.stubGlobal("chrome", { ...chromeWithStorage, alarms: { get: alarmsGet } });
}

interface Fakes {
  deps: ControlDeps;
  order: string[];
  startSync: ReturnType<typeof vi.fn>;
  pair: ReturnType<typeof vi.fn>;
  unpair: ReturnType<typeof vi.fn>;
}

function fakes(
  overrides: { pair?: () => Promise<PairResult>; unpair?: () => Promise<UnpairResult> } = {},
): Fakes {
  const order: string[] = [];
  const startSync = vi.fn(() => order.push("sync"));
  const pair = vi.fn(
    overrides.pair ??
      (async (): Promise<PairResult> => {
        order.push("pair");
        return { ok: true };
      }),
  );
  const unpair = vi.fn(overrides.unpair ?? (async (): Promise<UnpairResult> => ({ ok: true })));
  const deps: ControlDeps = {
    runtimeId: RUNTIME_ID,
    extensionOrigin: EXTENSION_ORIGIN,
    ensureRecovered: async () => {
      order.push("recovery");
    },
    startSync,
    pair,
    unpair,
    syncAlarmNames: ["sync", "sync-continuation"],
    now: () => NOW_MS,
  };
  return { deps, order, startSync, pair, unpair };
}

beforeEach(() => {
  stubChrome();
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sender and payload checks", () => {
  it.each([
    ["a content script tab", TAB_SENDER],
    ["another extension", FOREIGN_SENDER],
    [
      "another extension id at this extension's origin",
      { id: "some-other-extension", origin: EXTENSION_ORIGIN },
    ],
    [
      "a page of this extension id at a web origin",
      { id: RUNTIME_ID, origin: "https://example.test" },
    ],
    ["a sender with no origin or url", { id: RUNTIME_ID }],
    ["a sender with an unparseable url", { id: RUNTIME_ID, url: "not a url" }],
    ["an unknown sender", undefined],
  ])("rejects SET_PLATFORM_ENABLED from %s and writes nothing", async (_label, sender) => {
    const { deps } = fakes();

    const response = await handleControlMessage(
      { type: "SET_PLATFORM_ENABLED", platform: "claude", enabled: false },
      sender,
      deps,
    );

    expect(response).toEqual({ ok: false, reason: "forbidden_sender" });
    expect(storage.writeLog).toEqual([]);
    expect(await getPlatformEnabled("claude")).toBe(true);
  });

  it.each([
    ["missing enabled", { type: "SET_PLATFORM_ENABLED", platform: "claude" }],
    ["non-boolean enabled", { type: "SET_PLATFORM_ENABLED", platform: "claude", enabled: "no" }],
    ["unknown platform", { type: "SET_PLATFORM_ENABLED", platform: "gemini", enabled: false }],
    [
      "an extra field",
      { type: "SET_PLATFORM_ENABLED", platform: "claude", enabled: false, extra: 1 },
    ],
  ])("rejects a SET_PLATFORM_ENABLED with %s and writes nothing", async (_label, message) => {
    const { deps } = fakes();

    const response = await handleControlMessage(message, POPUP_SENDER, deps);

    expect(response).toEqual({ ok: false, reason: "invalid_payload" });
    expect(storage.writeLog).toEqual([]);
  });

  it("rejects PAIR_START from a tab without starting the auth flow", async () => {
    const { deps, pair, startSync } = fakes();

    const response = await handleControlMessage({ type: "PAIR_START" }, TAB_SENDER, deps);

    expect(response).toEqual({ ok: false, reason: "forbidden_sender" });
    expect(pair).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
  });

  it.each([
    ["the popup", POPUP_SENDER],
    [
      "an extension page open in a tab",
      {
        id: RUNTIME_ID,
        tab: { id: 9 } as chrome.tabs.Tab,
        url: `${EXTENSION_ORIGIN}/options.html`,
        origin: EXTENSION_ORIGIN,
      },
    ],
    [
      "an extension page that reports only its url",
      {
        id: RUNTIME_ID,
        tab: { id: 9 } as chrome.tabs.Tab,
        url: `${EXTENSION_ORIGIN}/options.html`,
      },
    ],
  ])("applies a valid SET_PLATFORM_ENABLED from %s", async (_label, sender) => {
    const { deps } = fakes();

    const response = await handleControlMessage(
      { type: "SET_PLATFORM_ENABLED", platform: "claude", enabled: false },
      sender,
      deps,
    );

    expect(response).toEqual({ ok: true });
    expect(await getPlatformEnabled("claude")).toBe(false);
    expect(await getPlatformEnabled("chatgpt")).toBe(true);
  });
});

describe("STATUS_REQUEST", () => {
  async function status(): Promise<StatusSnapshot> {
    const response = await handleControlMessage(
      { type: "STATUS_REQUEST" },
      POPUP_SENDER,
      fakes().deps,
    );
    return response as StatusSnapshot;
  }

  it("reports auth none and default platform rows when nothing is stored", async () => {
    expect(await status()).toEqual({
      ok: true,
      auth: "none",
      nextSyncAt: null,
      platforms: [
        {
          platform: "chatgpt",
          enabled: true,
          status: "idle",
          pausedUntil: null,
          pauseReason: null,
          lastRunAt: null,
        },
        {
          platform: "claude",
          enabled: true,
          status: "idle",
          pausedUntil: null,
          pauseReason: null,
          lastRunAt: null,
        },
      ],
    });
  });

  it("reports auth none when the blob is absent even if a platform says reconnect", async () => {
    await setStatus("claude", "reconnect_required");

    expect((await status()).auth).toBe("none");
  });

  it("reports auth ok when the blob is ok and no platform needs a reconnect", async () => {
    await setAuthBlob(blob("ok"));
    await setStatus("chatgpt", "paused");

    expect((await status()).auth).toBe("ok");
  });

  it("reports auth reconnect_required when the stored blob says so", async () => {
    await setAuthBlob(blob("reconnect_required"));

    expect((await status()).auth).toBe("reconnect_required");
  });

  it.each(["chatgpt", "claude"] as const)(
    "reports auth reconnect_required when only %s status says so",
    async (platform) => {
      await setAuthBlob(blob("ok"));
      await setStatus(platform, "reconnect_required");

      expect((await status()).auth).toBe("reconnect_required");
    },
  );

  it("carries per-platform enabled, status, active pause and last run", async () => {
    const pausedUntil = new Date(NOW_MS + 10 * 60_000).toISOString();
    const lastRunAt = new Date(NOW_MS - 12 * 60_000).toISOString();
    await setPlatformEnabled("chatgpt", false);
    await setStatus("claude", "paused");
    await setPauseState("claude", { pausedUntil, reason: "org_ambiguous" });
    await setPlatformLastRunAt("claude", lastRunAt);

    const { platforms } = await status();

    expect(platforms[0]).toMatchObject({ platform: "chatgpt", enabled: false });
    expect(platforms[1]).toEqual({
      platform: "claude",
      enabled: true,
      status: "paused",
      pausedUntil,
      pauseReason: "org_ambiguous",
      lastRunAt,
    });
  });

  it.each([
    ["paused", "idle"],
    ["syncing", "syncing"],
    ["reconnect_required", "reconnect_required"],
  ] as const)(
    "reports a %s platform whose pause window has ended as %s with no pause",
    async (stored, reported) => {
      await setStatus("chatgpt", stored);
      await setPauseState("chatgpt", {
        pausedUntil: new Date(NOW_MS - 1).toISOString(),
        reason: "rate_limited",
      });

      const { platforms } = await status();

      expect(platforms[0]).toMatchObject({
        status: reported,
        pausedUntil: null,
        pauseReason: null,
      });
    },
  );

  it("reports a paused platform with no stored pause window as idle", async () => {
    await setStatus("chatgpt", "paused");

    const { platforms } = await status();

    expect(platforms[0]).toMatchObject({ status: "idle", pausedUntil: null, pauseReason: null });
  });

  it("reports the earliest scheduled sync alarm as nextSyncAt", async () => {
    alarms["sync"] = { name: "sync", scheduledTime: PERIODIC_AT_MS };
    alarms["sync-continuation"] = { name: "sync-continuation", scheduledTime: CONTINUATION_AT_MS };

    expect((await status()).nextSyncAt).toBe(new Date(CONTINUATION_AT_MS).toISOString());
  });

  it("reports the periodic alarm when no continuation is scheduled", async () => {
    alarms["sync"] = { name: "sync", scheduledTime: PERIODIC_AT_MS };

    expect((await status()).nextSyncAt).toBe(new Date(PERIODIC_AT_MS).toISOString());
  });

  it("degrades nextSyncAt to null when the alarm read fails", async () => {
    await setAuthBlob(blob("ok"));
    alarmsGet.mockRejectedValue(new Error("alarms unavailable"));

    const snapshot = await status();

    expect(snapshot.nextSyncAt).toBeNull();
    expect(snapshot.auth).toBe("ok");
  });
});

describe("PAIR_START", () => {
  it("runs recovery before pairing, then resets reconnect statuses and starts a sync", async () => {
    await setStatus("chatgpt", "reconnect_required");
    await setStatus("claude", "paused");
    const { deps, order } = fakes();

    const response = await handleControlMessage({ type: "PAIR_START" }, POPUP_SENDER, deps);

    expect(response).toEqual({ ok: true });
    expect(order).toEqual(["recovery", "pair", "sync"]);
    expect(await getStatus("chatgpt")).toBe("idle");
    expect(await getStatus("claude")).toBe("paused");
  });

  it("returns only the failure reason and leaves statuses and sync alone", async () => {
    await setStatus("chatgpt", "reconnect_required");
    const leaky = {
      ok: false,
      reason: "exchange_failed",
      detail: SEEDED_ACCESS_TOKEN,
    } as unknown as PairResult;
    const { deps, startSync } = fakes({ pair: async () => leaky });

    const response = await handleControlMessage({ type: "PAIR_START" }, POPUP_SENDER, deps);

    expect(response).toEqual({ ok: false, reason: "exchange_failed" });
    expect(startSync).not.toHaveBeenCalled();
    expect(await getStatus("chatgpt")).toBe("reconnect_required");
  });

  it("joins a pairing already in flight instead of opening a second auth window", async () => {
    let finish: (result: PairResult) => void = () => undefined;
    const { deps, pair } = fakes({
      pair: () => new Promise<PairResult>((resolve) => (finish = resolve)),
    });

    const first = handleControlMessage({ type: "PAIR_START" }, POPUP_SENDER, deps);
    const second = handleControlMessage({ type: "PAIR_START" }, POPUP_SENDER, deps);
    await vi.waitFor(() => expect(pair).toHaveBeenCalled());
    finish({ ok: true });

    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(pair).toHaveBeenCalledTimes(1);
  });
});

describe("UNPAIR", () => {
  it("surfaces a busy unpair as a typed response", async () => {
    const { deps } = fakes({ unpair: async () => ({ ok: false, reason: "busy" }) });

    const response = await handleControlMessage({ type: "UNPAIR" }, POPUP_SENDER, deps);

    expect(response).toEqual({ ok: false, reason: "busy" });
  });

  it("returns ok when the unpair completes", async () => {
    const { deps, unpair } = fakes();

    const response = await handleControlMessage({ type: "UNPAIR" }, POPUP_SENDER, deps);

    expect(response).toEqual({ ok: true });
    expect(unpair).toHaveBeenCalledTimes(1);
  });
});

describe("SYNC_START", () => {
  it.each([
    ["every platform", {}, undefined],
    ["one platform", { platform: "claude" }, "claude"],
  ])("starts a sync for %s and acknowledges", async (_label, extra, expected) => {
    const { deps, startSync } = fakes();

    const response = await handleControlMessage(
      { type: "SYNC_START", ...extra },
      POPUP_SENDER,
      deps,
    );

    expect(response).toEqual({ ok: true });
    expect(startSync).toHaveBeenCalledWith(expected);
  });
});

describe("no secret crosses the control boundary", () => {
  it("never echoes a seeded token in any control or status response", async () => {
    // Arrange: the tokens really are in storage (positive control), and every
    // failure path that could carry text is primed with them.
    await setAuthBlob(blob("reconnect_required"));
    await setStatus("claude", "reconnect_required");
    const stored = JSON.stringify(storage.store);
    expect(stored).toContain(SEEDED_ACCESS_TOKEN);
    expect(stored).toContain(SEEDED_REFRESH_TOKEN);
    const throwing = fakes({
      pair: async () => {
        throw new Error(`exchange said ${SEEDED_REFRESH_TOKEN}`);
      },
      unpair: async () => {
        throw new Error(`revoke said ${SEEDED_ACCESS_TOKEN}`);
      },
    }).deps;
    const busy = fakes({
      unpair: async () =>
        ({ ok: false, reason: "busy", token: SEEDED_REFRESH_TOKEN }) as unknown as UnpairResult,
    }).deps;

    // Act
    const responses = [
      await handleControlMessage({ type: "STATUS_REQUEST" }, POPUP_SENDER, throwing),
      await handleControlMessage({ type: "PAIR_START" }, POPUP_SENDER, throwing),
      await handleControlMessage({ type: "UNPAIR" }, POPUP_SENDER, throwing),
      await handleControlMessage({ type: "UNPAIR" }, POPUP_SENDER, busy),
      await handleControlMessage({ type: "SYNC_START" }, POPUP_SENDER, throwing),
      await handleControlMessage(
        { type: "SET_PLATFORM_ENABLED", platform: "chatgpt", enabled: true },
        POPUP_SENDER,
        throwing,
      ),
      await handleControlMessage(
        { type: "UNPAIR", token: SEEDED_ACCESS_TOKEN },
        POPUP_SENDER,
        throwing,
      ),
      await handleControlMessage({ type: "STATUS_REQUEST" }, TAB_SENDER, throwing),
    ];

    // Assert
    expect(responses[1]).toEqual({ ok: false, reason: "internal" });
    expect(responses[2]).toEqual({ ok: false, reason: "internal" });
    for (const response of responses) {
      const json = JSON.stringify(response);
      expect(json).not.toContain(SEEDED_ACCESS_TOKEN);
      expect(json).not.toContain(SEEDED_REFRESH_TOKEN);
    }
  });
});
