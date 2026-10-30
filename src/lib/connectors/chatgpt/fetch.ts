import type { ConversationSummary, RawConversationFetcher, RawFetchOutcome } from "../base";
import { fetchJson } from "../http";

// ChatGPT (chatgpt.com) content-safe raw fetcher.
//
// CONTENT-SCRIPT ISOLATION: imported by entrypoints/chatgpt.content -- MUST stay
// free of third-party runtime code (no zod, no schema). It returns raw platform
// JSON; the background normalizer is what understands and validates the shape.
//
// Auth: /backend-api/* require an Authorization: Bearer <accessToken> header in
// addition to the session cookie. The accessToken is fetched from the session
// endpoint; the cookie alone is not sufficient.

const SESSION_URL = "https://chatgpt.com/api/auth/session";
const CONVERSATIONS_URL = "https://chatgpt.com/backend-api/conversations";
const CONVERSATION_URL = "https://chatgpt.com/backend-api/conversation";

const LIST_PAGE_SIZE = 100;
// Hard ceiling on pages walked in one list call, so a watermark that never
// matches cannot loop unbounded.
const MAX_LIST_PAGES = 50;

interface SessionResponse {
  accessToken?: string;
}

interface RawListItem {
  id?: string;
  title?: string;
  update_time?: string | number | null;
}

interface RawListPage {
  items?: RawListItem[];
}

function bearerHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

// The list endpoint returns update_time as an ISO string; coerce to a string
// summary field and tolerate a missing/numeric value defensively.
function toSummary(item: RawListItem): ConversationSummary {
  const updatedAt = typeof item.update_time === "string" ? item.update_time : null;
  return {
    platform_id: typeof item.id === "string" ? item.id : "",
    title: typeof item.title === "string" ? item.title : "",
    updated_at: updatedAt,
  };
}

// True when the item is at or older than the incremental-sync watermark, i.e.
// pagination can stop. A missing/unparseable timestamp never stops the walk.
function isAtOrBeforeWatermark(updatedAt: string | null, since: string): boolean {
  if (updatedAt === null) return false;
  const itemMs = Date.parse(updatedAt);
  const sinceMs = Date.parse(since);
  if (Number.isNaN(itemMs) || Number.isNaN(sinceMs)) return false;
  return itemMs <= sinceMs;
}

// A 200 whose body is not an object carrying an `items` array is API drift, not
// an empty listing: reading it as empty would end the walk and merge as valid.
function listItemsOf(body: unknown): RawListItem[] | null {
  if (typeof body !== "object" || body === null) return null;
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items) ? (items as RawListItem[]) : null;
}

async function fetchAccessToken(): Promise<RawFetchOutcome<string>> {
  const outcome = await fetchJson<SessionResponse>(SESSION_URL);
  if (outcome.status !== "ok") return outcome;
  // A 200 with a JSON body of `null` (or any non-object) parses cleanly but has
  // no accessToken; guard before dereferencing.
  if (typeof outcome.data !== "object" || outcome.data === null) {
    return { status: "error", error: "unexpected session response shape" };
  }
  const token = outcome.data.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    return { status: "error", error: "no active ChatGPT session (missing accessToken)" };
  }
  return { status: "ok", data: token };
}

// Walks one listing (offset paging, newest first) until a short or empty page,
// the since watermark, or the page ceiling.
async function listPass(
  headers: Record<string, string>,
  extraQuery: string,
  since: string | undefined,
): Promise<RawFetchOutcome<ConversationSummary[]>> {
  const collected: ConversationSummary[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const offset = page * LIST_PAGE_SIZE;
    const url = `${CONVERSATIONS_URL}?offset=${offset}&limit=${LIST_PAGE_SIZE}&order=updated${extraQuery}`;
    const pageOutcome = await fetchJson<RawListPage>(url, headers);
    if (pageOutcome.status !== "ok") return pageOutcome;

    const items = listItemsOf(pageOutcome.data);
    if (items === null) {
      return { status: "error", error: "unexpected ChatGPT list response shape" };
    }
    if (items.length === 0) break;

    let reachedWatermark = false;
    for (const item of items) {
      const summary = toSummary(item);
      if (since !== undefined && isAtOrBeforeWatermark(summary.updated_at, since)) {
        reachedWatermark = true;
        break;
      }
      collected.push(summary);
    }
    if (reachedWatermark || items.length < LIST_PAGE_SIZE) break;
  }
  return { status: "ok", data: collected };
}

// An empty id carries no identity, so it is never treated as a duplicate.
function mergeById(
  first: readonly ConversationSummary[],
  second: readonly ConversationSummary[],
): ConversationSummary[] {
  const seen = new Set(first.map((s) => s.platform_id));
  return [...first, ...second.filter((s) => s.platform_id === "" || !seen.has(s.platform_id))];
}

export class ChatGptFetcher implements RawConversationFetcher {
  readonly platform = "chatgpt" as const;

  async isSessionActive(): Promise<boolean> {
    const outcome = await fetchAccessToken();
    return outcome.status === "ok";
  }

  async listConversationsRaw(since?: string): Promise<RawFetchOutcome<ConversationSummary[]>> {
    const tokenOutcome = await fetchAccessToken();
    if (tokenOutcome.status !== "ok") return tokenOutcome;
    const headers = bearerHeaders(tokenOutcome.data);

    const live = await listPass(headers, "", since);
    if (live.status !== "ok") return live;
    // The default listing may omit archived chats; whether is_archived=true
    // returns them is checked on a real account.
    const archived = await listPass(headers, "&is_archived=true", since);
    if (archived.status !== "ok") return archived;
    return { status: "ok", data: mergeById(live.data, archived.data) };
  }

  async fetchConversationRaw(id: string): Promise<RawFetchOutcome<unknown>> {
    const tokenOutcome = await fetchAccessToken();
    if (tokenOutcome.status !== "ok") return tokenOutcome;
    const url = `${CONVERSATION_URL}/${encodeURIComponent(id)}`;
    return fetchJson<unknown>(url, bearerHeaders(tokenOutcome.data));
  }
}
