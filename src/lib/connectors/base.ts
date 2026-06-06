import type { ConversationPayload, Platform } from "../schema/ingest";

// A normalized conversation is exactly the ingest payload shape. The canonical
// definitions live in schema/ingest.ts; re-export them here so the connector
// surface has a single source of truth.
export type { NormalizedMessage, NormalizedConversation } from "../schema/ingest";

// Supported connector platforms. v2 will extend this union (and the backend
// ingest source enum) with new platforms; keep AdapterPlatform in sync with the
// backend when adding one.
export type AdapterPlatform = Extract<Platform, "chatgpt" | "claude">;

// Lightweight listing entry returned by the raw fetcher before a full
// conversation is fetched. `platform_id` is the platform's native conversation
// id; `updated_at` drives incremental-sync watermark comparisons.
export interface ConversationSummary {
  platform_id: string;
  title: string;
  updated_at: string | null;
}

// The architecture splits the connector into two halves that live in different
// runtime contexts and must never share a module:
//
//   1. The RAW FETCHER runs INSIDE a content script. It does same-origin
//      `fetch(credentials:'include')` reads of the page the user is on and
//      returns the platform's raw JSON verbatim. It MUST stay free of any
//      third-party runtime code (no zod, no schema) -- a CI build gate enforces
//      this. Hence its result types carry `unknown` raw payloads, never the
//      Zod-validated ConversationPayload.
//   2. The NORMALIZER runs in the BACKGROUND / lib context. It is a pure
//      function from a raw payload to a Zod-validated ConversationPayload, and
//      it is the only half allowed to import the schema (zod) runtime.

// Discriminated outcome for a single raw fetch. `rate_limited` carries the
// server-advised wait when an HTTP 429 was seen (seconds; undefined when no
// Retry-After header was present), so the orchestrator can back off.
export type RawFetchOutcome<T> =
  | { status: "ok"; data: T }
  | { status: "rate_limited"; retryAfterSeconds?: number }
  | { status: "error"; error: string };

// Content-side contract. Implemented by chatgpt/fetch.ts and claude/fetch.ts.
// Everything here is content-safe: no schema, no third-party imports.
export interface RawConversationFetcher {
  readonly platform: AdapterPlatform;

  // Resolves true when the user has an authenticated session on the platform.
  isSessionActive(): Promise<boolean>;

  // Lists conversation summaries, optionally only those updated at or after
  // `since` (ISO-8601) to support incremental sync.
  listConversationsRaw(since?: string): Promise<RawFetchOutcome<ConversationSummary[]>>;

  // Fetches one conversation's raw platform JSON by its native id. The shape is
  // platform-specific and intentionally opaque (unknown) at this boundary; the
  // normalizer is what understands it.
  fetchConversationRaw(id: string): Promise<RawFetchOutcome<unknown>>;
}

// Background-side contract. Implemented by chatgpt/normalize.ts and
// claude/normalize.ts. A normalizer returns null when the raw payload is
// malformed (e.g. zero usable messages, missing created_at, or it fails the Zod
// gate) so a single bad conversation is skipped and counted rather than
// aborting the whole run.
export interface ConversationNormalizer {
  readonly platform: AdapterPlatform;
  normalizeConversation(raw: unknown): ConversationPayload | null;
}
