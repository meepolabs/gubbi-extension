import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatGptFetcher } from "../../src/lib/connectors/chatgpt/fetch";
import { ClaudeFetcher } from "../../src/lib/connectors/claude/fetch";

import rawOrganizations from "../fixtures/raw-claude-organizations.json";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

// Routes a stubbed fetch by URL substring so a single mock can serve the
// session, list, and detail endpoints a fetcher hits in sequence. The
// longest-matching needle wins, so a broad path (e.g. /api/organizations) never
// shadows a more specific one nested under it (/api/organizations/x/chat_...).
function routeFetch(routes: Array<[string, () => Response]>): void {
  const byLongest = [...routes].sort((a, b) => b[0].length - a[0].length);
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [needle, make] of byLongest) {
      if (url.includes(needle)) return Promise.resolve(make());
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

describe("ChatGptFetcher", () => {
  it("reports an inactive session when accessToken is missing", async () => {
    // Arrange
    routeFetch([["/api/auth/session", () => jsonResponse({})]]);

    // Act
    const active = await new ChatGptFetcher().isSessionActive();

    // Assert
    expect(active).toBe(false);
  });

  it("sends the accessToken as a bearer on list calls", async () => {
    // Arrange
    const spy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      spy(url, init);
      if (url.includes("/api/auth/session"))
        return Promise.resolve(jsonResponse({ accessToken: "tok-123" }));
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    // Act
    await new ChatGptFetcher().listConversationsRaw();

    // Assert
    const listCall = spy.mock.calls.find(([url]) =>
      String(url).includes("/backend-api/conversations"),
    );
    expect(listCall).toBeDefined();
    const headers = (listCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("stops paging once an item at or before the since watermark is seen", async () => {
    // Arrange
    routeFetch([
      ["/api/auth/session", () => jsonResponse({ accessToken: "tok" })],
      [
        "/backend-api/conversations",
        () =>
          jsonResponse({
            items: [
              { id: "new-1", title: "New", update_time: "2026-06-05T12:00:00Z" },
              { id: "old-1", title: "Old", update_time: "2026-06-01T12:00:00Z" },
            ],
          }),
      ],
    ]);

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw("2026-06-03T00:00:00Z");

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.data.map((s) => s.platform_id)).toEqual(["new-1"]);
    }
  });

  it("surfaces a rate_limited outcome from the session call", async () => {
    // Arrange
    routeFetch([
      [
        "/api/auth/session",
        () => new Response(null, { status: 429, headers: { "retry-after": "7" } }),
      ],
    ]);

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome).toEqual({ status: "rate_limited", retryAfterSeconds: 7 });
  });

  it("reports an inactive session when the session body is JSON null", async () => {
    // Arrange: a 200 with a literal JSON `null` body must not crash on deref.
    routeFetch([["/api/auth/session", () => jsonResponse(null)]]);

    // Act
    const active = await new ChatGptFetcher().isSessionActive();

    // Assert
    expect(active).toBe(false);
  });

  it("treats a JSON null list body as an empty page rather than crashing", async () => {
    // Arrange: session is fine, but the conversations endpoint returns `null`.
    routeFetch([
      ["/api/auth/session", () => jsonResponse({ accessToken: "tok" })],
      ["/backend-api/conversations", () => jsonResponse(null)],
    ]);

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.data).toEqual([]);
  });

  it("treats a list body whose items is not an array as an empty page", async () => {
    // Arrange
    routeFetch([
      ["/api/auth/session", () => jsonResponse({ accessToken: "tok" })],
      ["/backend-api/conversations", () => jsonResponse({ items: "nope" })],
    ]);

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.data).toEqual([]);
  });
});

describe("ClaudeFetcher", () => {
  it("reports an inactive session when there are no organizations", async () => {
    // Arrange
    routeFetch([["/api/organizations", () => jsonResponse([])]]);

    // Act
    const active = await new ClaudeFetcher().isSessionActive();

    // Assert
    expect(active).toBe(false);
  });

  it("reports no active chat session when only a non-chat (api) org exists", async () => {
    // Arrange
    routeFetch([
      ["/api/organizations", () => jsonResponse([{ uuid: "org-api", capabilities: ["api"] }])],
    ]);

    // Act
    const active = await new ClaudeFetcher().isSessionActive();

    // Assert
    expect(active).toBe(false);
  });

  it("selects the chat-capable org and never lists on the api org", async () => {
    // Arrange: fixture is [ {chat}, {api} ].
    const spy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      spy(url);
      if (url.endsWith("/api/organizations")) {
        return Promise.resolve(jsonResponse(rawOrganizations));
      }
      return Promise.resolve(jsonResponse([]));
    });

    // Act
    await new ClaudeFetcher().listConversationsRaw();

    // Assert: the only chat_conversations call targets the chat org, never the api org.
    const listCalls = spy.mock.calls.filter(([url]) => String(url).includes("/chat_conversations"));
    expect(listCalls.length).toBe(1);
    expect(String(listCalls[0]![0])).toContain("/organizations/org-chat/");
    expect(spy.mock.calls.every(([url]) => !String(url).includes("org-api"))).toBe(true);
  });

  it("picks the first chat-capable org when more than one exists", async () => {
    // Arrange
    const spy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      spy(url);
      if (url.endsWith("/api/organizations")) {
        return Promise.resolve(
          jsonResponse([
            { uuid: "org-api", capabilities: ["api"] },
            { uuid: "org-chat-1", capabilities: ["chat"] },
            { uuid: "org-chat-2", capabilities: ["chat"] },
          ]),
        );
      }
      return Promise.resolve(jsonResponse([]));
    });

    // Act
    await new ClaudeFetcher().listConversationsRaw();

    // Assert
    const listCall = spy.mock.calls.find(([url]) => String(url).includes("/chat_conversations"));
    expect(listCall).toBeDefined();
    expect(String(listCall![0])).toContain("/organizations/org-chat-1/");
    expect(String(listCall![0])).not.toContain("org-chat-2");
  });

  it("filters out conversations at or before the since watermark", async () => {
    // Arrange
    routeFetch([
      ["/api/organizations", () => jsonResponse([{ uuid: "org-chat", capabilities: ["chat"] }])],
      [
        "/chat_conversations",
        () =>
          jsonResponse([
            { uuid: "keep", name: "Keep", updated_at: "2026-06-05T12:00:00Z" },
            { uuid: "drop", name: "Drop", updated_at: "2026-06-01T12:00:00Z" },
          ]),
      ],
    ]);

    // Act
    const outcome = await new ClaudeFetcher().listConversationsRaw("2026-06-03T00:00:00Z");

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.data.map((s) => s.platform_id)).toEqual(["keep"]);
    }
  });
});
