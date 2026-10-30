import type { PairResult, UnpairResult } from "../auth";
import { logger } from "../logger";
import type { ControlError, ControlOk, ControlResponse } from "../messages";
import { PlatformSchema, type Platform } from "../schema/ingest";
import { getStatus, setPlatformEnabled, setStatus } from "../storage";
import { ControlMessageSchema, type ParsedControlMessage } from "./schemas";
import { isTrustedControlSender } from "./sender";
import { readStatusSnapshot } from "./status";

// Background-side handling of the control messages declared in messages.ts.
// Every response is built here from enumerated fields; a value returned by
// pair(), unpair() or storage is never forwarded as-is.
//
// Background-only.

export interface ControlDeps {
  readonly runtimeId: string;
  readonly ensureRecovered: () => Promise<void>;
  // Starts a sync sweep without waiting for it; must never reject.
  readonly startSync: (platform?: Platform) => void;
  readonly pair: () => Promise<PairResult>;
  readonly unpair: () => Promise<UnpairResult>;
  readonly syncAlarmNames: readonly string[];
  readonly now: () => number;
}

const OK: ControlOk = { ok: true };

function controlError(reason: ControlError["reason"]): ControlError {
  return { ok: false, reason };
}

// The worker lives across popup openings, so a double click on "Pair" would
// start a second auth window that overwrites the first flow's PKCE state. A
// concurrent PAIR_START joins the flow already running instead.
let pairInFlight: Promise<PairResult> | undefined;

async function resetReconnectStatuses(): Promise<void> {
  for (const platform of PlatformSchema.options) {
    if ((await getStatus(platform)) === "reconnect_required") await setStatus(platform, "idle");
  }
}

async function runPair(deps: ControlDeps): Promise<PairResult> {
  // Startup recovery must settle first: run after pairing, it would judge the
  // fresh version-1 credentials against a stale refresh marker and demand a
  // reconnect.
  await deps.ensureRecovered();
  const result = await deps.pair();
  if (!result.ok) return { ok: false, reason: result.reason };
  await resetReconnectStatuses();
  deps.startSync();
  return { ok: true };
}

function handlePair(deps: ControlDeps): Promise<PairResult> {
  pairInFlight ??= runPair(deps).finally(() => {
    pairInFlight = undefined;
  });
  return pairInFlight;
}

async function handleUnpair(deps: ControlDeps): Promise<UnpairResult> {
  const result = await deps.unpair();
  return result.ok ? { ok: true } : { ok: false, reason: "busy" };
}

async function dispatch(
  message: ParsedControlMessage,
  deps: ControlDeps,
): Promise<ControlResponse> {
  switch (message.type) {
    case "SYNC_START":
      deps.startSync(message.platform);
      return OK;
    case "STATUS_REQUEST":
      return readStatusSnapshot(deps.syncAlarmNames, deps.now());
    case "PAIR_START":
      return handlePair(deps);
    case "UNPAIR":
      return handleUnpair(deps);
    case "SET_PLATFORM_ENABLED":
      await setPlatformEnabled(message.platform, message.enabled);
      return OK;
  }
}

// Never rejects: a failure becomes { ok: false, reason: "internal" } and only the
// error's class name is logged, since a message could echo a token.
export async function handleControlMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender | undefined,
  deps: ControlDeps,
): Promise<ControlResponse> {
  if (!isTrustedControlSender(sender, deps.runtimeId)) {
    logger.warn("control message rejected", { reason: "forbidden_sender" });
    return controlError("forbidden_sender");
  }
  const parsed = ControlMessageSchema.safeParse(message);
  if (!parsed.success) {
    logger.warn("control message rejected", { reason: "invalid_payload" });
    return controlError("invalid_payload");
  }
  try {
    return await dispatch(parsed.data, deps);
  } catch (error) {
    logger.error("control message failed", {
      type: parsed.data.type,
      error: error instanceof Error ? error.name : "unknown",
    });
    return controlError("internal");
  }
}
