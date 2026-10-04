import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Background wiring test. defineBackground just returns its definition object, so
// we import the entrypoint's default export and invoke main() to register the
// listeners against a chrome stub. We mock the orchestrator (runSync/getSyncStatus)
// and auth (runStartupRecovery) so the test asserts ORDERING -- that startup
// recovery runs once per worker, before any sync, even when onStartup never fires.

const { runStartupRecovery, runSync, getSyncStatus } = vi.hoisted(() => ({
  runStartupRecovery: vi.fn(async () => undefined),
  runSync: vi.fn(async () => undefined),
  getSyncStatus: vi.fn(async () => "idle" as const),
}));

vi.mock("../../src/lib/auth", () => ({ runStartupRecovery }));
vi.mock("../../src/lib/sync/orchestrator", () => ({ runSync, getSyncStatus }));

import { isExtensionMessage } from "../../src/lib/messages";

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
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn((l: () => void) => (capture.startupListener = l)) },
      onMessage: { addListener: vi.fn((l: MessageListener) => (capture.messageListener = l)) },
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
    capture.messageListener!({ type: "SYNC_START" }, undefined, vi.fn());
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
    capture.messageListener!({ type: "SYNC_START" }, undefined, vi.fn());
    await flushMicrotasks();

    // Assert: the per-worker memo collapses both into a single recovery.
    expect(runStartupRecovery).toHaveBeenCalledTimes(1);
    expect(runSync).toHaveBeenCalledTimes(2);
  });

  it("guard sanity: SYNC_START is a recognized extension message", () => {
    // The trigger path only fires for messages the guard accepts.
    expect(isExtensionMessage({ type: "SYNC_START" })).toBe(true);
  });
});
