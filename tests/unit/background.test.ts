import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Background wiring test. defineBackground just returns its definition object, so
// we import the entrypoint's default export and invoke main() to register the
// listeners against a chrome stub. We mock the orchestrator (runSync)
// and auth (runStartupRecovery) so the test asserts ORDERING -- that startup
// recovery runs once per worker, before any sync, even when onStartup never fires.

const { runStartupRecovery, runSync, pair, unpair } = vi.hoisted(() => ({
  runStartupRecovery: vi.fn(async () => undefined),
  runSync: vi.fn(async () => undefined),
  pair: vi.fn(async () => ({ ok: true }) as const),
  unpair: vi.fn(async () => ({ ok: true }) as const),
}));

vi.mock("../../src/lib/auth", () => ({ runStartupRecovery, pair, unpair }));
vi.mock("../../src/lib/sync/orchestrator", () => ({ runSync }));

const RUNTIME_ID = "extension-under-test";
const EXTENSION_ORIGIN = `chrome-extension://${RUNTIME_ID}`;
const POPUP_SENDER = { id: RUNTIME_ID, origin: EXTENSION_ORIGIN };

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

interface ChromeCapture {
  messageListener?: MessageListener;
  startupListener?: () => void;
  alarmListener?: (alarm: { name: string }) => void;
}

// Records the listeners background.main() registers and supplies the chrome.*
// surface the entrypoint touches.
function stubChromeCapturing(): ChromeCapture {
  const capture: ChromeCapture = {};
  const chromeMock = {
    runtime: {
      id: RUNTIME_ID,
      getURL: vi.fn((path: string) => `${EXTENSION_ORIGIN}/${path}`),
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn((l: () => void) => (capture.startupListener = l)) },
      onMessage: { addListener: vi.fn((l: MessageListener) => (capture.messageListener = l)) },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
    alarms: {
      create: vi.fn(async () => undefined),
      onAlarm: {
        addListener: vi.fn((l: (a: { name: string }) => void) => (capture.alarmListener = l)),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return capture;
}

// The background module memoizes startup recovery once per WORKER lifetime in a
// module-level variable. To model a fresh worker per test, reset the module
// registry and re-import the entrypoint so that memo starts cleared.
async function loadFreshBackground(): Promise<{ main: () => void }> {
  vi.resetModules();
  const mod = await import("../../entrypoints/background");
  return mod.default as unknown as { main: () => void };
}

// Lets a void-launched async body settle before assertions.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("background startup-recovery gate", () => {
  it("a SYNC_START runs startup recovery before runSync, with NO onStartup", async () => {
    // Arrange: register the listeners, then drive a SYNC_START -- the wake path a
    // worker takes when it was revived by a message, never by chrome.runtime.onStartup.
    const capture = stubChromeCapturing();
    const background = await loadFreshBackground();
    background.main();
    expect(capture.messageListener).toBeDefined();

    const order: string[] = [];
    runStartupRecovery.mockImplementation(async () => {
      order.push("recovery");
    });
    runSync.mockImplementation(async () => {
      order.push("sync");
    });

    // Act: deliver a SYNC_START message (onStartup is deliberately never invoked).
    capture.messageListener!({ type: "SYNC_START" }, POPUP_SENDER, vi.fn());
    await flushMicrotasks();

    // Assert: recovery ran, and it ran before the sync.
    expect(runStartupRecovery).toHaveBeenCalledTimes(1);
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["recovery", "sync"]);
  });

  it("runs recovery exactly once across multiple wakes in the same worker lifetime", async () => {
    // Arrange
    const capture = stubChromeCapturing();
    const background = await loadFreshBackground();
    background.main();

    // Act: an alarm wake then a message wake -- both on the same worker.
    capture.alarmListener!({ name: "sync" });
    await flushMicrotasks();
    capture.messageListener!({ type: "SYNC_START" }, POPUP_SENDER, vi.fn());
    await flushMicrotasks();

    // Assert: the per-worker memo collapses both into a single recovery.
    expect(runStartupRecovery).toHaveBeenCalledTimes(1);
    expect(runSync).toHaveBeenCalledTimes(2);
  });
  it("retries a rejected recovery on the next PAIR_START instead of memoizing the failure", async () => {
    // Arrange: the first recovery on this worker rejects; later ones succeed.
    const capture = stubChromeCapturing();
    const background = await loadFreshBackground();
    background.main();
    runStartupRecovery.mockRejectedValueOnce(new Error("recovery failed"));
    const firstResponse = vi.fn();
    const secondResponse = vi.fn();

    // Act: two PAIR_STARTs on the same worker.
    capture.messageListener!({ type: "PAIR_START" }, POPUP_SENDER, firstResponse);
    await vi.waitFor(() => expect(firstResponse).toHaveBeenCalled());
    capture.messageListener!({ type: "PAIR_START" }, POPUP_SENDER, secondResponse);
    await vi.waitFor(() => expect(secondResponse).toHaveBeenCalled());

    // Assert: the failure surfaced once, then recovery re-ran and pairing proceeded.
    expect(firstResponse).toHaveBeenCalledWith({ ok: false, reason: "internal" });
    expect(secondResponse).toHaveBeenCalledWith({ ok: true });
    expect(runStartupRecovery).toHaveBeenCalledTimes(2);
    expect(pair).toHaveBeenCalledTimes(1);
  });
});

describe("background control message routing", () => {
  it("keeps the channel open and answers a control message once", async () => {
    const capture = stubChromeCapturing();
    const background = await loadFreshBackground();
    background.main();
    const sendResponse = vi.fn();

    const keepOpen = capture.messageListener!({ type: "UNPAIR" }, POPUP_SENDER, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(keepOpen).toBe(true);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("refuses a SYNC_START sent from a content script tab", async () => {
    const capture = stubChromeCapturing();
    const background = await loadFreshBackground();
    background.main();
    const sendResponse = vi.fn();

    capture.messageListener!(
      { type: "SYNC_START" },
      { id: RUNTIME_ID, tab: { id: 3 }, origin: "https://chatgpt.com" },
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, reason: "forbidden_sender" });
    expect(runSync).not.toHaveBeenCalled();
  });

  it("ignores a non-control message without claiming the channel", async () => {
    const capture = stubChromeCapturing();
    const background = await loadFreshBackground();
    background.main();
    const sendResponse = vi.fn();

    const keepOpen = capture.messageListener!(
      { type: "LIST_RESULT", platform: "chatgpt", result: { ok: true, summaries: [] } },
      POPUP_SENDER,
      sendResponse,
    );

    expect(keepOpen).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
