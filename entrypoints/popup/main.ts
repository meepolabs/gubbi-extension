import { logger } from "../../src/lib/logger";
import type { ControlMessage, ControlResponse } from "../../src/lib/messages";
import type { Platform } from "../../src/lib/schema/ingest";
import {
  controlsView,
  defaultFormatTime,
  focusKeyAfterRender,
  INITIAL_UI_STATE,
  isLive,
  messageText,
  MIN_BURST_MS,
  platformKey,
  POLL_INTERVAL_MS,
  reduceUi,
  shouldKeepPolling,
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

async function refresh(): Promise<void> {
  lastResponse = await send({ type: "STATUS_REQUEST" });
  dispatch({ type: "status_received", response: lastResponse });
  render();
}

function schedulePoll(): void {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => logFailure(pollTick()), POLL_INTERVAL_MS);
}

async function pollTick(): Promise<void> {
  await refresh();
  if (burst !== null && shouldKeepPolling(lastResponse, burst, Date.now())) {
    schedulePoll();
    return;
  }
  burst = null;
  dispatch({ type: "burst_ended" });
  render();
}

function startBurst(minMs: number): void {
  burst = { startedAt: Date.now(), minMs };
  schedulePoll();
}

async function runAction(type: ActionType): Promise<void> {
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

function button(control: ControlButton): HTMLButtonElement {
  const node = element("button", control.label);
  node.type = "button";
  node.disabled = control.disabled;
  node.dataset["key"] = control.key;
  node.addEventListener("click", BUTTON_HANDLERS[control.key]);
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

function buildChildren(): HTMLElement[] {
  const view = toPopupView(lastResponse, defaultFormatTime);
  const controls = controlsView(view, ui);
  const primary = element("div");
  primary.append(...controls.primary.map(button));
  const status = element("p", messageText(view, ui));
  status.setAttribute("role", "status");
  const children: HTMLElement[] = [element("p", view.disclosure), primary, status];
  if (view.pauseSkipText !== null) children.push(element("p", view.pauseSkipText));
  if (controls.disconnect.length > 0) {
    const block = element("div");
    block.style.marginTop = "1em";
    if (controls.confirmText !== null) block.append(element("p", controls.confirmText));
    block.append(...controls.disconnect.map(button));
    children.push(block);
  }
  children.push(...view.platforms.map(platformRow));
  if (view.nextSyncText !== null) children.push(element("p", view.nextSyncText));
  return children;
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

function render(): void {
  const root = document.getElementById("app");
  if (root === null) return;
  const children = buildChildren();
  // A poll that changes nothing must not rebuild the DOM: that would drop
  // focus and swallow a click whose mousedown landed on the old node.
  const signature = children.map((child) => child.outerHTML).join("");
  if (signature === lastSignature) return;
  lastSignature = signature;
  const active = document.activeElement;
  const previous =
    active instanceof HTMLElement && root.contains(active)
      ? (active.dataset["key"] ?? null)
      : focusedKey;
  root.replaceChildren(...children);
  restoreFocus(root, previous);
}

function trackFocus(root: HTMLElement): void {
  root.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement) focusedKey = event.target.dataset["key"] ?? null;
  });
  // A control that is still on screen and enabled lost focus because the user
  // moved it away; forget it. Disabling or replacing a control keeps the key.
  root.addEventListener("focusout", (event) => {
    const target = event.target;
    if (event.relatedTarget !== null || !(target instanceof HTMLElement)) return;
    if (target.isConnected && !(target as HTMLButtonElement).disabled) focusedKey = null;
  });
}

async function start(root: HTMLElement): Promise<void> {
  trackFocus(root);
  await refresh();
  if (isLive(lastResponse)) startBurst(0);
}

const root = document.getElementById("app");
if (root !== null) logFailure(start(root));
