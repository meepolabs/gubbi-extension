import type { ConversationSummary, RawConversationFetcher, RawFetchOutcome } from "../base";
import { fetchJson } from "../http";

// Claude (claude.ai) content-safe raw fetcher.
//
// CONTENT-SCRIPT ISOLATION: imported by entrypoints/claude.content -- MUST stay
// free of third-party runtime code (no zod, no schema). Returns raw platform
// JSON; the background normalizer understands and validates it.
//
// Auth is the session cookie alone (no bearer token, unlike ChatGPT). All reads
// are scoped to an organization.

const ORGANIZATIONS_URL = "https://claude.ai/api/organizations";

const LIST_PAGE_SIZE = 100;

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

function conversationsUrl(orgUuid: string): string {
  return `https://claude.ai/api/organizations/${encodeURIComponent(orgUuid)}/chat_conversations`;
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

// v1 LIMITATION: an account may belong to several chat-capable orgs; selecting
// among multiple CHAT orgs (e.g. team workspaces) is a post-v1 limitation; v1
// uses the first chat-capable org. Orgs without the "chat" capability are
// skipped entirely (their chat_conversations endpoint 403s). Returns an error
// outcome when no chat-capable org exists (treated as no active session).
async function fetchPrimaryOrgUuid(): Promise<RawFetchOutcome<string>> {
  const outcome = await fetchJson<RawOrganization[]>(ORGANIZATIONS_URL);
  if (outcome.status !== "ok") return outcome;
  const orgs = Array.isArray(outcome.data) ? outcome.data : [];
  const chatOrg = orgs.find(isChatOrg);
  const uuid = chatOrg?.uuid;
  if (typeof uuid !== "string" || uuid.length === 0) {
    return { status: "error", error: "no active Claude session (no chat-capable organization)" };
  }
  return { status: "ok", data: uuid };
}

export class ClaudeFetcher implements RawConversationFetcher {
  readonly platform = "claude" as const;

  async isSessionActive(): Promise<boolean> {
    const outcome = await fetchPrimaryOrgUuid();
    return outcome.status === "ok";
  }

  async listConversationsRaw(since?: string): Promise<RawFetchOutcome<ConversationSummary[]>> {
    const orgOutcome = await fetchPrimaryOrgUuid();
    if (orgOutcome.status !== "ok") return orgOutcome;

    // The list endpoint returns a bounded list (no documented cursor/offset);
    // v1 requests a single page and filters by the updated_at watermark. If a
    // future API exposes pagination this is where it is added.
    const url = `${conversationsUrl(orgOutcome.data)}?limit=${LIST_PAGE_SIZE}`;
    const pageOutcome = await fetchJson<RawListItem[]>(url);
    if (pageOutcome.status !== "ok") return pageOutcome;

    const items = Array.isArray(pageOutcome.data) ? pageOutcome.data : [];
    const collected: ConversationSummary[] = [];
    for (const item of items) {
      const summary = toSummary(item);
      if (since !== undefined && isAtOrBeforeWatermark(summary.updated_at, since)) continue;
      collected.push(summary);
    }
    return { status: "ok", data: collected };
  }

  async fetchConversationRaw(id: string): Promise<RawFetchOutcome<unknown>> {
    const orgOutcome = await fetchPrimaryOrgUuid();
    if (orgOutcome.status !== "ok") return orgOutcome;
    return fetchJson<unknown>(detailUrl(orgOutcome.data, id));
  }
}
