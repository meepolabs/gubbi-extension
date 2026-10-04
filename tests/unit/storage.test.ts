import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendSyncEvent,
  getAuthBlob,
  getPauseState,
  getPendingAuthFlow,
  getRefreshState,
  getSchemaVersion,
  getStatus,
  getSyncEvents,
  MAX_SYNC_EVENTS,
  migrate,
  setAuthBlob,
  setPauseState,
  setRefreshState,
  setSchemaVersion,
  setStatus,
  type AuthBlob,
  type PauseState,
  type PendingAuthFlow,
  type RefreshState,
  type SyncEvent,
} from "../../src/lib/storage";

// Minimal in-memory chrome.storage.local stub. getItem reads `record[key]`, so
// get() must return { [key]: value } when present and {} when absent.
function stubChromeStorage(store: Record<string, unknown>): void {
  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
}

// Stub whose set() actually persists to the backing store, so round-trips and
// read-modify-write flows (ring buffer append) observe their own writes.
function stubPersistentStorage(store: Record<string, unknown>): void {
  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store[k] = v;
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
}

beforeEach(() => {
  // Silence the deliberate warn emitted when a malformed blob is discarded.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("status (validated read through the zod layer)", () => {
  it("round-trips a valid status through set then get", async () => {
    // Arrange
    const store: Record<string, unknown> = {};
    stubPersistentStorage(store);

    // Act
    await setStatus("chatgpt", "syncing");
    const result = await getStatus("chatgpt");

    // Assert
    expect(result).toBe("syncing");
    expect(store["gubbi:status:chatgpt"]).toBe("syncing");
  });

  it("defaults to idle when nothing is stored", async () => {
    // Arrange
    stubChromeStorage({});

    // Act
    const result = await getStatus("claude");

    // Assert
    expect(result).toBe("idle");
  });

  it("defaults to idle for an unknown stored status value", async () => {
    // Arrange: a value an older/newer build wrote that this enum does not know.
    stubChromeStorage({ "gubbi:status:chatgpt": "frobnicating" });

    // Act
    const result = await getStatus("chatgpt");

    // Assert
    expect(result).toBe("idle");
  });

  it("keys chatgpt and claude independently", async () => {
    // Arrange
    const store: Record<string, unknown> = {};
    stubPersistentStorage(store);

    // Act
    await setStatus("chatgpt", "paused");
    await setStatus("claude", "reconnect_required");

    // Assert
    expect(await getStatus("chatgpt")).toBe("paused");
    expect(await getStatus("claude")).toBe("reconnect_required");
  });
});

describe("authBlob (validated read)", () => {
  const valid: AuthBlob = {
    version: 1,
    accessToken: "at",
    accessTokenExpiresAt: "2026-06-06T12:00:00Z",
    refreshToken: "rt",
    status: "ok",
    updatedAt: "2026-06-06T11:00:00Z",
  };

  it("returns the auth blob when the stored blob matches the schema", async () => {
    // Arrange
    stubChromeStorage({ "gubbi:authBlob": valid });

    // Act
    const result = await getAuthBlob();

    // Assert
    expect(result).toEqual(valid);
  });

  it("returns undefined when status is an unknown enum value", async () => {
    // Arrange
    stubChromeStorage({ "gubbi:authBlob": { ...valid, status: "expired" } });

    // Act
    const result = await getAuthBlob();

    // Assert
    expect(result).toBeUndefined();
  });

  it("returns undefined for a malformed blob (missing fields)", async () => {
    // Arrange
    stubChromeStorage({ "gubbi:authBlob": { accessToken: "at" } });

    // Act
    const result = await getAuthBlob();

    // Assert
    expect(result).toBeUndefined();
  });

  it("round-trips a valid blob through set then get", async () => {
    // Arrange
    const store: Record<string, unknown> = {};
    stubPersistentStorage(store);

    // Act
    await setAuthBlob(valid);
    const result = await getAuthBlob();

    // Assert
    expect(result).toEqual(valid);
  });
});

describe("pendingAuthFlow (validated read)", () => {
  const valid: PendingAuthFlow = {
    state: "s",
    codeVerifier: "v",
    redirectUri: "https://example.com/cb",
    startedAt: "2026-06-06T12:00:00Z",
  };

  it("returns the pending flow when the stored blob matches the schema", async () => {
    // Arrange
    stubChromeStorage({ "gubbi:pendingAuthFlow": valid });

    // Act
    const result = await getPendingAuthFlow();

    // Assert
    expect(result).toEqual(valid);
  });

  it("returns undefined for a malformed blob (bad startedAt)", async () => {
    // Arrange
    stubChromeStorage({ "gubbi:pendingAuthFlow": { ...valid, startedAt: "nope" } });

    // Act
    const result = await getPendingAuthFlow();

    // Assert
    expect(result).toBeUndefined();
  });
});

