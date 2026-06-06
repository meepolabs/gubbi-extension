import type { NormalizedConversation, Platform } from "../schema/ingest";

// A scraped message / conversation is exactly the ingest payload shape. The
// canonical definitions live in schema/ingest.ts; re-export them here so the
// adapter surface has a single source of truth.
export type { NormalizedMessage, NormalizedConversation } from "../schema/ingest";

// The platform adapter contract. Each supported LLM site implements this so the
// background sync loop can drive scraping uniformly.
//
// v2 will extend this union with "gemini" to match the backend ingest source
// enum (extension_chatgpt | extension_claude | ...). Keep AdapterPlatform in
// sync with the backend when adding platforms.
export type AdapterPlatform = Extract<Platform, "chatgpt" | "claude">;

// Lightweight listing entry returned before a full conversation is fetched.
export interface ConversationSummary {
  platform_id: string;
  title: string;
  updated_at: string | null;
}

export interface LLMPlatformAdapter {
  readonly platform: AdapterPlatform;

  // Resolves true when the user has an authenticated session on the platform.
  isSessionActive(): Promise<boolean>;

  // Lists conversation summaries, optionally only those updated after `since`
  // (ISO-8601 timestamp) to support incremental sync.
  listConversations(since?: string): Promise<ConversationSummary[]>;

  // Fetches and normalizes a single conversation by its platform id.
  fetchConversation(id: string): Promise<NormalizedConversation>;
}

// Registry mapping each supported platform to its adapter instance.
export type AdapterRegistry = Record<AdapterPlatform, LLMPlatformAdapter>;
