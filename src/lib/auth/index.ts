import { clearAccountState } from "../account-state";
import { logger } from "../logger";
import {
  getAccountGeneration,
  setAuthBlob,
  setPendingAuthFlow,
  clearPendingAuthFlow,
  type AuthBlob,
} from "../storage";
import { buildAuthorizeUrl } from "./authorize-url";
import { AUTH_ORIGIN } from "./config";
import { exchangeCode } from "./exchange";
import { getRedirectUri, launchWebAuthFlow } from "./launch";
import { generatePkce, generateState } from "./pkce";
import { withAccountLocksOrBusy } from "./transition";

// Public surface of the auth module: interactive pairing (`pair`), the
// refresh-safe token provider, revoke/unpair, and startup recovery.
//
// Background-only: imports storage (zod) and chrome.identity, neither of which
// is reachable from content scripts. No content entry may import this module.

export { generatePkce, challengeFromVerifier } from "./pkce";
export type { PkcePair } from "./pkce";

export { getAccessToken, forceRefresh, tokenProvider } from "./provider";
export { unpair } from "./revoke";
export type { UnpairResult } from "./revoke";
export { runStartupRecovery } from "./startup";
export { ReconnectRequiredError } from "./errors";

// Why each failure is distinct: state_mismatch is a security stop (possible
// CSRF / tampered redirect); user_cancelled is benign (closed the window or
// denied); exchange_failed is a rejected grant (e.g. expired code); network is
// any transport-level failure; superseded means a disconnect landed while the
// auth window was open, so the new credentials were discarded; busy means a
// sync or refresh held the locks too long to install them. The popup maps these
// to user-facing copy.
export type PairFailureReason =
  | "state_mismatch"
  | "user_cancelled"
  | "exchange_failed"
  | "network"
  | "superseded"
  | "busy";

export type PairResult = { ok: true } | { ok: false; reason: PairFailureReason };

function authBlobFrom(
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number,
): AuthBlob {
  const now = Date.now();
  return {
    version: 1,
    accessToken,
    accessTokenExpiresAt: new Date(now + expiresInSeconds * 1000).toISOString(),
    refreshToken,
    status: "ok",
    updatedAt: new Date(now).toISOString(),
  };
}

type InstallOutcome = "installed" | "superseded";

// Swap in the new account: drop every trace of the previous one (credentials,
// cursors, pauses, counters, refresh marker) and write the new credentials, all
// under the sync lease and auth lock so no sync run or refresh of the previous
// account can write over it. Refused when an unpair completed after this
// pairing started.
async function installCredentials(
  blob: AuthBlob,
  generationAtStart: number,
): Promise<InstallOutcome | "busy"> {
  const outcome = await withAccountLocksOrBusy(async (): Promise<InstallOutcome> => {
    if ((await getAccountGeneration()) !== generationAtStart) return "superseded";
    await clearAccountState();
    await setAuthBlob(blob);
    return "installed";
  });
  return outcome.kind === "ran" ? outcome.value : "busy";
}

// Orchestrates the interactive pairing flow:
//   1. generate PKCE + state, note the account generation
//   2. persist pendingAuthFlow BEFORE launching -- the auth code has a short TTL
//      (~10min) and the MV3 worker can be torn down mid-flow, so the verifier
//      must survive a restart to complete the exchange.
//   3. launch the interactive auth window (no locks held: it can stay open for
//      minutes)
//   4. verify the returned state matches (CSRF defense)
//   5. exchange the code for tokens, then install them under the locks
export async function pair(): Promise<PairResult> {
  if (AUTH_ORIGIN === undefined) {
    logger.warn("auth host not configured; pairing blocked", {});
    return { ok: false, reason: "network" };
  }
  const generationAtStart = await getAccountGeneration();
  const redirectUri = getRedirectUri();
  const { codeVerifier, codeChallenge } = await generatePkce();
  const state = generateState();

  await setPendingAuthFlow({
    state,
    codeVerifier,
    redirectUri,
    startedAt: new Date().toISOString(),
  });

  const authorizeUrl = buildAuthorizeUrl({ redirectUri, state, codeChallenge });
  const launch = await launchWebAuthFlow(authorizeUrl);

  if (launch.kind === "aborted" || launch.kind === "error") {
    logger.info("auth flow not completed", { kind: launch.kind });
    return { ok: false, reason: "user_cancelled" };
  }

  if (launch.state !== state) {
    logger.warn("auth state mismatch", {});
    return { ok: false, reason: "state_mismatch" };
  }

  const exchange = await exchangeCode({ code: launch.code, codeVerifier, redirectUri });
  if (!exchange.ok) {
    logger.warn("token exchange failed", { reason: exchange.reason });
    return { ok: false, reason: exchange.reason };
  }

  const { accessToken, refreshToken, expiresInSeconds } = exchange.token;
  const installed = await installCredentials(
    authBlobFrom(accessToken, refreshToken, expiresInSeconds),
    generationAtStart,
  );
  if (installed !== "installed") {
    logger.info("auth pairing not installed", { reason: installed });
    return { ok: false, reason: installed };
  }
  await clearPendingAuthFlow();
  logger.info("auth pairing complete", {});
  return { ok: true };
}
