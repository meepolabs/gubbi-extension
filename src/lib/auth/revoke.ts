import { logger } from "../logger";
import { guardedFetch } from "../net/fetch";
import { PlatformSchema } from "../schema/ingest";
import {
  getAuthBlob,
  clearAuthBlob,
  clearPendingAuthFlow,
  clearRefreshState,
  clearPauseState,
} from "../storage";
import { AUTH_ORIGIN, HYDRA_CLIENT_ID } from "./config";

// Unpair: tear down the local session and best-effort revoke the token server
// side.
//
// Background-only.

const REVOKE_PATH = "/oauth2/revoke";

// Best-effort POST /oauth2/revoke for the refresh token. Hydra revokes the
// whole consent chain on a refresh-token revoke. Network/HTTP failure is
// tolerated -- the local teardown below is what actually logs the user out, and
// a stranded server-side token expires on its own.
async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const url = new URL(REVOKE_PATH, AUTH_ORIGIN).toString();
  const body = new URLSearchParams({
    token: refreshToken,
    token_type_hint: "refresh_token",
    client_id: HYDRA_CLIENT_ID,
  });
  try {
    await guardedFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    // Tolerated: local teardown still proceeds.
    logger.warn("token revoke request failed (ignored)", {});
  }
}

// Disconnect the extension: revoke the refresh token (best effort) then clear
// ALL local auth state -- the auth blob, any pending pairing flow, the refresh
// marker, and every per-platform pause window. Always clears local state even if
// the revoke call fails.
export async function unpair(): Promise<void> {
  const blob = await getAuthBlob();
  if (blob) await revokeRefreshToken(blob.refreshToken);

  await clearAuthBlob();
  await clearPendingAuthFlow();
  await clearRefreshState();
  for (const platform of PlatformSchema.options) {
    await clearPauseState(platform);
  }
  logger.info("unpaired", {});
}
