import { vi } from "vitest";

// Shared in-memory chrome.storage.local stub for unit tests. Two flavors:
//
//   stubChromeStorage           -- a persistent backing store (set/remove mutate
//                                  it) plus an optional write log recording the
//                                  ORDER of set/remove calls by key, so rotation-
//                                  ordering contracts can be asserted. No
//                                  onChanged dispatch.
//   stubChromeStorageWithEvents -- same persistent store but with a working
//                                  storage.onChanged dispatch, required by code
//                                  paths that use waitForLockReleased (locks) or
//                                  otherwise react to change events.

export interface StorageStub {
  readonly store: Record<string, unknown>;
  readonly writeLog: string[];
}

// chrome.storage.local stub whose set/remove persist to a backing store and
// append to a write log. get() returns { [key]: value } when present and {} when
// absent, matching the shape storage.ts's getItem reads.
export function stubChromeStorage(): StorageStub {
  const store: Record<string, unknown> = {};
  const writeLog: string[] = [];
  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            store[key] = value;
            writeLog.push(`set:${key}`);
          }
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
          writeLog.push(`remove:${key}`);
        }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return { store, writeLog };
}

export interface EventfulStorageStub {
  readonly store: Record<string, unknown>;
}

// chrome.storage.local stub with a real storage.onChanged dispatch, for code that
// waits on change events (e.g. waitForLockReleased).
export function stubChromeStorageWithEvents(): EventfulStorageStub {
  const store: Record<string, unknown> = {};
  type Listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;
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
