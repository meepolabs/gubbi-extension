import type { ConversationNormalizer, NormalizedConversation } from "../base";
import { ConversationPayloadSchema, type MessagePayload, type Role } from "../../schema/ingest";

// Claude raw -> ConversationPayload normalizer. BACKGROUND/LIB ONLY -- imports
// the Zod schema runtime; never reached from a content script. Returns null
// (skip + count as drift) on a malformed conversation rather than throwing.
//
// The raw shape (verified live, structure-only):
//   { uuid, name, created_at (ISO string), updated_at, current_leaf_message_uuid,
//     chat_messages: [ { uuid, text, content: [...], sender, index, created_at,
//                        parent_message_uuid } ] }
// rendering_mode=messages returns the active thread already, so v1 trusts
// chat_messages in `index` order. Branching (current_leaf_message_uuid /
// parent_message_uuid) EXISTS and is reserved for a later milestone.
//
// TEXT-ONLY rule: journal only the plain text of content blocks of type "text"
// for messages whose sender maps to user / assistant / system. Every other
// block type (thinking, tool_use, tool_result, artifact, ...) and any
// attachments / files are dropped entirely -- no folding, no markers, no
// placeholders, and attachment content is never read.

interface RawContentBlock {
  type?: string;
  text?: string | null;
}

interface RawChatMessage {
  text?: string | null;
  content?: RawContentBlock[] | null;
  sender?: string;
  index?: number;
  created_at?: string | null;
}

interface RawConversation {
  uuid?: string;
  name?: string;
  created_at?: string | null;
  updated_at?: string | null;
  chat_messages?: RawChatMessage[];
}

const BLOCK_SEPARATOR = "\n";

// "human" -> "user"; "assistant" -> "assistant"; a "system" sender (should it
// ever appear) -> "system". Any other sender is dropped.
function mapSender(sender: string | undefined): Role | null {
  if (sender === "human") return "user";
  if (sender === "assistant") return "assistant";
  if (sender === "system") return "system";
  return null;
}

// Strict text-only: keep only content blocks of type "text" and emit their
// .text. Every other block type (thinking, tool_use, tool_result, artifact,
// ...) is dropped entirely -- no folding, no markers, no placeholders. Never
// throws on an unexpected block type; it simply contributes no text.
function renderBlock(block: RawContentBlock): string {
  if (block.type !== "text") return "";
  return typeof block.text === "string" ? block.text : "";
}

function renderBlocks(blocks: RawContentBlock[]): string {
  return blocks
    .map(renderBlock)
    .filter((piece) => piece.length > 0)
    .join(BLOCK_SEPARATOR);
}

// content[] is the source of truth. When it is present we trust renderBlocks
// fully: if it yields no text the message has no journalable text and must drop
// (we do NOT consult the legacy flat `text`, or a non-text-only message would
// survive and violate the text-only rule). The legacy flat `text` is used ONLY
// when content[] is absent / not an array.
function renderMessageText(message: RawChatMessage): string {
  if (Array.isArray(message.content)) return renderBlocks(message.content);
  return typeof message.text === "string" ? message.text : "";
}

function toMessage(message: RawChatMessage): MessagePayload | null {
  const role = mapSender(message.sender);
  if (role === null) return null;

  const content = renderMessageText(message);
  if (content.length === 0) return null;

  // created_at is already an ISO string; pass it through only if it parses.
  const createdAt = message.created_at;
  const timestamp =
    typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)) ? createdAt : null;
  return timestamp === null ? { role, content } : { role, content, timestamp };
}

function orderedMessages(conv: RawConversation): RawChatMessage[] {
  const messages = Array.isArray(conv.chat_messages) ? [...conv.chat_messages] : [];
  // Sort by `index` ascending; messages without an index keep relative order
  // after those that have one (treated as +Infinity).
  return messages.sort((a, b) => indexOf(a) - indexOf(b));
}

function indexOf(message: RawChatMessage): number {
  return typeof message.index === "number" ? message.index : Number.POSITIVE_INFINITY;
}

export class ClaudeNormalizer implements ConversationNormalizer {
  readonly platform = "claude" as const;

  normalizeConversation(raw: unknown): NormalizedConversation | null {
    if (!raw || typeof raw !== "object") return null;
    const conv = raw as RawConversation;

    const platformId = conv.uuid;
    if (typeof platformId !== "string" || platformId.length === 0) return null;

    const createdAt = conv.created_at;
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;

    const messages: MessagePayload[] = [];
    for (const rawMessage of orderedMessages(conv)) {
      const message = toMessage(rawMessage);
      if (message !== null) messages.push(message);
    }
    if (messages.length === 0) return null;

    const updatedAt = conv.updated_at;
    const candidate = {
      platform: "claude" as const,
      platform_id: platformId,
      title: typeof conv.name === "string" ? conv.name : "",
      created_at: createdAt,
      updated_at:
        typeof updatedAt === "string" && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : null,
      messages,
    };

    const result = ConversationPayloadSchema.safeParse(candidate);
    return result.success ? result.data : null;
  }
}
