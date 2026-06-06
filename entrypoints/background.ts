import { defineBackground } from "wxt/utils/define-background";

import { logger } from "../src/lib/logger";
import { isExtensionMessage, type ExtensionMessage } from "../src/lib/messages";

// Background entrypoint. Thin orchestrator: registers the periodic sync alarm
// and a message router. The actual sync orchestration (lease acquisition,
// adapter driving, upload) lands in a later phase.
//
// Firefox MV3 runs the background as a non-persistent event page, so every
// event listener MUST be registered synchronously at the top of main() before
// any await -- a listener attached after a suspension point is missed when the
// page is woken to handle that event. main() itself is not async for the same
// reason (WXT also forbids an async background main).

const SYNC_ALARM_NAME = "sync";
const SYNC_PERIOD_MINUTES = 30;

function ensureSyncAlarm(): void {
  // chrome.alarms.create returns a Promise in MV3. A rejected create would
  // otherwise silently disable periodic sync, so the failure is logged.
  chrome.alarms
    .create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_PERIOD_MINUTES })
    .catch((e: unknown) => logger.error("failed to create sync alarm", { error: e }));
}

function routeMessage(message: ExtensionMessage): void {
  // TODO(phase-1b): dispatch SYNC_* / SCRAPE_RESULT to the sync orchestrator.
  logger.debug("message received (no-op router)", { type: message.type });
}

export default defineBackground({
  type: "module",
  main() {
    chrome.runtime.onInstalled.addListener(() => {
      ensureSyncAlarm();
      logger.info("extension installed", { alarm: SYNC_ALARM_NAME });
    });

    chrome.runtime.onStartup.addListener(() => {
      ensureSyncAlarm();
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== SYNC_ALARM_NAME) return;
      // TODO(phase-1b): acquire the single-flight lease and run the sync loop.
      logger.info("sync alarm fired (no-op)", { alarm: alarm.name });
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isExtensionMessage(message)) return false;
      routeMessage(message);
      sendResponse({ type: "SYNC_ERROR", message: "not implemented" });
      return false;
    });
  },
});
