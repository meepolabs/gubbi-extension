import { logger } from "../../src/lib/logger";
import type { ControlMessage, ControlResponse } from "../../src/lib/messages";
import type { Platform } from "../../src/lib/schema/ingest";
import {
  actionErrorText,
  defaultFormatTime,
  toPopupView,
  type ActionType,
  type PlatformView,
  type PopupView,
} from "./view-model";

// Renders the view model with createElement + textContent only.

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

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function refresh(root: HTMLElement, actionError: string | null = null): Promise<void> {
  const view = toPopupView(await send({ type: "STATUS_REQUEST" }), defaultFormatTime);
  render(root, view, actionError);
}

async function runAction(root: HTMLElement, type: ActionType): Promise<void> {
  const response = await send({ type });
  await refresh(root, actionErrorText(response));
}

async function togglePlatform(
  root: HTMLElement,
  platform: Platform,
  enabled: boolean,
): Promise<void> {
  const response = await send({ type: "SET_PLATFORM_ENABLED", platform, enabled });
  await refresh(root, actionErrorText(response));
}

function platformRow(root: HTMLElement, view: PlatformView): HTMLElement {
  const row = element("section");
  const label = element("label");
  const checkbox = element("input");
  checkbox.type = "checkbox";
  checkbox.checked = view.enabled;
  checkbox.addEventListener("change", () => {
    void togglePlatform(root, view.platform, checkbox.checked);
  });
  label.append(checkbox, ` ${view.label}`);
  row.append(label, element("p", view.statusText));
  if (view.pauseText !== null) row.append(element("p", view.pauseText));
  row.append(element("p", view.lastRunText));
  return row;
}

function render(root: HTMLElement, view: PopupView, actionError: string | null): void {
  const children: HTMLElement[] = [element("p", view.disclosure)];
  for (const action of view.actions) {
    const button = element("button", action.label);
    button.type = "button";
    button.addEventListener("click", () => {
      button.disabled = true;
      void runAction(root, action.type);
    });
    children.push(button);
  }
  for (const platform of view.platforms) children.push(platformRow(root, platform));
  if (view.nextSyncText !== null) children.push(element("p", view.nextSyncText));
  const errorText = actionError ?? view.errorText;
  if (errorText !== null) children.push(element("p", errorText));
  root.replaceChildren(...children);
}

const root = document.getElementById("app");
if (root !== null) {
  refresh(root).catch((error: unknown) => {
    logger.error("popup render failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  });
}
