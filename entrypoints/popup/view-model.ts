import type { PairFailureReason } from "../../src/lib/auth";
import type {
  ControlErrorReason,
  PauseReason,
  PlatformStatus,
  StatusSnapshot,
  SyncStatusState,
} from "../../src/lib/messages";
import type { Platform } from "../../src/lib/schema/ingest";

// Pure mapping from control-message replies to what the popup shows. The DOM
// glue in main.ts only renders this; every decision lives here.

export const DISCLOSURE_TEXT =
  "gubbi will import your ChatGPT and Claude chats. You can turn either off.";

export type ActionType = "PAIR_START" | "SYNC_START" | "UNPAIR";

export interface ActionView {
  readonly type: ActionType;
  readonly label: string;
  readonly disabled: boolean;
}

export interface PlatformView {
  readonly platform: Platform;
  readonly label: string;
  readonly enabled: boolean;
  readonly statusText: string;
  readonly pauseText: string | null;
  readonly lastRunText: string;
}

export interface PopupView {
  readonly disclosure: string;
  readonly actions: readonly ActionView[];
  readonly platforms: readonly PlatformView[];
  readonly nextSyncText: string | null;
  readonly errorText: string | null;
  readonly pairingText: string | null;
  readonly pairFailureText: string | null;
  readonly pauseSkipText: string | null;
}

export type FormatTime = (iso: string) => string;

const PLATFORM_LABELS: Record<Platform, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
};

const STATUS_LABELS: Record<SyncStatusState, string> = {
  idle: "Idle",
  syncing: "Syncing",
  paused: "Paused",
  reconnect_required: "Reconnect required",
};

const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  rate_limited: "rate limited",
  drift: "data mismatch",
  transient: "temporary error",
  session_lost: "signed out of the site",
  waiting_for_tab: "waiting for an open tab",
  org_ambiguous: "more than one organization",
};

const PAIR_FAILURE_TEXT: Record<PairFailureReason, string> = {
  state_mismatch: "Pairing was rejected for safety. Try again.",
  user_cancelled: "Pairing was cancelled.",
  exchange_failed: "Pairing failed. Try again.",
  network: "Network error while pairing. Try again.",
  superseded: "Disconnected while pairing. Pair again to connect.",
  busy: "A sync is running. Try again in a moment.",
};

const CONTROL_ERROR_TEXT: Record<ControlErrorReason, string> = {
  forbidden_sender: "Request refused.",
  invalid_payload: "Request refused.",
  internal: "Something went wrong. Try again.",
};

const BUSY_TEXT = "A sync is running. Try again in a moment.";
const UNAVAILABLE_TEXT = "Status unavailable. Reopen the popup to try again.";
const NO_ACTION_RESPONSE_TEXT = "No response from the extension. Try again.";

const PAIRING_TEXT = "Pairing... finish in the sign-in window.";
const PAUSE_SKIP_TEXT = "Paused platforms are skipped until their pause ends.";

export const defaultFormatTime: FormatTime = (iso) => new Date(iso).toLocaleString();

function isStatusSnapshot(value: unknown): value is StatusSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { ok?: unknown; auth?: unknown; platforms?: unknown };
  return (
    candidate.ok === true &&
    typeof candidate.auth === "string" &&
    Array.isArray(candidate.platforms)
  );
}

function actionsFor(snapshot: StatusSnapshot): readonly ActionView[] {
  const pair = (label: string): ActionView => ({
    type: "PAIR_START",
    label,
    disabled: snapshot.pairing,
  });
  const disconnect: ActionView = { type: "UNPAIR", label: "Disconnect", disabled: false };
  switch (snapshot.auth) {
    case "none":
      return [pair("Pair")];
    case "ok":
      return [{ type: "SYNC_START", label: "Sync now", disabled: false }, disconnect];
    case "reconnect_required":
      return [pair("Reconnect"), disconnect];
  }
}

function pairFailureText(snapshot: StatusSnapshot): string | null {
  if (snapshot.pairing || snapshot.auth === "ok" || snapshot.pairFailure === null) return null;
  return PAIR_FAILURE_TEXT[snapshot.pairFailure];
}

