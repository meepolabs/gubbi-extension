import { clearAccountState } from "../account-state";
import { logger } from "../logger";
import type { UnpairResult } from "../messages";
import { guardedFetch } from "../net/fetch";
import { getAccountGeneration, getAuthBlob, setAccountGeneration } from "../storage";
import { AUTH_ORIGIN, HYDRA_CLIENT_ID } from "./config";
import { withAccountLocksOrBusy } from "./transition";

// Unpair: tear down the local session and best-effort revoke the token server
// side.
//
// Runs under the sync lease and the auth lock (transition.ts). Holding the
// lease keeps a sync run from writing cursors or counters back after the sweep;
// holding the auth lock keeps a refresh from rotating the token mid-unpair.
//
// Background-only.

const REVOKE_PATH = "/oauth2/revoke";

// Hydra revokes the whole consent chain on a refresh-token revoke. Any failure
// is tolerated: the local teardown is what logs the user out, and a stranded
// server-side token expires on its own. The response body is never logged; it
// may echo the token.
async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const body = new URLSearchParams({
    token: refreshToken,
    token_type_hint: "refresh_token",
    client_id: HYDRA_CLIENT_ID,
  });
  try {
    const url = new URL(REVOKE_PATH, AUTH_ORIGIN).toString();
    const response = await guardedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      logger.warn("token revoke rejected (ignored)", { status: response.status });
    }
  } catch (error) {
    logger.warn("token revoke request failed (ignored)", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

async function revokeAndClear(): Promise<void> {
  const blob = await getAuthBlob();
  if (blob) await revokeRefreshToken(blob.refreshToken);
  await clearAccountState();
  await setAccountGeneration((await getAccountGeneration()) + 1);
  logger.info("unpaired", {});
}

// Disconnect the extension: revoke the refresh token (best effort) then clear
// the credentials and all account-scoped sync state. Local state is cleared
// even when the revoke fails; nothing is cleared when either lock stays busy.
export async function unpair(): Promise<UnpairResult> {
  const outcome = await withAccountLocksOrBusy(revokeAndClear);
  return outcome.kind === "ran" ? { ok: true } : { ok: false, reason: "busy" };
}
