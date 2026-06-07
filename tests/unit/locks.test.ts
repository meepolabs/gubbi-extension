import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LockContendedError,
  waitForLockReleased,
  withStorageLock,
  type LockDeps,
} from "../../src/lib/locks";

// In-memory chrome.storage.local + onChanged stub. Unlike storage.test.ts's
// read-only stub, this one persists writes so the write-then-read-back
// acquisition protocol behaves, and dispatches onChanged so the event-driven
// waiter can observe releases.
interface StorageStub {
  readonly store: Record<string, unknown>;
}

function stubChromeStorage(): StorageStub {
  const store: Record<string, unknown> = {};
  type Listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void;
  const listeners = new Set<Listener>();

  const dispatch = (key: string, oldValue: unknown, newValue: unknown): void => {
    const change: chrome.storage.StorageChange = {};
    if (oldValue !== undefined) change.oldValue = oldValue;
    if (newValue !== undefined) change.newValue = newValue;
    for (const listener of listeners) listener({ [key]: change }, "local");
  };

  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            const oldValue = store[key];
            store[key] = value;
            dispatch(key, oldValue, value);
          }
        }),
        remove: vi.fn(async (key: string) => {
          const oldValue = store[key];
          delete store[key];
          dispatch(key, oldValue, undefined);
        }),
      },
      onChanged: {
        addListener: vi.fn((listener: Listener) => listeners.add(listener)),
        removeListener: vi.fn((listener: Listener) => listeners.delete(listener)),
      },
    },
  };

  vi.stubGlobal("chrome", chromeMock);
  return { store };
}

// Deterministic deps: a settable clock plus timer functions that record the
// registered handlers so tests can fire them on demand (heartbeat interval,
// wait timeout) without real elapsed time.
interface FakeClock {
  readonly deps: LockDeps;
  setNow: (ms: number) => void;
  advance: (ms: number) => void;
  fireIntervals: () => Promise<void>;
  fireTimeouts: () => void;
  readonly intervalCount: () => number;
}

