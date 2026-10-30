import type { AuthState, PairFailureReason, PlatformStatus, StatusSnapshot } from "../messages";
import { PlatformSchema, type Platform } from "../schema/ingest";
import {
  getAuthBlob,
  getLastPairFailure,
  getPauseState,
  getPlatformEnabled,
  getPlatformLastRunAt,
  getStatus,
} from "../storage";
import { logger } from "../logger";

// Builds the STATUS_REQUEST answer from persisted state plus the caller's inputs,
// field by field, so nothing beyond the enumerated StatusSnapshot fields can
// leak into it.
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
    // The orchestrator only rewrites status on its next run, so a pause that has
    // ended still reads "paused" until then; without its window it is idle.
    status: status === "paused" && activePause === undefined ? "idle" : status,
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

// A failure stored by an earlier attempt is stale once a new one is running, even
// before that attempt's clear has landed.
async function readPairFailure(pairing: boolean): Promise<PairFailureReason | null> {
  if (pairing) return null;
  const failure = await getLastPairFailure();
  return failure?.reason ?? null;
}

export async function readStatusSnapshot(
  alarmNames: readonly string[],
  nowMs: number,
  pairing: boolean,
): Promise<StatusSnapshot> {
  const platforms = await Promise.all(
    PlatformSchema.options.map((platform) => readPlatformStatus(platform, nowMs)),
  );
  const [auth, pairFailure] = await Promise.all([
    readAuthState(platforms),
    readPairFailure(pairing),
  ]);
  // The alarms outlive the credentials, but a sync without them skips at once.
  const nextSyncAt = auth === "none" ? null : await readNextSyncAt(alarmNames);
  return { ok: true, auth, platforms, nextSyncAt, pairing, pairFailure };
}