// Shown when a manual sync would skip every enabled platform, so Sync now does
// not look broken.
function pauseSkipText(snapshot: StatusSnapshot, formatTime: FormatTime): string | null {
  if (snapshot.auth !== "ok") return null;
  const enabled = snapshot.platforms.filter((status) => status.enabled);
  const ends = enabled.map((status) => status.pausedUntil);
  if (ends.length === 0 || ends.some((end) => end === null)) return null;
  const earliest = (ends as string[]).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
  return `${PAUSE_SKIP_TEXT} The first pause ends ${formatTime(earliest)}.`;
}

function platformView(status: PlatformStatus, formatTime: FormatTime): PlatformView {
  const pauseText =
    status.pauseReason !== null && status.pausedUntil !== null
      ? `Paused (${PAUSE_REASON_LABELS[status.pauseReason]}) until ${formatTime(status.pausedUntil)}`
      : null;
  return {
    platform: status.platform,
    label: PLATFORM_LABELS[status.platform],
    enabled: status.enabled,
    statusText: STATUS_LABELS[status.status],
    pauseText,
    lastRunText:
      status.lastRunAt === null ? "Never synced" : `Last synced ${formatTime(status.lastRunAt)}`,
  };
}

// `response` is whatever STATUS_REQUEST answered, including undefined when the
// background never replied.
export function toPopupView(response: unknown, formatTime: FormatTime): PopupView {
  if (!isStatusSnapshot(response)) {
    return {
      disclosure: DISCLOSURE_TEXT,
      actions: [],
      platforms: [],
      nextSyncText: null,
      errorText: UNAVAILABLE_TEXT,
      pairingText: null,
      pairFailureText: null,
      pauseSkipText: null,
    };
  }
  return {
    disclosure: DISCLOSURE_TEXT,
    actions: actionsFor(response),
    platforms: response.platforms.map((status) => platformView(status, formatTime)),
    nextSyncText:
      response.nextSyncAt === null ? null : `Next sync ${formatTime(response.nextSyncAt)}`,
    errorText: null,
    pairingText: response.pairing ? PAIRING_TEXT : null,
    pairFailureText: pairFailureText(response),
    pauseSkipText: pauseSkipText(response, formatTime),
  };
}

function reasonOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { ok?: unknown; reason?: unknown };
  if (candidate.ok !== false || typeof candidate.reason !== "string") return undefined;
  return candidate.reason;
}

