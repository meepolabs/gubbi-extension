import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatGptFetcher } from "../../src/lib/connectors/chatgpt/fetch";
import { ClaudeFetcher } from "../../src/lib/connectors/claude/fetch";
import { resetSourceRequestTiming, setSourceRequestTiming } from "../../src/lib/connectors/http";
import { toListOutcome } from "../../src/lib/connectors/outcome";

import rawListPage1 from "../fixtures/raw-claude-list-page-1.json";
import rawListPage2 from "../fixtures/raw-claude-list-page-2.json";
import rawOrganizations from "../fixtures/raw-claude-organizations.json";

beforeEach(() => {
  setSourceRequestTiming({ spacingMs: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRequestTiming();
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

describe("ChatGptFetcher archived listing", () => {
  it("issues an archived pass and returns its ids after the first pass", async () => {
    // Arrange
    const urls = stubChatGptList((archived) =>
      jsonResponse({ items: [archived ? chatItem("arch-1") : chatItem("live-1")] }),
    );

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.data.map((s) => s.platform_id)).toEqual(["live-1", "arch-1"]);
    }
    const lists = chatListUrls(urls);
    expect(lists.map(isArchivedUrl)).toEqual([false, true]);
    expect(new URL(lists[0]!).searchParams.has("is_archived")).toBe(false);
  });

  it("keeps an id listed by both passes once", async () => {
    // Arrange
    stubChatGptList((archived) =>
      jsonResponse({
        items: archived ? [chatItem("both-1"), chatItem("arch-1")] : [chatItem("both-1")],
      }),
    );

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.data.map((s) => s.platform_id)).toEqual(["both-1", "arch-1"]);
    }
  });

  it("never collapses summaries that carry no id", async () => {
    // Arrange
    stubChatGptList(() => jsonResponse({ items: [{ title: "untitled" }] }));

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.data.map((s) => s.platform_id)).toEqual(["", ""]);
    }
  });

  it("applies the since watermark to the archived pass", async () => {
    // Arrange
    stubChatGptList((archived) =>
      jsonResponse({
        items: archived
          ? [
              chatItem("arch-new", "2026-06-05T12:00:00Z"),
              chatItem("arch-old", "2026-06-01T12:00:00Z"),
            ]
          : [],
      }),
    );

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw("2026-06-03T00:00:00Z");

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.data.map((s) => s.platform_id)).toEqual(["arch-new"]);
    }
  });

  it("stops each pass at the page ceiling", async () => {
    // Arrange
    const fullPage = Array.from({ length: CHATGPT_PAGE_SIZE }, (_, i) => chatItem(`c-${i}`));
    const urls = stubChatGptList(() => jsonResponse({ items: fullPage }));

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome.status).toBe("ok");
    const lists = chatListUrls(urls);
    expect(lists.filter((u) => !isArchivedUrl(u))).toHaveLength(EXPECTED_MAX_LIST_PAGES);
    expect(lists.filter(isArchivedUrl)).toHaveLength(EXPECTED_MAX_LIST_PAGES);
  });

  it("surfaces a 429 from the archived pass as rate_limited", async () => {
    // Arrange
    stubChatGptList((archived) =>
      archived
        ? new Response(null, { status: 429, headers: { "retry-after": "9" } })
        : jsonResponse({ items: [chatItem("live-1")] }),
    );

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome).toEqual({ status: "rate_limited", retryAfterSeconds: 9 });
    expect(toListOutcome(outcome)).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 9,
    });
  });

  it.each([
    ["a 500", () => new Response(null, { status: 500 }), "transient_http"],
    ["a 401", () => new Response(null, { status: 401 }), "session_lost"],
    ["a non-JSON body", () => new Response("<html>", { status: 200 }), "malformed_response"],
  ] as const)(
    "maps %s from the archived pass like the first pass",
    async (_label, failing, reason) => {
      // Arrange
      stubChatGptList(() => failing());
      const firstPassOutcome = toListOutcome(await new ChatGptFetcher().listConversationsRaw());
      vi.restoreAllMocks();
      stubChatGptList((archived) =>
        archived ? failing() : jsonResponse({ items: [chatItem("live-1")] }),
      );

      // Act
      const outcome = toListOutcome(await new ChatGptFetcher().listConversationsRaw());

      // Assert
      expect(firstPassOutcome).toEqual({ ok: false, reason });
      expect(outcome).toEqual(firstPassOutcome);
    },
  );

  it("does not issue the archived pass when the first pass fails", async () => {
    // Arrange
    const urls = stubChatGptList((archived) =>
      archived
        ? jsonResponse({ items: [chatItem("arch-1")] })
        : new Response(null, { status: 429, headers: { "retry-after": "3" } }),
    );

    // Act
    const outcome = await new ChatGptFetcher().listConversationsRaw();

    // Assert
    expect(outcome).toEqual({ status: "rate_limited", retryAfterSeconds: 3 });
    expect(chatListUrls(urls).filter(isArchivedUrl)).toHaveLength(0);
  });
});

const CHATGPT_PAGE_SIZE = 100;

function chatItem(id: string, updateTime = "2026-06-05T12:00:00Z"): Record<string, string> {
  return { id, title: id, update_time: updateTime };
}

function isArchivedUrl(url: string): boolean {
  return new URL(url).searchParams.get("is_archived") === "true";
}

