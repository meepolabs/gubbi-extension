import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// refreshWithinLock is the rotation-safe primitive. These tests drive it
// directly (it expects to run inside a held lock; we just pass an ownerId) with
// the real storage layer over an in-memory chrome.storage stub, and mock only
// the network egress (guardedFetch). The storage stub RECORDS the order of
// writes so we can assert the rotation ordering contract.

vi.mock("../../src/lib/net/fetch", () => ({ guardedFetch: vi.fn() }));

import { guardedFetch } from "../../src/lib/net/fetch";
import { refreshWithinLock } from "../../src/lib/auth/refresh";
import { ReconnectRequiredError } from "../../src/lib/auth/errors";
import {
  getAuthBlob,
  getRefreshState,
  setAuthBlob,
  type AuthBlob,
} from "../../src/lib/storage";
import { stubChromeStorage } from "../helpers/chrome-stub";

const AUTH_BLOB_KEY = "gubbi:authBlob";
const REFRESH_STATE_KEY = "gubbi:refreshState";
const TOKEN_PATH = "/oauth2/token";

function okBlob(overrides: Partial<AuthBlob> = {}): AuthBlob {
  return {
    version: 3,
    accessToken: "at_old",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: "rt_old",
    status: "ok",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function rotatedTokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "at_new",
      refresh_token: "rt_new",
      expires_in: 3600,
      token_type: "bearer",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("refreshWithinLock (rotation ordering)", () => {
  it("writes refreshState BEFORE the token POST", async () => {
    // Arrange
    const stub = stubChromeStorage();
    await setAuthBlob(okBlob());
    const postOrder: string[] = [];
    vi.mocked(guardedFetch).mockImplementation(async () => {
      // Record where, in the storage write log, the POST landed.
      postOrder.push(`writes-before-post:${stub.writeLog.length}`);
      return rotatedTokenResponse();
    });

    // Act
    await refreshWithinLock("owner-1");

    // Assert: refreshState was written before the POST fired.
    const postFiredAtIndex = Number(postOrder[0]!.split(":")[1]);
    const refreshStateSetIndex = stub.writeLog.indexOf(`set:${REFRESH_STATE_KEY}`);
    expect(refreshStateSetIndex).toBeGreaterThanOrEqual(0);
    expect(refreshStateSetIndex).toBeLessThan(postFiredAtIndex);
  });

  it("captures authVersionBefore in refreshState before rotating", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob({ version: 7 }));
    let observedRefreshState: unknown;
    vi.mocked(guardedFetch).mockImplementation(async () => {
      observedRefreshState = await getRefreshState();
      return rotatedTokenResponse();
    });

    // Act
    await refreshWithinLock("owner-x");

    // Assert
    expect(observedRefreshState).toMatchObject({ ownerId: "owner-x", authVersionBefore: 7 });
  });

  it("persists the new blob (version+1, rotated refresh token) BEFORE clearing refreshState", async () => {
    // Arrange
    const stub = stubChromeStorage();
    await setAuthBlob(okBlob({ version: 3 }));
    vi.mocked(guardedFetch).mockResolvedValue(rotatedTokenResponse());

    // Act
    const token = await refreshWithinLock("owner-1");

    // Assert: returned the new access token and persisted the rotated blob.
    expect(token).toBe("at_new");
    const blob = await getAuthBlob();
    expect(blob).toMatchObject({ version: 4, accessToken: "at_new", refreshToken: "rt_new", status: "ok" });
    expect(await getRefreshState()).toBeUndefined();

    // Ordering: new authBlob set BEFORE refreshState removed.
    const lastBlobSet = stub.writeLog.lastIndexOf(`set:${AUTH_BLOB_KEY}`);
    const refreshStateRemoved = stub.writeLog.indexOf(`remove:${REFRESH_STATE_KEY}`);
    expect(lastBlobSet).toBeGreaterThanOrEqual(0);
    expect(refreshStateRemoved).toBeGreaterThan(lastBlobSet);
  });

  it("calls the token endpoint exactly once with grant_type=refresh_token", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockResolvedValue(rotatedTokenResponse());

    // Act
    await refreshWithinLock("owner-1");

    // Assert
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(guardedFetch).mock.calls[0]!;
    expect(new URL(input as string).pathname).toBe(TOKEN_PATH);
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_old");
    expect(body.get("client_id")).toBe("journal-extension");
  });
});

describe("refreshWithinLock (fail closed on post-POST ambiguity)", () => {
  it("maps an invalid_grant body to reconnect_required and never retries the token", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    // Act + Assert
    await expect(refreshWithinLock("owner-1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const blob = await getAuthBlob();
    expect(blob?.status).toBe("reconnect_required");
    expect(await getRefreshState()).toBeUndefined();
  });

  it("maps a 401 to reconnect_required", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockResolvedValue(new Response("unauthorized", { status: 401 }));

    // Act + Assert
    await expect(refreshWithinLock("owner-1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    const blob = await getAuthBlob();
    expect(blob?.status).toBe("reconnect_required");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a network throw: reconnect_required, old token never re-sent", async () => {
    // Arrange: the POST was attempted (token sent) but the connection dropped, so
    // the server MAY have rotated. The old token must never be reused.
    stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockRejectedValue(new Error("offline"));

    // Act + Assert
    await expect(refreshWithinLock("owner-1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect((await getAuthBlob())?.status).toBe("reconnect_required");
    expect(await getRefreshState()).toBeUndefined();
    // Exactly one token-endpoint call: the old refresh token is NEVER re-sent.
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a 5xx: reconnect_required, old token never re-sent", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockResolvedValue(new Response("oops", { status: 503 }));

    // Act + Assert
    await expect(refreshWithinLock("owner-1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect((await getAuthBlob())?.status).toBe("reconnect_required");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an unparseable 200 body: reconnect_required, old token never re-sent", async () => {
    // Arrange: a 2xx whose body is not valid JSON. The server likely rotated, so
    // we cannot reuse the old token.
    stubChromeStorage();
    await setAuthBlob(okBlob());
    vi.mocked(guardedFetch).mockResolvedValue(
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    // Act + Assert
    await expect(refreshWithinLock("owner-1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect((await getAuthBlob())?.status).toBe("reconnect_required");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-send the old token across a network throw then a follow-up call", async () => {
    // Arrange: a transient throw drives reconnect_required; a later refresh
    // attempt with the (now reconnect_required) blob must short-circuit BEFORE the
    // POST -- the old refresh token is never sent a second time.
    stubChromeStorage();
    await setAuthBlob(okBlob({ refreshToken: "rt_old" }));
    vi.mocked(guardedFetch).mockRejectedValueOnce(new Error("offline"));

    await expect(refreshWithinLock("owner-1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    // A second attempt sees status reconnect_required and never POSTs.
    await expect(refreshWithinLock("owner-2")).rejects.toBeInstanceOf(ReconnectRequiredError);

    // The token endpoint was hit exactly once (the first attempt); rt_old is
    // never resubmitted.
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects with ReconnectRequiredError when the blob is already reconnect_required", async () => {
    // Arrange
    stubChromeStorage();
    await setAuthBlob(okBlob({ status: "reconnect_required" }));

    // Act + Assert
    await expect(refreshWithinLock("owner-1")).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});
