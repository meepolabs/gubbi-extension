import { defineBackground } from "wxt/utils/define-background";

import { pair, runStartupRecovery, unpair } from "../src/lib/auth";
import type { AdapterPlatform } from "../src/lib/connectors/base";
import { handleControlMessage, type ControlDeps } from "../src/lib/control/handlers";
import { logger } from "../src/lib/logger";
import { isControlMessageType } from "../src/lib/messages";
import { runSync } from "../src/lib/sync/orchestrator";

// Background entrypoint. Thin wiring layer: it creates the periodic sync alarm,
// runs startup recovery, routes alarms into the sync orchestrator and control
// messages (declared in src/lib/messages.ts) into src/lib/control/handlers.ts.
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

// Memoized once-per-worker-lifetime startup recovery. An MV3 worker can be torn
// down mid-refresh and later woken by an alarm or a SYNC_START in the SAME
// browser session -- a wake that never fires chrome.runtime.onStartup. If that
// wake reached refresh code without recovering first, it could replay an
// already-rotated refresh token and trip Hydra's reuse detection (whole-chain
// revocation -> silent logout). So recovery is gated into the sync trigger path,
// not just onStartup. The SW script re-executes on every cold start, so this
// module-level memo resets per worker -- a successful recovery runs exactly once
// per lifetime, before any sync/auth work, regardless of which event woke the
// worker. A rejected recovery clears the memo so the next trigger retries it;
// otherwise one failure would block pairing and sync until the worker restarts.
let recoveryPromise: Promise<void> | undefined;

function ensureRecovered(): Promise<void> {
  return (recoveryPromise ??= runStartupRecovery().catch((error: unknown) => {
    recoveryPromise = undefined;
    throw error;
  }));
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

function controlDeps(): ControlDeps {
  return {
    runtimeId: chrome.runtime.id,
    ensureRecovered,
    startSync: (platform) => void triggerSync(platform),
    pair,
    unpair,
    syncAlarmNames: [SYNC_ALARM_NAME, SYNC_CONTINUATION_ALARM_NAME],
    now: () => Date.now(),
  };
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

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Content-script results (LIST_RESULT, ...) travel as tabs.sendMessage
      // replies, not through this listener; only control messages are handled.
      if (!isControlMessageType(message)) return false;
      // handleControlMessage never rejects; returning true keeps the channel
      // open until its single response is sent.
      void handleControlMessage(message, sender, controlDeps()).then(sendResponse);
      return true;
    });
  },
});
