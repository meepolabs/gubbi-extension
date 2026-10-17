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
// chat_messages can hold every branch of an edited or retried thread. The
// active thread is the path from current_leaf_message_uuid up through
// parent_message_uuid. The root's parent is a sentinel uuid that matches no
// message, so a parent absent from chat_messages ends the walk; the path is
// only accepted when it ends at the lowest-index message, otherwise a missing
// node cut it short. The server appends unseen message ids and never deletes,
// so a wrong or partial path is permanent: every doubt returns null (drift).
// With no leaf at all, chat_messages is taken in `index` order.
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
  uuid?: string;
  parent_message_uuid?: string | null;
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
  current_leaf_message_uuid?: string | null;
  chat_messages?: unknown;
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

function toMessage(message: RawChatMessage, messageId: string): MessagePayload | null {
  const role = mapSender(message.sender);
  if (role === null) return null;

  const content = renderMessageText(message);
  if (content.length === 0) return null;

  // created_at is already an ISO string; pass it through only if it parses.
  const createdAt = message.created_at;
  const timestamp =
    typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)) ? createdAt : null;
  return timestamp === null
    ? { role, content, message_id: messageId }
    : { role, content, message_id: messageId, timestamp };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A message must be an object, and so must every entry of its content[] when
// that is an array.
function isRawChatMessage(value: unknown): value is RawChatMessage {
  if (!isPlainObject(value)) return false;
  const content = value.content;
  return !Array.isArray(content) || content.every(isPlainObject);
}

// Null (drift) when any entry is malformed: dropping it could cut the thread.
function orderedMessages(conv: RawConversation): RawChatMessage[] | null {
  const raw: unknown[] = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
  if (!raw.every(isRawChatMessage)) return null;
  // Sort by `index` ascending; messages without an index keep relative order
  // after those that have one (treated as +Infinity).
  return [...raw].sort((a, b) => indexOf(a) - indexOf(b));
}

function indexOf(message: RawChatMessage): number {
  return typeof message.index === "number" ? message.index : Number.POSITIVE_INFINITY;
}

type IdentifiedMessage = RawChatMessage & { uuid: string };

function hasUuid(message: RawChatMessage): message is IdentifiedMessage {
  return typeof message.uuid === "string";
}

// Null when two messages share a uuid: the leaf walk and the server's per-id
// merge would both be ambiguous.
function indexByUuid(messages: IdentifiedMessage[]): Map<string, IdentifiedMessage> | null {
  const byUuid = new Map<string, IdentifiedMessage>();
  for (const message of messages) {
    if (byUuid.has(message.uuid)) return null;
    byUuid.set(message.uuid, message);
  }
  return byUuid;
}

function parentOf(
  message: IdentifiedMessage,
  byUuid: Map<string, IdentifiedMessage>,
): IdentifiedMessage | undefined {
  const parent = message.parent_message_uuid;
  return typeof parent === "string" ? byUuid.get(parent) : undefined;
}

function walkFromLeaf(
  leaf: IdentifiedMessage,
  ordered: IdentifiedMessage[],
  byUuid: Map<string, IdentifiedMessage>,
): IdentifiedMessage[] | null {
  const path: IdentifiedMessage[] = [];
  const seen = new Set<string>();
  const maxHops = ordered.length + 1;
  let cursor: IdentifiedMessage | undefined = leaf;
  while (cursor !== undefined) {
    if (seen.has(cursor.uuid) || path.length >= maxHops) return null;
    seen.add(cursor.uuid);
    path.push(cursor);
    cursor = parentOf(cursor, byUuid);
  }
  if (path[path.length - 1] !== ordered[0]) return null;
  return path.reverse();
}

// Root-first active thread, or null (drift) when it cannot be trusted. Every
// message must carry a uuid, since each one is sent as its message_id.
function activeThread(conv: RawConversation): IdentifiedMessage[] | null {
  const ordered = orderedMessages(conv);
  if (ordered === null || !ordered.every(hasUuid)) return null;
  const byUuid = indexByUuid(ordered);
  if (byUuid === null) return null;

  const leafUuid = conv.current_leaf_message_uuid;
  if (leafUuid === undefined || leafUuid === null) return ordered;
  if (typeof leafUuid !== "string") return null;
  const leaf = byUuid.get(leafUuid);
  if (leaf === undefined) return null;
  return walkFromLeaf(leaf, ordered, byUuid);
}

function collectMessages(thread: IdentifiedMessage[]): MessagePayload[] {
  const messages: MessagePayload[] = [];
  for (const rawMessage of thread) {
    const message = toMessage(rawMessage, rawMessage.uuid);
    if (message !== null) messages.push(message);
  }
  return messages;
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

    const thread = activeThread(conv);
    if (thread === null) return null;
    const messages = collectMessages(thread);
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
