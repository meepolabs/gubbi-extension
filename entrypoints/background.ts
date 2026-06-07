import { defineBackground } from "wxt/utils/define-background";

import { runStartupRecovery } from "../src/lib/auth";
import { logger } from "../src/lib/logger";
import {
  isExtensionMessage,
  type StatusResultMessage,
} from "../src/lib/messages";
import type { AdapterPlatform } from "../src/lib/connectors/base";
import { getSyncStatus, runSync } from "../src/lib/sync/orchestrator";

// Background entrypoint. Thin wiring layer: it creates the periodic sync alarm,
// runs startup recovery, and routes messages + alarms into the sync orchestrator.
// All real sync logic lives in src/lib/sync/orchestrator.ts.
//
// Firefox MV3 runs the background as a non-persistent event page, so every event
// listener MUST be registered synchronously at the top of main() before any
// await -- a listener attached after a suspension point is missed when the page
// is woken to handle that event. main() itself is not async for the same reason
// (WXT also forbids an async background main). Each async body is launched with
// `void` so no listener returns a floating promise.

const SYNC_ALARM_NAME = "sync";
const SYNC_CONTINUATION_ALARM_NAME = "sync-continuation";
const SYNC_PERIOD_MINUTES = 30;

const STATUS_PLATFORMS: readonly AdapterPlatform[] = ["chatgpt", "claude"];

// Memoized once-per-worker-lifetime startup recovery. An MV3 worker can be torn
// down mid-refresh and later woken by an alarm or a SYNC_START in the SAME
// browser session -- a wake that never fires chrome.runtime.onStartup. If that
// wake reached refresh code without recovering first, it could replay an
// already-rotated refresh token and trip Hydra's reuse detection (whole-chain
// revocation -> silent logout). So recovery is gated into the sync trigger path,
// not just onStartup. The SW script re-executes on every cold start, so this
// module-level memo resets per worker -- recovery runs exactly once per lifetime,
// before any sync/auth work, regardless of which event woke the worker.
let recoveryPromise: Promise<void> | undefined;

function ensureRecovered(): Promise<void> {
  return (recoveryPromise ??= runStartupRecovery());
}

function ensureSyncAlarm(): void {
  // chrome.alarms.create returns a Promise in MV3. A rejected create would
  // otherwise silently disable periodic sync, so the failure is logged.
  chrome.alarms
    .create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_PERIOD_MINUTES })
    .catch((e: unknown) => logger.error("failed to create sync alarm", { error: e }));
}

// Run one sync sweep, logging (never throwing) so an alarm/message handler never
// rejects. The orchestrator owns the single-flight lease, so overlapping wakes
// are safe -- a contended run short-circuits internally. Startup recovery is
// awaited FIRST so an interrupted refresh is reconciled before any refresh/upload
// can run on this worker -- this is the rotation-safety gate (see ensureRecovered).
async function triggerSync(platform?: AdapterPlatform): Promise<void> {
  try {
    await ensureRecovered();
    await runSync(platform === undefined ? {} : { platform });
  } catch (error) {
    logger.error("sync run failed", { error: String(error) });
  }
}

// Build the per-platform status snapshot answer for a STATUS_REQUEST ping.
async function collectStatus(): Promise<StatusResultMessage[]> {
  const results: StatusResultMessage[] = [];
  for (const platform of STATUS_PLATFORMS) {
    results.push({ type: "STATUS_RESULT", platform, state: await getSyncStatus(platform) });
  }
  return results;
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
      // Recover from an interrupted refresh before any sync can run. Routed
      // through the same per-worker memo as the sync trigger path so the two
      // never run recovery twice on one worker.
      void ensureRecovered().catch((error: unknown) =>
        logger.error("startup recovery failed", { error: String(error) }),
      );
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== SYNC_ALARM_NAME && alarm.name !== SYNC_CONTINUATION_ALARM_NAME) return;
      void triggerSync();
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isExtensionMessage(message)) return false;

      if (message.type === "SYNC_START") {
        void triggerSync(message.platform);
        sendResponse({ type: "SYNC_PROGRESS", platform: message.platform ?? "chatgpt", processed: 0, total: 0 });
        return false;
      }

      if (message.type === "STATUS_REQUEST") {
        // Async snapshot read: keep the channel open by returning true and
        // resolving sendResponse once the per-platform states are read.
        void collectStatus().then(
          (results) => sendResponse(results),
          (error: unknown) => {
            logger.error("status read failed", { error: String(error) });
            sendResponse([]);
          },
        );
        return true;
      }

      // Other message types have no background-side handler here.
      return false;
    });
  },
});
