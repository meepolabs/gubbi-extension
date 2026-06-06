import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLease, type SyncLease } from "../../src/lib/storage";

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

beforeEach(() => {
  // Silence the deliberate warn emitted when a malformed blob is discarded.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getLease (validated read)", () => {
  it("returns the lease when the stored blob matches the schema", async () => {
    // Arrange
    const lease: SyncLease = {
      run_id: "run-1",
      platform: "chatgpt",
      heartbeat_at: "2026-06-05T12:00:00Z",
    };
    stubChromeStorage({ "gubbi:lease": lease });

    // Act
    const result = await getLease();

    // Assert
    expect(result).toEqual(lease);
  });

  it("returns undefined for a malformed blob rather than satisfying the type", async () => {
    // Arrange: a partial blob persisted by an older version (missing run_id,
    // bad platform). A naive cast would hand this back as a SyncLease.
    stubChromeStorage({ "gubbi:lease": { platform: "gemini", heartbeat_at: "not-a-date" } });

    // Act
    const result = await getLease();

    // Assert
    expect(result).toBeUndefined();
  });
});
