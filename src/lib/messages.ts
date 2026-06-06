import type { ConversationPayload, Platform } from "./schema/ingest";
import type { ConversationSummary } from "./scrapers/base";

// Single message envelope for service-worker <-> content-script <-> popup
// communication. The "type" field is the discriminant. This module is types +
// a guard only; it intentionally pulls in no runtime third-party code so it is
// safe to import from content scripts (all schema/adapter imports are type-only
// and erased at build).

export interface SyncStartMessage {
  type: "SYNC_START";
  platform?: Platform;
}

export interface SyncProgressMessage {
  type: "SYNC_PROGRESS";
  platform: Platform;
  processed: number;
  total: number;
}

export interface SyncDoneMessage {
  type: "SYNC_DONE";
  platform: Platform;
  uploaded: number;
}

export interface SyncErrorMessage {
  type: "SYNC_ERROR";
  platform?: Platform;
  message: string;
}

// LIST_* drives the adapter's listConversations: the content script returns a
// page of lightweight summaries.
export interface ListRequestMessage {
  type: "LIST_REQUEST";
  platform: Platform;
  since?: string;
}

export type ListOutcome =
  | { ok: true; summaries: ConversationSummary[] }
  | { ok: false; error: string };

export interface ListResultMessage {
  type: "LIST_RESULT";
  platform: Platform;
  result: ListOutcome;
}

// SCRAPE_* drives the adapter's fetchConversation: the content script returns a
// single fully scraped conversation.
export interface ScrapeRequestMessage {
  type: "SCRAPE_REQUEST";
  platform: Platform;
  conversationId: string;
}

export type ScrapeOutcome =
  | { ok: true; conversation: ConversationPayload }
  | { ok: false; error: string };

export interface ScrapeResultMessage {
  type: "SCRAPE_RESULT";
  platform: Platform;
  conversationId: string;
  result: ScrapeOutcome;
}

export type ExtensionMessage =
  | SyncStartMessage
  | SyncProgressMessage
  | SyncDoneMessage
  | SyncErrorMessage
  | ListRequestMessage
  | ListResultMessage
  | ScrapeRequestMessage
  | ScrapeResultMessage;

// Compile-time exhaustiveness: a Record keyed by the discriminant union requires
// exactly one entry per message type, so adding a member to ExtensionMessage
// without listing it here is a tsc error. The runtime Set is derived from its
// keys.
const MESSAGE_TYPE_PRESENCE: Record<ExtensionMessage["type"], true> = {
  SYNC_START: true,
  SYNC_PROGRESS: true,
  SYNC_DONE: true,
  SYNC_ERROR: true,
  LIST_REQUEST: true,
  LIST_RESULT: true,
  SCRAPE_REQUEST: true,
  SCRAPE_RESULT: true,
};

const MESSAGE_TYPES = new Set<ExtensionMessage["type"]>(
  Object.keys(MESSAGE_TYPE_PRESENCE) as ExtensionMessage["type"][],
);

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown };
  return (
    typeof candidate.type === "string" &&
    MESSAGE_TYPES.has(candidate.type as ExtensionMessage["type"])
  );
}
