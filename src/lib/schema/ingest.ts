import { z } from "zod";

// Mirror of gubbi/gubbi/api/v1/ingest.py -- keep in sync.
//
// These schemas are the wire contract for POST /api/v1/ingest/conversations.
// Field names, enums, and bounds must match the backend Pydantic models
// exactly; a drift here silently produces requests the API rejects.

// Matches MAX_CONVERSATIONS_PER_REQUEST in the backend ingest module.
export const MAX_CONVERSATIONS_PER_REQUEST = 50;

// Upper bound on platform_id and message_id, in code points (the backend
// counts code points; zod's .max counts UTF-16 units, so an astral character
// would count twice there).
const EXTERNAL_ID_MAX_CODE_POINTS = 512;

function isBoundedWellFormedId(value: string): boolean {
  if (!value.isWellFormed()) {
    return false;
  }
  const codePoints = [...value].length;
  return codePoints >= 1 && codePoints <= EXTERNAL_ID_MAX_CODE_POINTS;
}

const ExternalIdSchema = z.string().refine(isBoundedWellFormedId, {
  message: `must be 1-${EXTERNAL_ID_MAX_CODE_POINTS} code points of well-formed text`,
});

// zod's datetime admits year 0000, which the backend rejects. A timestamp with
// no offset is treated as UTC by the backend.
const TimestampSchema = z.iso
  .datetime({ offset: true, local: true })
  .refine((value) => !value.startsWith("0000-"), { message: "year must be 0001 or later" });

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
  message_id: ExternalIdSchema.nullable().optional(),
  timestamp: TimestampSchema.nullable().optional(),
});

export const ConversationPayloadSchema = z.object({
  platform: PlatformSchema,
  platform_id: ExternalIdSchema,
  title: z.string().default(""),
  created_at: TimestampSchema,
  updated_at: TimestampSchema.nullable().optional(),
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

// Normalized alias used by the connector adapters. A collected conversation is
// exactly the ingest ConversationPayload shape, ready to batch and upload.
export type NormalizedConversation = ConversationPayload;