function chatListUrls(urls: string[]): string[] {
  return urls.filter((url) => new URL(url).pathname === "/backend-api/conversations");
}

// Serves a valid session and routes each list request by its is_archived query
// parameter; returns the requested URLs in order.
function stubChatGptList(listResponse: (archived: boolean) => Response): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.includes("/api/auth/session")) {
      return Promise.resolve(jsonResponse({ accessToken: "tok" }));
    }
    return Promise.resolve(listResponse(isArchivedUrl(url)));
  });
  return urls;
}

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
      return Promise.resolve(jsonResponse(EMPTY_FINAL_PAGE));
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
      return Promise.resolve(jsonResponse(EMPTY_FINAL_PAGE));
    });

    // Act
    await new ClaudeFetcher().listConversationsRaw();

    // Assert
    const listCall = spy.mock.calls.find(([url]) => String(url).includes("/chat_conversations"));
    expect(listCall).toBeDefined();
    expect(String(listCall![0])).toContain("/organizations/org-chat-1/");
    expect(String(listCall![0])).not.toContain("org-chat-2");
  });

  it("lists on chat_conversations_v2 with limit 50 and strong consistency", async () => {
    // Arrange
    const urls = stubClaudeList(() => jsonResponse(EMPTY_FINAL_PAGE));

    // Act
    await new ClaudeFetcher().listConversationsRaw();

    // Assert
    const listUrls = v2ListUrls(urls);
    expect(listUrls).toHaveLength(1);
    const url = new URL(listUrls[0]!);
    expect(url.pathname).toBe("/api/organizations/org-chat/chat_conversations_v2");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("consistency")).toBe("strong");
  });

  it("walks every page until has_more is false, advancing offset by the page length", async () => {
    // Arrange
    const pages = [rawListPage1, rawListPage2];
    let served = 0;
    const urls = stubClaudeList(() => jsonResponse(pages[served++]));

    // Act
    const outcome = await new ClaudeFetcher().listConversationsRaw();

    // Assert
    expect(outcome).toEqual({
      status: "ok",
      data: [
        {
          platform_id: "claude-conv-0003",
          title: "Sketch a garden layout",
          updated_at: "2026-06-07T08:30:00.000000Z",
        },
        {
          platform_id: "claude-conv-0002",
          title: "Compare two bike routes",
          updated_at: "2026-06-06T10:20:00.000000Z",
        },
        {
          platform_id: "claude-conv-0001",
          title: "Plan a reading list",
          updated_at: "2026-06-05T09:15:00.000000Z",
        },
      ],
    });
    const offsets = v2ListUrls(urls).map((u) => new URL(u).searchParams.get("offset"));
    expect(offsets).toEqual(["0", String(rawListPage1.data.length)]);
  });

  it("stops at an item at or before the since watermark without requesting the next page", async () => {
    // Arrange: page 1 says has_more, but its second item is at/before the watermark.
    const urls = stubClaudeList(() => jsonResponse(rawListPage1));

    // Act
    const outcome = await new ClaudeFetcher().listConversationsRaw("2026-06-06T12:00:00Z");

    // Assert
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.data.map((s) => s.platform_id)).toEqual(["claude-conv-0003"]);
    }
    expect(v2ListUrls(urls)).toHaveLength(1);
  });

  it.each([
    ["empty data with has_more true", { data: [], has_more: true }],
    ["a page missing has_more", { data: rawListPage2.data }],
    ["a page whose has_more is not a boolean", { data: rawListPage2.data, has_more: "true" }],
    ["a page whose data is not an array", { data: "nope", has_more: false }],
    ["a page whose data holds a non-object item", { data: [null], has_more: false }],
    ["a bare array body (the v1 list shape)", rawListPage2.data],
    ["a JSON null body", null],
  ])("maps %s to malformed_response after exactly one list request", async (_label, body) => {
    // Arrange
    const urls = stubClaudeList(() => jsonResponse(body));

    // Act
    const outcome = await new ClaudeFetcher().listConversationsRaw();

    // Assert
    expect(outcome.status).toBe("error");
    expect(toListOutcome(outcome)).toEqual({ ok: false, reason: "malformed_response" });
    expect(v2ListUrls(urls)).toHaveLength(1);
  });

  it("stops after the page ceiling when the server always answers has_more true", async () => {
    // Arrange
    const urls = stubClaudeList(() => jsonResponse({ data: rawListPage2.data, has_more: true }));

    // Act
    const outcome = await new ClaudeFetcher().listConversationsRaw();

    // Assert
    expect(outcome.status).toBe("ok");
    expect(v2ListUrls(urls)).toHaveLength(EXPECTED_MAX_LIST_PAGES);
    if (outcome.status === "ok") expect(outcome.data).toHaveLength(EXPECTED_MAX_LIST_PAGES);
  });
});

const EMPTY_FINAL_PAGE = { data: [], has_more: false };
const EXPECTED_MAX_LIST_PAGES = 50;

// Serves a single chat-capable org and delegates every other request to
// `listResponse`; returns the requested URLs in order.
function stubClaudeList(listResponse: () => Response): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url.endsWith("/api/organizations")) {
      return Promise.resolve(jsonResponse([{ uuid: "org-chat", capabilities: ["chat"] }]));
    }
    return Promise.resolve(listResponse());
  });
  return urls;
}

function v2ListUrls(urls: string[]): string[] {
  return urls.filter((url) => url.includes("/chat_conversations_v2"));
}
