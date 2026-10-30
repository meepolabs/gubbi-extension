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

const PAIR: ActionView = { type: "PAIR_START", label: "Pair" };
const RECONNECT: ActionView = { type: "PAIR_START", label: "Reconnect" };
const SYNC_NOW: ActionView = { type: "SYNC_START", label: "Sync now" };
const DISCONNECT: ActionView = { type: "UNPAIR", label: "Disconnect" };

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

function actionsFor(auth: StatusSnapshot["auth"]): readonly ActionView[] {
  switch (auth) {
    case "none":
      return [PAIR];
    case "ok":
      return [SYNC_NOW, DISCONNECT];
    case "reconnect_required":
      return [RECONNECT, DISCONNECT];
  }
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
      status.lastRunAt === null ? "Never run" : `Last run ${formatTime(status.lastRunAt)}`,
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
    };
  }
  return {
    disclosure: DISCLOSURE_TEXT,
    actions: actionsFor(response.auth),
    platforms: response.platforms.map((status) => platformView(status, formatTime)),
    nextSyncText:
      response.nextSyncAt === null ? null : `Next sync ${formatTime(response.nextSyncAt)}`,
    errorText: null,
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