function makeFakeClock(startMs = 0): FakeClock {
  let nowMs = startMs;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let nextHandle = 1;

  const deps: LockDeps = {
    now: () => nowMs,
    setInterval: ((handler: () => void) => {
      const handle = nextHandle++;
      intervals.set(handle, handler);
      return handle as unknown as ReturnType<typeof setInterval>;
    }) as LockDeps["setInterval"],
    clearInterval: ((handle: unknown) => {
      intervals.delete(handle as number);
    }) as LockDeps["clearInterval"],
    setTimeout: ((handler: () => void) => {
      const handle = nextHandle++;
      timeouts.set(handle, handler);
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as LockDeps["setTimeout"],
    clearTimeout: ((handle: unknown) => {
      timeouts.delete(handle as number);
    }) as LockDeps["clearTimeout"],
  };

  return {
    deps,
    setNow: (ms) => {
      nowMs = ms;
    },
    advance: (ms) => {
      nowMs += ms;
    },
    fireIntervals: async () => {
      for (const handler of intervals.values()) handler();
      // Let the async heartbeat write settle before assertions.
      await Promise.resolve();
      await Promise.resolve();
    },
    fireTimeouts: () => {
      for (const handler of timeouts.values()) handler();
    },
    intervalCount: () => intervals.size,
  };
}

const TTL_MS = 120_000;
const KEY = "gubbi:test-lock";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("withStorageLock", () => {
  it("acquires, runs fn with an ownerId, and releases on success", async () => {
    // Arrange
    const stub = stubChromeStorage();
    const clock = makeFakeClock(1000);
    let seenOwner = "";

    // Act
    const result = await withStorageLock(
      KEY,
      TTL_MS,
      async (ownerId) => {
        seenOwner = ownerId;
        // Lock is held while fn runs.
        expect(stub.store[KEY]).toBeDefined();
        return 42;
      },
      clock.deps,
    );

    // Assert
    expect(result).toBe(42);
    expect(seenOwner).not.toBe("");
    expect(stub.store[KEY]).toBeUndefined();
  });

  it("rejects the loser with LockContendedError when two acquirers race", async () => {
    // Arrange: the first holder never finishes, so it owns the live lock when
    // the second attempt runs.
    stubChromeStorage();
    const clock = makeFakeClock(1000);
    let releaseFirst = (): void => undefined;
    const firstBlocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    // Resolves when the first holder's fn body has actually been entered, which
    // means acquisition completed and the lock record is committed.
    let firstStarted = (): void => undefined;
    const firstHasStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    // Act
    const firstRun = withStorageLock(
      KEY,
      TTL_MS,
      async () => {
        firstStarted();
        return firstBlocker;
      },
      clock.deps,
    );
    await firstHasStarted;
    const secondRun = withStorageLock(KEY, TTL_MS, async () => "second", clock.deps);

    // Assert
    await expect(secondRun).rejects.toBeInstanceOf(LockContendedError);
    releaseFirst();
    await expect(firstRun).resolves.toBeUndefined();
  });

  it("takes over a lock that is stale past ttlMs", async () => {
    // Arrange: a stale record whose heartbeat is older than ttlMs.
    const stub = stubChromeStorage();
    const clock = makeFakeClock(1_000_000);
    stub.store[KEY] = {
      ownerId: "dead-owner",
      acquiredAt: 0,
      heartbeatAt: clock.deps.now() - TTL_MS - 1,
    };

    // Act
    const result = await withStorageLock(
      KEY,
      TTL_MS,
      async (ownerId) => {
        expect(ownerId).not.toBe("dead-owner");
        return "took-over";
      },
      clock.deps,
    );

    // Assert
    expect(result).toBe("took-over");
  });

  it("keeps the lock alive via heartbeat so it is not taken over", async () => {
    // Arrange
    const stub = stubChromeStorage();
    const clock = makeFakeClock(1000);
    let release = (): void => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => undefined;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    // Act
    const run = withStorageLock(
      KEY,
      TTL_MS,
      async () => {
        started();
        return blocker;
      },
      clock.deps,
    );
    await hasStarted;
    const initial = stub.store[KEY] as { heartbeatAt: number };

    // Advance well past ttl, then fire the heartbeat: it must refresh heartbeatAt.
    clock.advance(TTL_MS * 2);
    await clock.fireIntervals();
    const refreshed = stub.store[KEY] as { heartbeatAt: number };

    // Assert
    expect(refreshed.heartbeatAt).toBe(clock.deps.now());
    expect(refreshed.heartbeatAt).toBeGreaterThan(initial.heartbeatAt);

    release();
    await run;
  });

  it("does not clobber the lock when another owner has taken over", async () => {
    // Arrange: while fn runs, a different owner replaces the record (as a stale
    // takeover would). Release must leave that owner's record intact.
    const stub = stubChromeStorage();
    const clock = makeFakeClock(1000);
    const usurper = { ownerId: "usurper", acquiredAt: 5000, heartbeatAt: 5000 };

    // Act
    await withStorageLock(
      KEY,
      TTL_MS,
      async () => {
        stub.store[KEY] = usurper;
      },
      clock.deps,
    );

    // Assert
    expect(stub.store[KEY]).toEqual(usurper);
  });

  it("releases the lock and propagates when fn rejects", async () => {
    // Arrange
    const stub = stubChromeStorage();
    const clock = makeFakeClock(1000);
    const boom = new Error("fn failed");

    // Act + Assert
    await expect(
      withStorageLock(
        KEY,
        TTL_MS,
        async () => {
          throw boom;
        },
        clock.deps,
      ),
    ).rejects.toBe(boom);
    expect(stub.store[KEY]).toBeUndefined();
  });

  it("stops heartbeating after fn settles", async () => {
    // Arrange
    stubChromeStorage();
    const clock = makeFakeClock(1000);

    // Act
    await withStorageLock(KEY, TTL_MS, async () => "done", clock.deps);

    // Assert: the interval was cleared in finally.
    expect(clock.intervalCount()).toBe(0);
  });
});

describe("waitForLockReleased", () => {
  it("resolves immediately when the key is already absent", async () => {
    // Arrange
    stubChromeStorage();
    const clock = makeFakeClock(1000);

    // Act + Assert
    await expect(waitForLockReleased(KEY, 30_000, clock.deps)).resolves.toBeUndefined();
  });

  it("resolves when the held key is released", async () => {
    // Arrange
    const stub = stubChromeStorage();
    const clock = makeFakeClock(1000);
    stub.store[KEY] = { ownerId: "holder", acquiredAt: 1000, heartbeatAt: 1000 };

    // Act
    const waiter = waitForLockReleased(KEY, 30_000, clock.deps);
    await Promise.resolve();
    await chrome.storage.local.remove(KEY);

    // Assert
    await expect(waiter).resolves.toBeUndefined();
  });

  it("rejects with LockContendedError when the wait times out", async () => {
    // Arrange: the key stays held, so only the timeout can settle the waiter.
    const stub = stubChromeStorage();
    const clock = makeFakeClock(1000);
    stub.store[KEY] = { ownerId: "holder", acquiredAt: 1000, heartbeatAt: 1000 };

    // Act
    const waiter = waitForLockReleased(KEY, 30_000, clock.deps);
    await Promise.resolve();
    clock.fireTimeouts();

    // Assert
    await expect(waiter).rejects.toBeInstanceOf(LockContendedError);
  });
});