describe("refreshState (rotation-safety marker)", () => {
  const valid: RefreshState = {
    ownerId: "owner-1",
    authVersionBefore: 3,
    startedAt: "2026-06-06T12:00:00Z",
  };

  it("round-trips through set then get", async () => {
    // Arrange
    const store: Record<string, unknown> = {};
    stubPersistentStorage(store);

    // Act
    await setRefreshState(valid);
    const result = await getRefreshState();

    // Assert
    expect(result).toEqual(valid);
  });

  it("returns undefined for a malformed blob (non-integer authVersionBefore)", async () => {
    // Arrange
    stubChromeStorage({ "gubbi:refreshState": { ...valid, authVersionBefore: 1.5 } });

    // Act
    const result = await getRefreshState();

    // Assert
    expect(result).toBeUndefined();
  });
});

describe("pauseState (per-platform namespacing)", () => {
  const chatgpt: PauseState = { pausedUntil: "2026-06-06T13:00:00Z", reason: "rate_limited" };
  const claude: PauseState = { pausedUntil: "2026-06-06T14:00:00Z", reason: "drift" };

  it("keys chatgpt and claude independently", async () => {
    // Arrange
    const store: Record<string, unknown> = {};
    stubPersistentStorage(store);

    // Act
    await setPauseState("chatgpt", chatgpt);
    await setPauseState("claude", claude);

    // Assert
    expect(await getPauseState("chatgpt")).toEqual(chatgpt);
    expect(await getPauseState("claude")).toEqual(claude);
    expect(store["gubbi:pauseState:chatgpt"]).toEqual(chatgpt);
    expect(store["gubbi:pauseState:claude"]).toEqual(claude);
  });

  it("returns undefined for an unknown reason enum value", async () => {
    // Arrange
    stubChromeStorage({
      "gubbi:pauseState:chatgpt": { pausedUntil: "2026-06-06T13:00:00Z", reason: "banned" },
    });

    // Act
    const result = await getPauseState("chatgpt");

    // Assert
    expect(result).toBeUndefined();
  });
});

describe("sync event ring buffer", () => {
  it("appends an entry and reads it back", async () => {
    // Arrange
    const store: Record<string, unknown> = {};
    stubPersistentStorage(store);
    const entry: SyncEvent = {
      at: "2026-06-06T12:00:00Z",
      kind: "run_started",
      platform: "chatgpt",
    };

    // Act
    await appendSyncEvent(entry);
    const events = await getSyncEvents();

    // Assert
    expect(events).toEqual([entry]);
  });

  it("evicts the oldest entry when exceeding the cap", async () => {
    // Arrange: pre-fill with exactly MAX_SYNC_EVENTS entries.
    const store: Record<string, unknown> = {};
    const seed: SyncEvent[] = Array.from({ length: MAX_SYNC_EVENTS }, (_, i) => ({
      at: "2026-06-06T12:00:00Z",
      kind: `e${i}`,
    }));
    store["gubbi:syncEvents"] = seed;
    stubPersistentStorage(store);

    // Act: writing the 201st entry drops the oldest.
    const newest: SyncEvent = { at: "2026-06-06T13:00:00Z", kind: "newest" };
    await appendSyncEvent(newest);
    const events = await getSyncEvents();

    // Assert
    expect(events.length).toBe(MAX_SYNC_EVENTS);
    expect(events[0]?.kind).toBe("e1");
    expect(events.at(-1)).toEqual(newest);
  });

  it("does not mutate the previously stored array in place", async () => {
    // Arrange
    const store: Record<string, unknown> = {};
    const seed: SyncEvent[] = [{ at: "2026-06-06T12:00:00Z", kind: "first" }];
    store["gubbi:syncEvents"] = seed;
    stubPersistentStorage(store);

    // Act
    await appendSyncEvent({ at: "2026-06-06T13:00:00Z", kind: "second" });

    // Assert: the original array reference handed to the stub is untouched.
    expect(seed).toEqual([{ at: "2026-06-06T12:00:00Z", kind: "first" }]);
  });

  it("returns an empty array when nothing has been appended", async () => {
    // Arrange
    stubChromeStorage({});

    // Act
    const events = await getSyncEvents();

    // Assert
    expect(events).toEqual([]);
  });

  it("returns an empty array when the stored buffer is malformed", async () => {
    // Arrange: a corrupt blob is treated as absent.
    stubChromeStorage({ "gubbi:syncEvents": { not: "an array" } });

    // Act
    const events = await getSyncEvents();

    // Assert
    expect(events).toEqual([]);
  });
});

describe("schema version", () => {
  it("round-trips an integer through set then get", async () => {
    // Arrange
    const store: Record<string, unknown> = {};
    stubPersistentStorage(store);

    // Act
    await setSchemaVersion(2);
    const version = await getSchemaVersion();

    // Assert
    expect(version).toBe(2);
  });

  it("returns undefined for a non-integer stored value", async () => {
    // Arrange
    stubChromeStorage({ "gubbi:schema_version": "two" });

    // Act
    const version = await getSchemaVersion();

    // Assert
    expect(version).toBeUndefined();
  });

  it("migrate is a no-op that returns the current version", () => {
    // Arrange / Act
    const result = migrate(1, 5);

    // Assert
    expect(result).toBe(5);
  });
});
