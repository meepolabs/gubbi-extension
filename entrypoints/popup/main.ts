import { logger } from "../../src/lib/logger";
import type { ControlMessage, ControlResponse } from "../../src/lib/messages";
import type { Platform } from "../../src/lib/schema/ingest";
import {
  controlsView,
  defaultFormatTime,
  DISCLOSURE_TEXT,
  focusKeyAfterRender,
  INITIAL_UI_STATE,
  isLive,
  messageText,
  MIN_BURST_MS,
  nextPollDelay,
  platformKey,
  POLL_INTERVAL_MS,
  reduceUi,
  syncBlockedText,
  toPopupView,
  type ActionType,
  type ControlButton,
  type ControlKey,
  type PlatformView,
  type PollBurst,
  type UiEvent,
  type UiState,
} from "./view-model";

// Renders the view model with createElement + textContent only. Status is
// polled rather than watched through storage change events, which would hand
// stored credentials to this page.

let ui: UiState = INITIAL_UI_STATE;
let lastResponse: unknown;
let burst: PollBurst | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let focusedKey: string | null = null;
let lastSignature = "";
let requestedSeq = 0;
let appliedSeq = 0;
let rendering = false;

interface Mounts {
  readonly app: HTMLElement;
  readonly actions: HTMLElement;
  readonly status: HTMLElement;
  readonly details: HTMLElement;
}

