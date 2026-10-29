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

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

function isHighSurrogate(unit: number): boolean {
  return unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= LOW_SURROGATE_MIN && unit <= LOW_SURROGATE_MAX;
}

// String.prototype.isWellFormed needs Chrome 111+, and the manifest sets no
// minimum version, so the lone-surrogate check is done by hand.
function hasNoLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (isHighSurrogate(unit)) {
      if (i + 1 >= value.length || !isLowSurrogate(value.charCodeAt(i + 1))) {
        return false;
      }
      i++;
    } else if (isLowSurrogate(unit)) {
      return false;
    }
  }
  return true;
}

function isBoundedWellFormedId(value: string): boolean {
  if (!hasNoLoneSurrogate(value)) {
    return false;
  }
  const codePoints = [...value].length;
  return codePoints >= 1 && codePoints <= EXTERNAL_ID_MAX_CODE_POINTS;
}

const ExternalIdSchema = z.string().refine(isBoundedWellFormedId, {
  message: `must be 1-${EXTERNAL_ID_MAX_CODE_POINTS} code points of well-formed text`,
});

const WALL_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const NUMERIC_OFFSET = /([+-])(\d{2}):(\d{2})$/;

function minutesSinceEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getTime() / 60_000;
}

const MIN_UTC_MINUTE = minutesSinceEpoch(1, 1, 1, 0, 0);
const MAX_UTC_MINUTE = minutesSinceEpoch(9999, 12, 31, 23, 59);

// The backend converts an offset timestamp to UTC and rejects it when the
// result leaves years 0001-9999. Offsets are whole minutes, so seconds and
// fractions never move the instant across a minute boundary and comparing
// minutes is exact.
function staysInRangeAfterUtc(value: string): boolean {
  const offset = NUMERIC_OFFSET.exec(value);
  const wall = WALL_MINUTE.exec(value);
  if (!offset || !wall) {
    return true;
  }
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = wall.slice(1).map(Number);
  const sign = offset[1] === "-" ? -1 : 1;
  const offsetMinutes = sign * (Number(offset[2]) * 60 + Number(offset[3]));
  const utcMinute = minutesSinceEpoch(year, month, day, hour, minute) - offsetMinutes;
  return utcMinute >= MIN_UTC_MINUTE && utcMinute <= MAX_UTC_MINUTE;
}

// zod's datetime admits year 0000, which the backend rejects. A timestamp with
// no offset is treated as UTC by the backend. zod requires seconds once a `Z` or
// an offset is present, but the backend also accepts minute precision there, so
// the precision -1 branch admits that form.
const TimestampSchema = z
  .union([
    z.iso.datetime({ offset: true, local: true }),
    z.iso.datetime({ offset: true, local: true, precision: -1 }),
  ])
  .refine((value) => !value.startsWith("0000-"), { message: "year must be 0001 or later" })
  .refine(staysInRangeAfterUtc, {
    message: "must stay within years 0001-9999 once converted to UTC",
  });

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
