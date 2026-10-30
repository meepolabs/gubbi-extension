import type { ConversationSummary, RawConversationFetcher, RawFetchOutcome } from "../base";
import { fetchJson } from "../http";
import { toFailure } from "../outcome";

// Claude (claude.ai) content-safe raw fetcher.
//
// CONTENT-SCRIPT ISOLATION: imported by entrypoints/claude.content -- MUST stay
// free of third-party runtime code (no zod, no schema). Returns raw platform
// JSON; the background normalizer understands and validates it.
//
// Auth is the session cookie alone (no bearer token, unlike ChatGPT). All reads
// are scoped to an organization.

const ORGANIZATIONS_URL = "https://claude.ai/api/organizations";

const LIST_PAGE_SIZE = 50;
// Hard ceiling on pages walked in one list call, so a server that keeps
// answering has_more: true cannot loop unbounded.
const MAX_LIST_PAGES = 50;

interface RawOrganization {
  uuid?: string;
  capabilities?: string[] | null;
}

const CHAT_CAPABILITY = "chat";

// A chat-capable org has "chat" in its capabilities and serves chat_conversations
// with 200; an API/Console org has ["api"] and 403s that endpoint. Selecting by
// capability avoids ever calling chat_conversations on a non-chat org.
function isChatOrg(org: RawOrganization): boolean {
  return Array.isArray(org.capabilities) && org.capabilities.includes(CHAT_CAPABILITY);
}

interface RawListItem {
  uuid?: string;
  name?: string;
  updated_at?: string | null;
}

interface RawListPage {
  data: RawListItem[];
  has_more: boolean;
}

function isRawListPage(body: unknown): body is RawListPage {
  if (typeof body !== "object" || body === null) return false;
  const page = body as { data?: unknown; has_more?: unknown };
  return (
    Array.isArray(page.data) &&
    page.data.every((item) => typeof item === "object" && item !== null) &&
    typeof page.has_more === "boolean"
  );
}

function conversationsUrl(orgUuid: string): string {
  return `https://claude.ai/api/organizations/${encodeURIComponent(orgUuid)}/chat_conversations`;
}

function listPageUrl(orgUuid: string, offset: number): string {
  const base = `https://claude.ai/api/organizations/${encodeURIComponent(orgUuid)}/chat_conversations_v2`;
  return `${base}?limit=${LIST_PAGE_SIZE}&offset=${offset}&consistency=strong`;
}

function detailUrl(orgUuid: string, conversationUuid: string): string {
  const base = `${conversationsUrl(orgUuid)}/${encodeURIComponent(conversationUuid)}`;
  return `${base}?tree=True&rendering_mode=messages`;
}

function toSummary(item: RawListItem): ConversationSummary {
  return {
    platform_id: typeof item.uuid === "string" ? item.uuid : "",
    title: typeof item.name === "string" ? item.name : "",
    updated_at: typeof item.updated_at === "string" ? item.updated_at : null,
  };
}

function isAtOrBeforeWatermark(updatedAt: string | null, since: string): boolean {
  if (updatedAt === null) return false;
  const itemMs = Date.parse(updatedAt);
  const sinceMs = Date.parse(since);
  if (Number.isNaN(itemMs) || Number.isNaN(sinceMs)) return false;
  return itemMs <= sinceMs;
}

const NO_CHAT_ORG_ERROR = "no active Claude session (no chat-capable organization)";
const AMBIGUOUS_ORG_ERROR =
  "ambiguous Claude organization (more than one chat-capable organization)";

// Exactly one chat-capable org is used. Several chat orgs fail closed rather than
// picking one: nothing in the payload reliably marks the personal workspace, and
// syncing the wrong one would upload another workspace's conversations. Orgs
// without the "chat" capability are ignored (their chat_conversations 403s).
async function resolveChatOrgUuid(): Promise<RawFetchOutcome<string>> {
  const outcome = await fetchJson<RawOrganization[]>(ORGANIZATIONS_URL);
  if (outcome.status !== "ok") return outcome;
  const orgs = Array.isArray(outcome.data) ? outcome.data : [];
  const chatOrgs = orgs.filter(isChatOrg);
  if (chatOrgs.length > 1) return { status: "error", error: AMBIGUOUS_ORG_ERROR };
  const uuid = chatOrgs[0]?.uuid;
  if (typeof uuid !== "string" || uuid.length === 0) {
    return { status: "error", error: NO_CHAT_ORG_ERROR };
  }
  return { status: "ok", data: uuid };
}

export class ClaudeFetcher implements RawConversationFetcher {
  readonly platform = "claude" as const;

  // The org resolved by the last list, reused by the detail fetches that follow
  // it. Every list re-resolves, so a change in the account's orgs is seen once
  // per sync rather than masked by a stale value.
  private orgUuid: string | null = null;

  async isSessionActive(): Promise<boolean> {
    const outcome = await this.resolveOrg();
    return outcome.status === "ok";
  }

  private async resolveOrg(): Promise<RawFetchOutcome<string>> {
    const outcome = await resolveChatOrgUuid();
    this.orgUuid = outcome.status === "ok" ? outcome.data : null;
    return outcome;
  }

  private async memoizedOrg(): Promise<RawFetchOutcome<string>> {
    if (this.orgUuid !== null) return { status: "ok", data: this.orgUuid };
    return this.resolveOrg();
  }

  private async orgScopedGet(url: string): Promise<RawFetchOutcome<unknown>> {
    const outcome = await fetchJson<unknown>(url);
    if (outcome.status === "error" && toFailure(outcome).reason === "session_lost") {
      this.orgUuid = null;
    }
    return outcome;
  }

  async listConversationsRaw(since?: string): Promise<RawFetchOutcome<ConversationSummary[]>> {
    const orgOutcome = await this.resolveOrg();
    if (orgOutcome.status !== "ok") return orgOutcome;

    const collected: ConversationSummary[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const pageOutcome = await this.orgScopedGet(listPageUrl(orgOutcome.data, offset));
      if (pageOutcome.status !== "ok") return pageOutcome;
      const body = pageOutcome.data;
      if (!isRawListPage(body)) {
        return { status: "error", error: "unexpected Claude list response shape" };
      }
      // An empty page that still claims more would re-request the same offset
      // forever; treat it as API drift rather than the end of the listing.
      if (body.data.length === 0 && body.has_more) {
        return { status: "error", error: "unexpected empty Claude list page with has_more" };
      }

      for (const item of body.data) {
        const summary = toSummary(item);
        if (since !== undefined && isAtOrBeforeWatermark(summary.updated_at, since)) {
          return { status: "ok", data: collected };
        }
        collected.push(summary);
      }
      if (!body.has_more) break;
      offset += body.data.length;
    }
    return { status: "ok", data: collected };
  }

  async fetchConversationRaw(id: string): Promise<RawFetchOutcome<unknown>> {
    const orgOutcome = await this.memoizedOrg();
    if (orgOutcome.status !== "ok") return orgOutcome;
    return this.orgScopedGet(detailUrl(orgOutcome.data, id));
  }
}