// Resolves undefined when the background never answers (no listener, or the
// popup closed first); the view model treats that as a failure.
async function send<T extends ControlMessage>(
  message: T,
): Promise<ControlResponse<T["type"]> | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as ControlResponse<T["type"]> | undefined;
  } catch (error: unknown) {
    logger.warn("control message failed", {
      type: message.type,
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}

function logFailure(promise: Promise<void>): void {
  promise.catch((error: unknown) => {
    logger.error("popup update failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  });
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function dispatch(event: UiEvent): void {
  ui = reduceUi(ui, event);
}

// Replies can land out of order; one older than an already applied reply is
// dropped so it cannot overwrite newer status.
async function refresh(): Promise<void> {
  const seq = ++requestedSeq;
  const response = await send({ type: "STATUS_REQUEST" });
  if (seq < appliedSeq) return;
  appliedSeq = seq;
  lastResponse = response;
  dispatch({ type: "status_received", response });
  render();
}

function schedulePoll(delayMs: number): void {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => logFailure(pollTick()), delayMs);
}

async function pollTick(): Promise<void> {
  const mine = burst;
  await refresh();
  // A burst started while this tick awaited owns the schedule now.
  if (mine === null || burst !== mine) return;
  const delay = nextPollDelay(lastResponse, mine, Date.now());
  if (delay !== null) {
    schedulePoll(delay);
    return;
  }
  burst = null;
  dispatch({ type: "burst_ended" });
  render();
}

function startBurst(minMs: number): void {
  burst = { startedAt: Date.now(), minMs };
  schedulePoll(POLL_INTERVAL_MS);
}

async function runAction(type: ActionType): Promise<void> {
  const blocked = type === "SYNC_START" ? syncBlockedText(lastResponse) : null;
  if (blocked !== null) {
    dispatch({ type: "sync_blocked", text: blocked });
    render();
    return;
  }
  dispatch({ type: "action_started", action: type });
  render();
  // PAIR_START answers only when the whole sign-in flow ends, so the burst
  // starts before the reply.
  if (type === "PAIR_START") startBurst(MIN_BURST_MS);
  const response = await send({ type });
  dispatch({ type: "action_finished", action: type, response });
  await refresh();
  if (type === "SYNC_START" && ui.notice !== null) startBurst(MIN_BURST_MS);
}

async function togglePlatform(platform: Platform, enabled: boolean): Promise<void> {
  const response = await send({ type: "SET_PLATFORM_ENABLED", platform, enabled });
  dispatch({ type: "action_finished", action: "SET_PLATFORM_ENABLED", response });
  // The click already flipped the box; re-render even when the status did not
  // change, so a refused toggle snaps back.
  lastSignature = "";
  await refresh();
}

const BUTTON_HANDLERS: Record<ControlKey, () => void> = {
  PAIR_START: () => logFailure(runAction("PAIR_START")),
  SYNC_START: () => logFailure(runAction("SYNC_START")),
  UNPAIR_CONFIRM: () => logFailure(runAction("UNPAIR")),
  UNPAIR_ASK: () => {
    dispatch({ type: "disconnect_asked" });
    render();
  },
  UNPAIR_CANCEL: () => {
    dispatch({ type: "disconnect_cancelled" });
    render();
  },
};

// An in-flight button is aria-disabled rather than disabled so it keeps focus
// across the re-render; its clicks are ignored instead.
function button(control: ControlButton): HTMLButtonElement {
  const node = element("button", control.label);
  node.type = "button";
  node.dataset["key"] = control.key;
  if (control.disabled) {
    node.setAttribute("aria-disabled", "true");
  } else {
    node.addEventListener("click", BUTTON_HANDLERS[control.key]);
  }
  return node;
}

function platformRow(view: PlatformView): HTMLElement {
  const row = element("section");
  const label = element("label");
  const checkbox = element("input");
  checkbox.type = "checkbox";
  checkbox.defaultChecked = view.enabled;
  checkbox.checked = view.enabled;
  checkbox.dataset["key"] = platformKey(view.platform);
  checkbox.addEventListener("change", () => {
    logFailure(togglePlatform(view.platform, checkbox.checked));
  });
  const name = element("span", view.label);
  name.style.marginInlineStart = "0.25em";
  label.append(checkbox, name);
  row.append(label, element("p", view.statusText));
  if (view.pauseText !== null) row.append(element("p", view.pauseText));
  row.append(element("p", view.lastRunText));
  return row;
}

interface Built {
  readonly status: string;
  readonly actions: HTMLElement[];
  readonly details: HTMLElement[];
}

function buildView(): Built {
  const view = toPopupView(lastResponse, defaultFormatTime);
  const controls = controlsView(view, ui);
  const details: HTMLElement[] = [];
  if (controls.disconnect.length > 0) {
    const block = element("div");
    block.style.marginTop = "1em";
    if (controls.confirmText !== null) block.append(element("p", controls.confirmText));
    block.append(...controls.disconnect.map(button));
    details.push(block);
  }
  details.push(...view.platforms.map(platformRow));
  if (view.nextSyncText !== null) details.push(element("p", view.nextSyncText));
  return { status: messageText(view, ui), actions: controls.primary.map(button), details };
}

function restoreFocus(root: HTMLElement, previous: string | null): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body && !root.contains(active)) return;
  const keyed = [...root.querySelectorAll<HTMLElement>("[data-key]")];
  const target = focusKeyAfterRender(
    previous,
    keyed.map((node) => node.dataset["key"] ?? ""),
  );
  keyed.find((node) => node.dataset["key"] === target)?.focus();
}

function signatureOf(nodes: readonly HTMLElement[]): string {
  return nodes.map((node) => node.outerHTML).join("");
}

// The status region is mounted once and only its text changes, so assistive
// tech announces the update instead of seeing a freshly inserted region.
function render(): void {
  if (mounts === null) return;
  const built = buildView();
  if (mounts.status.textContent !== built.status) mounts.status.textContent = built.status;
  // A poll that changes nothing must not rebuild the DOM: that would drop
  // focus and swallow a click whose mousedown landed on the old node.
  const signature = `${signatureOf(built.actions)}|${signatureOf(built.details)}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  const { app } = mounts;
  const active = document.activeElement;
  const previous =
    active instanceof HTMLElement && app.contains(active)
      ? (active.dataset["key"] ?? null)
      : focusedKey;
  rendering = true;
  try {
    mounts.actions.replaceChildren(...built.actions);
    mounts.details.replaceChildren(...built.details);
  } finally {
    rendering = false;
  }
  restoreFocus(app, previous);
}

function trackFocus(root: HTMLElement): void {
  root.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement) focusedKey = event.target.dataset["key"] ?? null;
  });
  // Focus leaving a control outside a render means the user moved it away;
  // forget it. A render replacing the control keeps the key for restoreFocus.
  root.addEventListener("focusout", (event) => {
    if (rendering || event.relatedTarget !== null) return;
    if (event.target instanceof HTMLElement && event.target.isConnected) focusedKey = null;
  });
}

function findMounts(): Mounts | null {
  const app = document.getElementById("app");
  const actions = document.getElementById("actions");
  const status = document.getElementById("status");
  const details = document.getElementById("details");
  if (app === null || actions === null || status === null || details === null) return null;
  return { app, actions, status, details };
}

async function start(found: Mounts): Promise<void> {
  document.getElementById("disclosure")?.replaceChildren(DISCLOSURE_TEXT);
  trackFocus(found.app);
  await refresh();
  if (isLive(lastResponse)) startBurst(0);
}

const mounts = findMounts();
if (mounts !== null) logFailure(start(mounts));
