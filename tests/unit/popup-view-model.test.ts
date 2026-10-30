import { describe, expect, it } from "vitest";

import {
  actionErrorText,
  controlsView,
  DISCLOSURE_TEXT,
  focusKeyAfterRender,
  INITIAL_UI_STATE,
  isLive,
  messageText,
  MIN_BURST_MS,
  nextPollDelay,
  NO_PLATFORM_TEXT,
  POLL_INTERVAL_MS,
  reduceUi,
  SLOW_POLL_INTERVAL_MS,
  syncBlockedText,
  toPopupView,
  type ActionType,
  type UiState,
} from "../../entrypoints/popup/view-model";
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
    pairing: false,
    pairFailure: null,
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

  it("shows last synced when present and 'Never synced' when absent", () => {
    const view = toPopupView(
      snapshot({
        platforms: [platform({ lastRunAt: "2026-10-30T11:00:00.000Z" }), platform()],
      }),
      formatTime,
    );

    expect(view.platforms.map((entry) => entry.lastRunText)).toEqual([
      "Last synced <2026-10-30T11:00:00.000Z>",
      "Never synced",
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

const PAUSE_END_EARLY = "2026-10-30T13:00:00.000Z";
const PAUSE_END_LATE = "2026-10-30T15:00:00.000Z";

function paused(name: PlatformStatus["platform"], until: string): PlatformStatus {
  return platform({
    platform: name,
    status: "paused",
    pauseReason: "rate_limited",
    pausedUntil: until,
  });
}

function ui(overrides: Partial<UiState> = {}): UiState {
  return { ...INITIAL_UI_STATE, ...overrides };
}

describe("toPopupView pairing in progress", () => {
  it.each<[AuthState]>([["none"], ["reconnect_required"]])(
    "auth %s while pairing shows the pairing text and a disabled pair action",
    (auth) => {
      const view = toPopupView(snapshot({ auth, pairing: true }), formatTime);

      expect(view.pairingText).toBe("Pairing... finish in the sign-in window.");
      const pair = view.actions.find((action) => action.type === "PAIR_START");
      expect(pair?.disabled).toBe(true);
    },
  );

  it("not pairing shows no pairing text and an enabled pair action", () => {
    const view = toPopupView(snapshot({ auth: "none", pairing: false }), formatTime);

    expect(view.pairingText).toBeNull();
    expect(view.actions[0]?.disabled).toBe(false);
  });
});

describe("toPopupView persisted pair failure", () => {
  it.each<[string, AuthState, boolean, string | null]>([
    ["unpaired", "none", false, "Pairing was cancelled."],
    ["reconnect required", "reconnect_required", false, "Pairing was cancelled."],
    ["paired", "ok", false, null],
    ["new attempt running", "none", true, null],
  ])("%s", (_name, auth, pairing, expected) => {
    const view = toPopupView(
      snapshot({ auth, pairing, pairFailure: "user_cancelled" }),
      formatTime,
    );

    expect(view.pairFailureText).toBe(expected);
  });

  it("shows nothing when there is no failure", () => {
    expect(toPopupView(snapshot({ auth: "none" }), formatTime).pairFailureText).toBeNull();
  });
});

describe("toPopupView paused-platform skip notice", () => {
  const expected = `Paused platforms are skipped until their pause ends. The first pause ends <${PAUSE_END_EARLY}>.`;

  it.each<[string, PlatformStatus[], string | null]>([
    [
      "every enabled platform paused, earliest end wins",
      [paused("chatgpt", PAUSE_END_LATE), paused("claude", PAUSE_END_EARLY)],
      expected,
    ],
    [
      "the only enabled platform is paused",
      [paused("chatgpt", PAUSE_END_EARLY), platform({ platform: "claude", enabled: false })],
      expected,
    ],
    [
      "one enabled platform is still idle",
      [paused("chatgpt", PAUSE_END_EARLY), platform({ platform: "claude" })],
      null,
    ],
    [
      "every platform disabled",
      [platform({ enabled: false }), { ...paused("claude", PAUSE_END_EARLY), enabled: false }],
      null,
    ],
    ["nothing paused", [platform(), platform({ platform: "claude" })], null],
  ])("%s", (_name, platforms, text) => {
    const view = toPopupView(snapshot({ platforms }), formatTime);

    expect(view.pauseSkipText).toBe(text);
  });

  it("keeps Sync now enabled while every enabled platform is paused", () => {
    const view = toPopupView(
      snapshot({
        platforms: [paused("chatgpt", PAUSE_END_EARLY), paused("claude", PAUSE_END_LATE)],
      }),
      formatTime,
    );

    expect(view.actions.find((action) => action.type === "SYNC_START")?.disabled).toBe(false);
  });

  it("is hidden while unpaired", () => {
    const view = toPopupView(
      snapshot({ auth: "none", platforms: [paused("chatgpt", PAUSE_END_EARLY)] }),
      formatTime,
    );

    expect(view.pauseSkipText).toBeNull();
  });
});

describe("isLive", () => {
  it.each<[string, unknown, boolean]>([
    ["idle and not pairing", snapshot(), false],
    ["pairing", snapshot({ pairing: true }), true],
    ["a platform syncing", snapshot({ platforms: [platform({ status: "syncing" })] }), true],
    ["a platform paused", snapshot({ platforms: [paused("chatgpt", PAUSE_END_EARLY)] }), false],
    ["no response", undefined, false],
  ])("%s -> %s", (_name, response, expected) => {
    expect(isLive(response)).toBe(expected);
  });
});

describe("nextPollDelay", () => {
  const start = 1_000_000;
  const burst = { startedAt: start, minMs: MIN_BURST_MS };
  const syncing = snapshot({ platforms: [platform({ status: "syncing" })] });

  it.each<[string, unknown, number, number | null]>([
    ["no response stops at once", undefined, start + 1_000, null],
    ["control error stops at once", { ok: false, reason: "internal" }, start + 1_000, null],
    ["idle inside the minimum polls fast", snapshot(), start + MIN_BURST_MS - 1, POLL_INTERVAL_MS],
    ["idle at the minimum stops", snapshot(), start + MIN_BURST_MS, null],
    ["syncing after the minimum polls fast", syncing, start + 30_000, POLL_INTERVAL_MS],
    [
      "pairing after the minimum polls fast",
      snapshot({ pairing: true }),
      start + 30_000,
      POLL_INTERVAL_MS,
    ],
    ["syncing just inside the first minute polls fast", syncing, start + 59_999, POLL_INTERVAL_MS],
    ["syncing after the first minute slows down", syncing, start + 60_000, SLOW_POLL_INTERVAL_MS],
    [
      "syncing after ten minutes keeps polling slowly",
      syncing,
      start + 600_000,
      SLOW_POLL_INTERVAL_MS,
    ],
    ["idle after a long sync stops", snapshot(), start + 600_000, null],
  ])("%s", (_name, response, now, expected) => {
    expect(nextPollDelay(response, burst, now)).toBe(expected);
  });

  it.each<[string, unknown, number | null]>([
    ["live at load keeps polling", snapshot({ pairing: true }), POLL_INTERVAL_MS],
    ["idle stops", snapshot(), null],
  ])("a burst with no minimum: %s", (_name, response, expected) => {
    expect(nextPollDelay(response, { startedAt: start, minMs: 0 }, start + 1_000)).toBe(expected);
  });
});

describe("syncBlockedText", () => {
  const off = (name: "chatgpt" | "claude"): PlatformStatus =>
    platform({ platform: name, enabled: false });

  it.each<[string, unknown, string | null]>([
    [
      "both platforms off",
      snapshot({ platforms: [off("chatgpt"), off("claude")] }),
      NO_PLATFORM_TEXT,
    ],
    [
      "one platform on",
      snapshot({ platforms: [off("chatgpt"), platform({ platform: "claude" })] }),
      null,
    ],
    ["both platforms on", snapshot(), null],
    ["no response", undefined, null],
  ])("%s", (_name, response, expected) => {
    expect(syncBlockedText(response)).toBe(expected);
  });

  it("names both platforms being off", () => {
    expect(NO_PLATFORM_TEXT).toBe("Both platforms are off. Turn one on to sync.");
  });
});

describe("reduceUi", () => {
  it("starting an action clears the error, the notice and a pending confirmation", () => {
    const state = ui({ actionError: "x", notice: "y", confirmingDisconnect: true });

    expect(reduceUi(state, { type: "action_started", action: "SYNC_START" })).toEqual(
      ui({ pendingAction: "SYNC_START" }),
    );
  });

  it.each<[string, ActionType, unknown, UiState]>([
    [
      "sync ok sets the started notice",
      "SYNC_START",
      { ok: true },
      ui({ notice: "Sync started." }),
    ],
    [
      "sync failure sets the error and no notice",
      "SYNC_START",
      undefined,
      ui({ actionError: "No response from the extension. Try again." }),
    ],
    [
      "pair failure sets the error",
      "PAIR_START",
      { ok: false, reason: "network" },
      ui({ actionError: "Network error while pairing. Try again." }),
    ],
    ["unpair ok leaves no notice", "UNPAIR", { ok: true }, ui()],
  ])("%s", (_name, action, response, expected) => {
    const started = reduceUi(ui(), { type: "action_started", action });

    expect(reduceUi(started, { type: "action_finished", action, response })).toEqual(expected);
  });

  it.each<[ActionType, boolean]>([
    ["UNPAIR", true],
    ["SYNC_START", false],
  ])("starting %s from a pending confirmation keeps it: %s", (action, confirming) => {
    const state = reduceUi(ui({ confirmingDisconnect: true }), { type: "action_started", action });

    expect(state).toEqual(ui({ confirmingDisconnect: confirming, pendingAction: action }));
  });

  it("asks before disconnecting and cancels back", () => {
    const asked = reduceUi(ui({ actionError: "x" }), { type: "disconnect_asked" });

    expect(asked).toEqual(ui({ confirmingDisconnect: true }));
    expect(reduceUi(asked, { type: "disconnect_cancelled" })).toEqual(ui());
  });

  it("a blocked sync shows its notice and clears the error and confirmation", () => {
    const state = ui({ actionError: "x", notice: "Sync started.", confirmingDisconnect: true });

    expect(reduceUi(state, { type: "sync_blocked", text: NO_PLATFORM_TEXT })).toEqual(
      ui({ notice: NO_PLATFORM_TEXT }),
    );
  });

  it.each<[string, unknown, string | null]>([
    [
      "turning a platform on clears it",
      snapshot({ platforms: [platform(), platform({ platform: "claude", enabled: false })] }),
      null,
    ],
    [
      "both still off keeps it",
      snapshot({
        platforms: [platform({ enabled: false }), platform({ platform: "claude", enabled: false })],
      }),
      NO_PLATFORM_TEXT,
    ],
  ])("the both-off notice on a status update: %s", (_name, response, notice) => {
    const state = reduceUi(ui({ notice: NO_PLATFORM_TEXT }), { type: "status_received", response });

    expect(state.notice).toBe(notice);
  });

  it("a status update keeps an unrelated notice", () => {
    const state = reduceUi(ui({ notice: "Sync started." }), {
      type: "status_received",
      response: snapshot(),
    });

    expect(state.notice).toBe("Sync started.");
  });

  it("ending a poll burst clears only the notice", () => {
    const state = ui({ notice: "Sync started.", actionError: "x", confirmingDisconnect: true });

    expect(reduceUi(state, { type: "burst_ended" })).toEqual(
      ui({ actionError: "x", confirmingDisconnect: true }),
    );
  });

  it.each<[string, unknown, boolean]>([
    ["paired keeps the confirmation", snapshot({ auth: "ok" }), true],
    ["reconnect keeps the confirmation", snapshot({ auth: "reconnect_required" }), true],
    ["unpaired drops the confirmation", snapshot({ auth: "none" }), false],
    ["no response drops the confirmation", undefined, false],
  ])("a status update: %s", (_name, response, confirming) => {
    const state = reduceUi(ui({ confirmingDisconnect: true }), {
      type: "status_received",
      response,
    });

    expect(state.confirmingDisconnect).toBe(confirming);
  });
});

describe("messageText precedence", () => {
  const failed = snapshot({ auth: "none", pairFailure: "network" });
  const skipping = snapshot({
    platforms: [paused("chatgpt", PAUSE_END_EARLY), paused("claude", PAUSE_END_LATE)],
  });
  const skipText = `Paused platforms are skipped until their pause ends. The first pause ends <${PAUSE_END_EARLY}>.`;

  it.each<[string, unknown, UiState, string]>([
    [
      "action error beats a persisted failure",
      failed,
      ui({ actionError: "Request refused." }),
      "Request refused.",
    ],
    ["unavailable status", undefined, ui(), "Status unavailable. Reopen the popup to try again."],
    [
      "pairing",
      snapshot({ auth: "none", pairing: true }),
      ui(),
      "Pairing... finish in the sign-in window.",
    ],
    ["persisted pair failure", failed, ui(), "Network error while pairing. Try again."],
    ["notice", snapshot(), ui({ notice: "Sync started." }), "Sync started."],
    ["notice beats the pause skip", skipping, ui({ notice: "Sync started." }), "Sync started."],
    ["pause skip", skipping, ui(), skipText],
    ["nothing to say", snapshot(), ui(), ""],
  ])("%s", (_name, response, state, expected) => {
    expect(messageText(toPopupView(response, formatTime), state)).toBe(expected);
  });
});

describe("controlsView", () => {
  const keys = (buttons: readonly { key: string }[]): string[] => buttons.map((b) => b.key);

  it("paired: Sync now first, Disconnect in its own block", () => {
    const controls = controlsView(toPopupView(snapshot(), formatTime), ui());

    expect(keys(controls.primary)).toEqual(["SYNC_START"]);
    expect(keys(controls.disconnect)).toEqual(["UNPAIR_ASK"]);
    expect(controls.confirmText).toBeNull();
  });

  it("confirming: shows the prompt with Disconnect and Cancel", () => {
    const controls = controlsView(
      toPopupView(snapshot(), formatTime),
      ui({ confirmingDisconnect: true }),
    );

    expect(controls.confirmText).toBe("Disconnect? The next pairing re-imports from scratch.");
    expect(controls.disconnect.map((b) => [b.key, b.label])).toEqual([
      ["UNPAIR_CONFIRM", "Disconnect"],
      ["UNPAIR_CANCEL", "Cancel"],
    ]);
  });

  it.each<[string, UiState, string, boolean]>([
    ["sync pending disables Sync now", ui({ pendingAction: "SYNC_START" }), "SYNC_START", true],
    ["nothing pending leaves Sync now enabled", ui(), "SYNC_START", false],
    [
      "unpair pending disables the confirm",
      ui({ confirmingDisconnect: true, pendingAction: "UNPAIR" }),
      "UNPAIR_CONFIRM",
      true,
    ],
  ])("%s", (_name, state, key, disabled) => {
    const controls = controlsView(toPopupView(snapshot(), formatTime), state);
    const button = [...controls.primary, ...controls.disconnect].find((b) => b.key === key);

    expect(button?.disabled).toBe(disabled);
  });

  it("unpaired: only Pair, no disconnect block", () => {
    const controls = controlsView(toPopupView(snapshot({ auth: "none" }), formatTime), ui());

    expect(keys(controls.primary)).toEqual(["PAIR_START"]);
    expect(controls.disconnect).toEqual([]);
  });
});

describe("focusKeyAfterRender", () => {
  it.each<[string, string | null, string[], string | null]>([
    [
      "same key still present",
      "platform:claude",
      ["SYNC_START", "platform:claude"],
      "platform:claude",
    ],
    [
      "ask became confirm/cancel",
      "UNPAIR_ASK",
      ["UNPAIR_CONFIRM", "UNPAIR_CANCEL"],
      "UNPAIR_CANCEL",
    ],
    ["cancel became ask", "UNPAIR_CANCEL", ["SYNC_START", "UNPAIR_ASK"], "UNPAIR_ASK"],
    ["confirm led to unpaired", "UNPAIR_CONFIRM", ["PAIR_START"], "PAIR_START"],
    ["nothing focused", null, ["SYNC_START"], null],
    ["key gone with no fallback", "platform:claude", ["SYNC_START"], null],
  ])("%s", (_name, previous, available, expected) => {
    expect(focusKeyAfterRender(previous, available)).toBe(expected);
  });
});