function isKeyOf<T extends object>(record: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// Message for an action's reply, or null on success. Covers every failure the
// action replies can carry: PairResult reasons, UNPAIR's busy, and ControlError.
export function actionErrorText(response: unknown): string | null {
  if (response === undefined) return NO_ACTION_RESPONSE_TEXT;
  if (typeof response === "object" && response !== null && (response as { ok?: unknown }).ok) {
    return null;
  }
  const reason = reasonOf(response);
  if (reason === undefined) return CONTROL_ERROR_TEXT.internal;
  if (reason === "busy") return BUSY_TEXT;
  if (isKeyOf(PAIR_FAILURE_TEXT, reason)) return PAIR_FAILURE_TEXT[reason];
  if (isKeyOf(CONTROL_ERROR_TEXT, reason)) return CONTROL_ERROR_TEXT[reason];
  return CONTROL_ERROR_TEXT.internal;
}

// ---- Live status polling -------------------------------------------------

export const POLL_INTERVAL_MS = 1_000;
// A run can start and finish between two polls; a burst opened by a click keeps
// polling this long even when every snapshot reads idle.
export const MIN_BURST_MS = 5_000;
export const MAX_BURST_MS = 60_000;

export interface PollBurst {
  readonly startedAt: number;
  readonly minMs: number;
}

export function isLive(response: unknown): boolean {
  if (!isStatusSnapshot(response)) return false;
  return response.pairing || response.platforms.some((status) => status.status === "syncing");
}

export function shouldKeepPolling(response: unknown, burst: PollBurst, now: number): boolean {
  if (!isStatusSnapshot(response)) return false;
  const elapsed = now - burst.startedAt;
  if (elapsed >= MAX_BURST_MS) return false;
  return elapsed < burst.minMs || isLive(response);
}

// ---- UI-only state that must survive a poll re-render -------------------------

export type FinishedAction = ActionType | "SET_PLATFORM_ENABLED";

export interface UiState {
  readonly confirmingDisconnect: boolean;
  readonly notice: string | null;
  readonly actionError: string | null;
  readonly pendingAction: ActionType | null;
}

export type UiEvent =
  | { readonly type: "action_started"; readonly action: ActionType }
  | {
      readonly type: "action_finished";
      readonly action: FinishedAction;
      readonly response: unknown;
    }
  | { readonly type: "disconnect_asked" }
  | { readonly type: "disconnect_cancelled" }
  | { readonly type: "burst_ended" }
  | { readonly type: "status_received"; readonly response: unknown };

export const INITIAL_UI_STATE: UiState = {
  confirmingDisconnect: false,
  notice: null,
  actionError: null,
  pendingAction: null,
};

export const SYNC_STARTED_TEXT = "Sync started.";

function finishAction(state: UiState, action: FinishedAction, response: unknown): UiState {
  const actionError = actionErrorText(response);
  return {
    confirmingDisconnect: false,
    notice: action === "SYNC_START" && actionError === null ? SYNC_STARTED_TEXT : state.notice,
    actionError,
    pendingAction: state.pendingAction === action ? null : state.pendingAction,
  };
}

export function reduceUi(state: UiState, event: UiEvent): UiState {
  switch (event.type) {
    case "action_started":
      return {
        ...INITIAL_UI_STATE,
        // The confirm button stays on screen (disabled) while UNPAIR is in flight.
        confirmingDisconnect: event.action === "UNPAIR" && state.confirmingDisconnect,
        pendingAction: event.action,
      };
    case "action_finished":
      return finishAction(state, event.action, event.response);
    case "disconnect_asked":
      return { ...state, confirmingDisconnect: true, actionError: null };
    case "disconnect_cancelled":
      return { ...state, confirmingDisconnect: false };
    case "burst_ended":
      return { ...state, notice: null };
    case "status_received": {
      const canDisconnect = isStatusSnapshot(event.response) && event.response.auth !== "none";
      return canDisconnect ? state : { ...state, confirmingDisconnect: false };
    }
  }
}

// One persistent live region carries every message; the click the popup itself
// made outranks what the background reports.
export function messageText(view: PopupView, ui: UiState): string {
  return (
    ui.actionError ?? view.errorText ?? view.pairingText ?? view.pairFailureText ?? ui.notice ?? ""
  );
}

// ---- Buttons, keyed so focus can follow a re-render -----------------------

export type ControlKey =
  | "PAIR_START"
  | "SYNC_START"
  | "UNPAIR_ASK"
  | "UNPAIR_CONFIRM"
  | "UNPAIR_CANCEL";

export interface ControlButton {
  readonly key: ControlKey;
  readonly label: string;
  readonly disabled: boolean;
}

export interface ControlsView {
  readonly primary: readonly ControlButton[];
  readonly disconnect: readonly ControlButton[];
  readonly confirmText: string | null;
}

export const DISCONNECT_CONFIRM_TEXT = "Disconnect? The next pairing re-imports from scratch.";

function disconnectButtons(ui: UiState): readonly ControlButton[] {
  if (!ui.confirmingDisconnect) {
    return [{ key: "UNPAIR_ASK", label: "Disconnect", disabled: false }];
  }
  return [
    { key: "UNPAIR_CONFIRM", label: "Disconnect", disabled: ui.pendingAction === "UNPAIR" },
    { key: "UNPAIR_CANCEL", label: "Cancel", disabled: false },
  ];
}

export function controlsView(view: PopupView, ui: UiState): ControlsView {
  const primary = view.actions
    .filter((action) => action.type !== "UNPAIR")
    .map((action) => ({
      key: action.type as ControlKey,
      label: action.label,
      disabled: action.disabled || ui.pendingAction === action.type,
    }));
  const canDisconnect = view.actions.some((action) => action.type === "UNPAIR");
  return {
    primary,
    disconnect: canDisconnect ? disconnectButtons(ui) : [],
    confirmText: canDisconnect && ui.confirmingDisconnect ? DISCONNECT_CONFIRM_TEXT : null,
  };
}

export function platformKey(platform: Platform): string {
  return `platform:${platform}`;
}

// Where focus goes when the focused control is replaced by a different one.
const FOCUS_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  UNPAIR_ASK: ["UNPAIR_CANCEL"],
  UNPAIR_CANCEL: ["UNPAIR_ASK"],
  UNPAIR_CONFIRM: ["PAIR_START", "UNPAIR_ASK"],
};

export function focusKeyAfterRender(
  previous: string | null,
  available: readonly string[],
): string | null {
  if (previous === null) return null;
  if (available.includes(previous)) return previous;
  const fallbacks = FOCUS_FALLBACKS[previous] ?? [];
  return fallbacks.find((key) => available.includes(key)) ?? null;
}
