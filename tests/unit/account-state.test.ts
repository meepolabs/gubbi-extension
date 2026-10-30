import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAccountState } from "../../src/lib/account-state";
import { stubChromeStorage } from "../helpers/chrome-stub";

const lockRecord = { ownerId: "holder", acquiredAt: 1, heartbeatAt: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clearAccountState", () => {
  it.each([
    ["cursor", "gubbi:cursor:chatgpt", "2026-01-01T00:00:00Z"],
    ["pause state", "gubbi:pauseState:claude", { pausedUntil: "2026-01-01T00:00:00Z" }],
    ["drift counter", "gubbi:drift:chatgpt", 2],
    ["transient counter", "gubbi:transient:claude", 3],
    ["partial-save counter", "gubbi:partialSave:chatgpt", 1],
    ["counters", "gubbi:counters", { conversations_uploaded: 4 }],
    ["status", "gubbi:status:chatgpt", "error"],
    ["last run", "gubbi:lastRunAt:claude", "2026-01-01T00:00:00Z"],
    ["events", "gubbi:syncEvents", [{ at: "2026-01-01T00:00:00Z", kind: "run_start" }]],
    ["auth blob", "gubbi:authBlob", { refreshToken: "rt" }],
    ["unknown future key", "gubbi:future-key", true],
  ])("removes the %s", async (_name, key, value) => {
    // Arrange
    const { store } = stubChromeStorage();
    store[key] = value;

    // Act
    await clearAccountState();

    // Assert
    expect(key in store).toBe(false);
  });

  it("keeps the locks, the schema version, the enabled flags and foreign keys", async () => {
    // Arrange
    const { store } = stubChromeStorage();
    const kept = {
      "gubbi:lease": lockRecord,
      "gubbi:authLock": lockRecord,
      "gubbi:schema_version": 1,
      "gubbi:enabled:chatgpt": false,
      "gubbi:enabled:claude": true,
      "other:cursor:chatgpt": "x",
    };
    Object.assign(store, kept, { "gubbi:cursor:claude": "2026-01-01T00:00:00Z" });

    // Act
    await clearAccountState();

    // Assert
    expect(store).toEqual(kept);
  });
});
