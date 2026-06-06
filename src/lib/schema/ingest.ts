import { z } from "zod";

// Mirror of gubbi/gubbi/api/v1/ingest.py -- keep in sync.
//
// These schemas are the wire contract for POST /api/v1/ingest/conversations.
// Field names, enums, and bounds must match the backend Pydantic models
// exactly; a drift here silently produces requests the API rejects.

// Matches MAX_CONVERSATIONS_PER_REQUEST in the backend ingest module.
export const MAX_CONVERSATIONS_PER_REQUEST = 50;

// Upper bound on a conversation's platform_id (backend Field max_length).
const PLATFORM_ID_MAX_LENGTH = 512;

export const RoleSchema = z.enum(["user", "assistant", "system"]);

export const PlatformSchema = z.enum(["chatgpt", "claude"]);

export const IngestSourceSchema = z.enum([
  "extension_chatgpt",
  "extension_claude",
  "paste_memories",
  "zip_upload",
]);

export const MessagePayloadSchema = z.object({
  role: RoleSchema,
  content: z.string(),
  timestamp: z.iso.datetime().nullable().optional(),
});

export const ConversationPayloadSchema = z.object({
  platform: PlatformSchema,
  platform_id: z.string().min(1).max(PLATFORM_ID_MAX_LENGTH),
  title: z.string().default(""),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime().nullable().optional(),
  messages: z.array(MessagePayloadSchema).min(1),
});

export const IngestConversationRequestSchema = z.object({
  source: IngestSourceSchema,
  conversations: z.array(ConversationPayloadSchema).max(MAX_CONVERSATIONS_PER_REQUEST),
});

export const IngestConversationResponseSchema = z.object({
  conversations_saved: z.number().int(),
  conversations_skipped_dedupe: z.number().int(),
  extractions_enqueued: z.number().int(),
  extractions_skipped_budget: z.number().int(),
  extractions_skipped_error: z.number().int(),
  budget_exhausted: z.boolean(),
});

export type Role = z.infer<typeof RoleSchema>;
export type Platform = z.infer<typeof PlatformSchema>;
export type IngestSource = z.infer<typeof IngestSourceSchema>;
export type MessagePayload = z.infer<typeof MessagePayloadSchema>;
export type ConversationPayload = z.infer<typeof ConversationPayloadSchema>;
export type IngestConversationRequest = z.infer<typeof IngestConversationRequestSchema>;
export type IngestConversationResponse = z.infer<typeof IngestConversationResponseSchema>;

// Normalized aliases used by the connector adapters. A collected conversation is
// exactly the ingest ConversationPayload shape, ready to batch and upload.
export type NormalizedMessage = MessagePayload;
export type NormalizedConversation = ConversationPayload;
