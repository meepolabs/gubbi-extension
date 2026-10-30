import type { AuthState, PlatformStatus, StatusSnapshot } from "../messages";
import { PlatformSchema, type Platform } from "../schema/ingest";
import {
  getAuthBlob,
  getPauseState,
  getPlatformEnabled,
  getPlatformLastRunAt,
  getStatus,
} from "../storage";
import { logger } from "../logger";

// Builds the STATUS_REQUEST answer from persisted state only, field by field, so
// nothing beyond the enumerated StatusSnapshot fields can leak into it.
//
// Background-only.

async function readPlatformStatus(platform: Platform, nowMs: number): Promise<PlatformStatus> {
  const [enabled, status, pause, lastRunAt] = await Promise.all([
    getPlatformEnabled(platform),
    getStatus(platform),
    getPauseState(platform),
    getPlatformLastRunAt(platform),
  ]);
  const activePause =
    pause !== undefined && Date.parse(pause.pausedUntil) > nowMs ? pause : undefined;
  return {
    platform,
    enabled,
    status,
    pausedUntil: activePause?.pausedUntil ?? null,
    pauseReason: activePause?.reason ?? null,
    lastRunAt: lastRunAt ?? null,
  };
}

async function readAuthState(platforms: readonly PlatformStatus[]): Promise<AuthState> {
  const blob = await getAuthBlob();
  if (blob === undefined) return "none";
  if (blob.status === "reconnect_required") return "reconnect_required";
  if (platforms.some((entry) => entry.status === "reconnect_required")) {
    return "reconnect_required";
  }
  return "ok";
}

// Earliest scheduled wake among the named alarms. An alarms failure degrades to
// null so the rest of the snapshot still renders.
async function readNextSyncAt(alarmNames: readonly string[]): Promise<string | null> {
  try {
    const alarms = await Promise.all(alarmNames.map((name) => chrome.alarms.get(name)));
    const times = alarms
      .map((alarm) => alarm?.scheduledTime)
      .filter((time): time is number => typeof time === "number" && Number.isFinite(time));
    if (times.length === 0) return null;
    return new Date(Math.min(...times)).toISOString();
  } catch (error) {
    logger.warn("alarm read failed", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

export async function readStatusSnapshot(
  alarmNames: readonly string[],
  nowMs: number,
): Promise<StatusSnapshot> {
  const platforms = await Promise.all(
    PlatformSchema.options.map((platform) => readPlatformStatus(platform, nowMs)),
  );
  const [auth, nextSyncAt] = await Promise.all([
    readAuthState(platforms),
    readNextSyncAt(alarmNames),
  ]);
  return { ok: true, auth, platforms, nextSyncAt };
}
