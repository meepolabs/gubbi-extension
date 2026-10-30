import { describe, expect, it } from "vitest";

import { actionErrorText, DISCLOSURE_TEXT, toPopupView } from "../../entrypoints/popup/view-model";
import type { AuthState, PlatformStatus, StatusSnapshot } from "../../src/lib/messages";

const formatTime = (iso: string): string => `<${iso}>`;

const EXACT_DISCLOSURE =
  "gubbi will import your ChatGPT and Claude chats. You can turn either off.";

function platform(overrides: Partial<PlatformStatus> = {}): PlatformStatus {
  return {
    platform: "chatgpt",
    enabled: true,
    status: "idle",
    pausedUntil: null,
    pauseReason: null,
    lastRunAt: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    ok: true,
    auth: "ok",
    platforms: [platform(), platform({ platform: "claude" })],
    nextSyncAt: null,
    ...overrides,
  };
}

describe("toPopupView actions by auth state", () => {
  it.each<[AuthState, string[], string[]]>([
    ["none", ["PAIR_START"], ["Pair"]],
    ["ok", ["SYNC_START", "UNPAIR"], ["Sync now", "Disconnect"]],
    ["reconnect_required", ["PAIR_START", "UNPAIR"], ["Reconnect", "Disconnect"]],
  ])("auth %s offers %j", (auth, types, labels) => {
    const view = toPopupView(snapshot({ auth }), formatTime);

    expect(view.actions.map((action) => action.type)).toEqual(types);
    expect(view.actions.map((action) => action.label)).toEqual(labels);
    expect(view.errorText).toBeNull();
  });
});

describe("toPopupView disclosure", () => {
  it.each<[string, unknown]>([
    ["auth none", snapshot({ auth: "none" })],
    ["auth ok", snapshot({ auth: "ok" })],
    ["auth reconnect_required", snapshot({ auth: "reconnect_required" })],
    ["control error", { ok: false, reason: "internal" }],
    ["no response", undefined],
  ])("shows the exact disclosure for %s", (_name, response) => {
    expect(DISCLOSURE_TEXT).toBe(EXACT_DISCLOSURE);
    expect(toPopupView(response, formatTime).disclosure).toBe(EXACT_DISCLOSURE);
  });
});

describe("toPopupView platforms", () => {
  it("renders a disabled platform unchecked and an enabled one checked", () => {
    const view = toPopupView(
      snapshot({ platforms: [platform({ enabled: false }), platform({ platform: "claude" })] }),
      formatTime,
    );

    expect(view.platforms.map((entry) => [entry.label, entry.enabled])).toEqual([
      ["ChatGPT", false],
      ["Claude", true],
    ]);
  });

  it("shows a paused platform's reason and pausedUntil", () => {
    const view = toPopupView(
      snapshot({
        platforms: [
          platform({
            status: "paused",
            pauseReason: "rate_limited",
            pausedUntil: "2026-10-30T13:00:00.000Z",
          }),
        ],
      }),
      formatTime,
    );

    expect(view.platforms[0]?.statusText).toBe("Paused");
    expect(view.platforms[0]?.pauseText).toBe(
      "Paused (rate limited) until <2026-10-30T13:00:00.000Z>",
    );
  });

  it("renders an ended pause, which the background reports as idle, without a pause line", () => {
    const view = toPopupView(
      snapshot({ platforms: [platform({ status: "idle", pauseReason: null, pausedUntil: null })] }),
      formatTime,
    );

    expect(view.platforms[0]?.statusText).toBe("Idle");
    expect(view.platforms[0]?.pauseText).toBeNull();
  });

  it("shows no pause line for a platform that is not paused", () => {
    const view = toPopupView(snapshot(), formatTime);

    expect(view.platforms.map((entry) => entry.pauseText)).toEqual([null, null]);
  });

  it("shows last run when present and 'Never run' when absent", () => {
    const view = toPopupView(
      snapshot({
        platforms: [platform({ lastRunAt: "2026-10-30T11:00:00.000Z" }), platform()],
      }),
      formatTime,
    );

    expect(view.platforms.map((entry) => entry.lastRunText)).toEqual([
      "Last run <2026-10-30T11:00:00.000Z>",
      "Never run",
    ]);
  });
});

describe("toPopupView next sync", () => {
  it("shows nextSyncAt when scheduled", () => {
    const view = toPopupView(snapshot({ nextSyncAt: "2026-10-30T12:30:00.000Z" }), formatTime);

    expect(view.nextSyncText).toBe("Next sync <2026-10-30T12:30:00.000Z>");
  });

  it("shows nothing when no sync is scheduled", () => {
    expect(toPopupView(snapshot({ nextSyncAt: null }), formatTime).nextSyncText).toBeNull();
  });
});

describe("toPopupView unavailable status", () => {
  it.each<[string, unknown]>([
    ["control error", { ok: false, reason: "forbidden_sender" }],
    ["no response", undefined],
    ["platforms missing", { ok: true, auth: "ok", nextSyncAt: null }],
  ])("%s yields an error view with no actions", (_name, response) => {
    const view = toPopupView(response, formatTime);

    expect(view.actions).toEqual([]);
    expect(view.platforms).toEqual([]);
    expect(view.errorText).toBe("Status unavailable. Reopen the popup to try again.");
  });
});

describe("actionErrorText", () => {
  it.each<[string, unknown, string | null]>([
    ["success", { ok: true }, null],
    ["no response", undefined, "No response from the extension. Try again."],
    ["pair cancelled", { ok: false, reason: "user_cancelled" }, "Pairing was cancelled."],
    ["pair network", { ok: false, reason: "network" }, "Network error while pairing. Try again."],
    ["unpair busy", { ok: false, reason: "busy" }, "A sync is running. Try again in a moment."],
    ["control internal", { ok: false, reason: "internal" }, "Something went wrong. Try again."],
    ["control forbidden", { ok: false, reason: "forbidden_sender" }, "Request refused."],
    ["unknown reason", { ok: false, reason: "toString" }, "Something went wrong. Try again."],
  ])("%s", (_name, response, expected) => {
    expect(actionErrorText(response)).toBe(expected);
  });
});
