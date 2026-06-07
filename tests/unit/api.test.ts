import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IngestConversationRequest, IngestConversationResponse } from "../../src/lib/schema/ingest";
import type { TokenProvider } from "../../src/lib/token-provider";

// guardedFetch is the single egress chokepoint; the api client calls it for all
// network IO. We mock the module so each test drives one HTTP outcome without
// touching the network or the host allowlist.
const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
vi.mock("../../src/lib/net/fetch", () => ({
  guardedFetch: (input: string | URL, init?: RequestInit) => fetchMock(input, init),
}));

import { uploadConversations, INGEST_PATH } from "../../src/lib/api";

const TOKEN = "ory_at_test-access-token";

function fakeProvider(overrides?: Partial<TokenProvider>): TokenProvider {
  return {
    getAccessToken: vi.fn(async () => TOKEN),
    forceRefresh: vi.fn(async () => TOKEN),
    ...overrides,
  };
}

function requestWith(count: number): IngestConversationRequest {
  const conversations = Array.from({ length: count }, (_, i) => ({
    platform: "chatgpt" as const,
    platform_id: `p${i}`,
    title: "",
    created_at: "2026-01-01T00:00:00Z",
    messages: [{ role: "user" as const, content: "hi" }],
  }));
  return { source: "extension_chatgpt", conversations };
}

const okBody: IngestConversationResponse = {
  conversations_saved: 3,
  conversations_skipped_dedupe: 1,
  extractions_enqueued: 2,
  extractions_skipped_budget: 0,
  extractions_skipped_error: 0,
  budget_exhausted: false,
};

function jsonResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

describe("uploadConversations", () => {
  it("returns ok with the full validated body on 200", async () => {
    // Arrange
    fetchMock.mockResolvedValue(jsonResponse(okBody, { status: 200 }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "ok", response: okBody });
  });

  it("treats budget_exhausted=true as ok, not an error", async () => {
    // Arrange
    const body: IngestConversationResponse = { ...okBody, budget_exhausted: true };
    fetchMock.mockResolvedValue(jsonResponse(body, { status: 200 }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "ok", response: body });
  });

  it("returns malformed_response when a 200 body fails schema validation", async () => {
    // Arrange
    fetchMock.mockResolvedValue(jsonResponse({ conversations_saved: "nope" }, { status: 200 }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "malformed_response" });
  });

  it("returns malformed_response when a 200 body is not valid JSON", async () => {
    // Arrange
    fetchMock.mockResolvedValue(
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "malformed_response" });
  });

  it("maps 401 to needs_refresh", async () => {
    // Arrange
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "needs_refresh" });
  });

  it("maps 403 to insufficient_scope", async () => {
    // Arrange
    fetchMock.mockResolvedValue(new Response("", { status: 403 }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "insufficient_scope" });
  });

  it("parses a delta-seconds Retry-After on 429", async () => {
    // Arrange
    fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "120" } }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "rate_limited", retryAfterSeconds: 120 });
  });

  it("parses an HTTP-date Retry-After on 429", async () => {
    // Arrange
    // Pin to a whole-second epoch so toUTCString() round-trips without losing
    // sub-second precision (otherwise the delta floors to 29).
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const future = new Date(now + 30_000).toUTCString();
    fetchMock.mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": future } }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome.status).toBe("rate_limited");
    if (outcome.status === "rate_limited") {
      expect(outcome.retryAfterSeconds).toBe(30);
    }
  });

  it("yields null retryAfterSeconds on 429 with no Retry-After header", async () => {
    // Arrange
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "rate_limited", retryAfterSeconds: null });
  });

  it("yields null retryAfterSeconds on 429 with an unparseable Retry-After", async () => {
    // Arrange
    fetchMock.mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "soon-ish" } }),
    );

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "rate_limited", retryAfterSeconds: null });
  });

  it("maps a 5xx to transient_http with the status", async () => {
    // Arrange
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "transient_http", httpStatus: 503 });
  });

  it("maps a thrown fetch to network", async () => {
    // Arrange
    fetchMock.mockRejectedValue(new Error("Failed to fetch"));

    // Act
    const outcome = await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    expect(outcome).toEqual({ status: "network" });
  });

  it("returns oversize_batch without calling the network for >50 conversations", async () => {
    // Arrange
    const provider = fakeProvider();

    // Act
    const outcome = await uploadConversations(requestWith(51), provider);

    // Assert
    expect(outcome).toEqual({ status: "oversize_batch" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(provider.getAccessToken).not.toHaveBeenCalled();
  });

  it("sends the Bearer token from getAccessToken", async () => {
    // Arrange
    fetchMock.mockResolvedValue(jsonResponse(okBody, { status: 200 }));

    // Act
    await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    const init = fetchMock.mock.calls[0]![1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("POSTs to the ingest path through guardedFetch", async () => {
    // Arrange
    fetchMock.mockResolvedValue(jsonResponse(okBody, { status: 200 }));

    // Act
    await uploadConversations(requestWith(1), fakeProvider());

    // Assert
    const url = fetchMock.mock.calls[0]![0];
    const init = fetchMock.mock.calls[0]![1];
    expect(String(url)).toContain(INGEST_PATH);
    expect(init?.method).toBe("POST");
  });

  it("maps a getAccessToken rejection to auth_unavailable without calling the network", async () => {
    // Arrange
    const provider = fakeProvider({
      getAccessToken: vi.fn(async () => {
        throw new Error("session lost");
      }),
    });

    // Act
    const outcome = await uploadConversations(requestWith(1), provider);

    // Assert
    expect(outcome).toEqual({ status: "auth_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("api module boundary", () => {
  it("does not import from src/lib/auth/", () => {
    // Arrange
    const apiPath = fileURLToPath(new URL("../../src/lib/api.ts", import.meta.url));
    const source = readFileSync(apiPath, "utf8");

    // Assert -- the upload client is dependency-inverted via TokenProvider and
    // must never reach into the auth module.
    expect(source).not.toMatch(/from\s+["'][^"']*auth\//);
    expect(source).not.toMatch(/import\(\s*["'][^"']*auth\//);
  });
});
