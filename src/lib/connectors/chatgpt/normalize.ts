import type { ConversationNormalizer, NormalizedConversation } from "../base";
import {
  ConversationPayloadSchema,
  type MessagePayload,
  type Role,
} from "../../schema/ingest";

// ChatGPT raw -> ConversationPayload normalizer. BACKGROUND/LIB ONLY -- it
// imports the Zod schema runtime and must never be reached from a content
// script. Returns null (skip + count as drift) on any malformed conversation
// rather than throwing, so one bad conversation cannot abort a sync run.
//
// The raw shape (verified live, structure-only):
//   { conversation_id, title, create_time (epoch seconds, float), update_time,
//     current_node, mapping: { <nodeId>: { id, message, parent, children } } }
// A node.message may be null (root/empty nodes). The ACTIVE LEAF is walked by
// following node.parent from current_node up to the root, then reversing to get
// chronological order -- this ignores sibling regeneration branches (v1).
//
// TEXT-ONLY rule: journal only the plain text of messages whose author.role is
// user / assistant / system AND whose content_type is "text". Everything else
// (tool turns, code / execution_output / multimodal_text content, ...) is
// dropped entirely -- no folding, no markers, no placeholders.

interface RawNode {
  id?: string;
  message?: RawMessage | null;
  parent?: string | null;
  children?: string[];
}

interface RawMessage {
  author?: { role?: string; name?: string | null };
  create_time?: number | null;
  content?: RawContent | null;
}

interface RawContent {
  content_type?: string;
  parts?: unknown[];
}

interface RawConversation {
  conversation_id?: string;
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string;
  mapping?: Record<string, RawNode>;
}

const MESSAGE_PART_SEPARATOR = "\n";

// Epoch seconds (float) -> ISO-8601 string. Null/invalid -> null.
function epochSecondsToIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : date.toISOString();
}

// ChatGPT author roles map straight onto the ingest Role enum. Any other role
// (notably "tool") is dropped -- only user / assistant / system turns are
// journaled.
function mapRole(rawRole: string | undefined): Role | null {
  switch (rawRole) {
    case "user":
    case "assistant":
    case "system":
      return rawRole;
    default:
      return null;
  }
}

// Strict text-only content: join the string parts of a content_type === "text"
// block with newlines. Any other content_type (code, execution_output,
// multimodal_text, tool, ...) yields no text and the message is dropped. Never
// throws on an unexpected part shape; non-string parts are ignored.
function renderTextContent(content: RawContent | null | undefined): string {
  if (!content || content.content_type !== "text") return "";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .filter((part): part is string => typeof part === "string")
    .join(MESSAGE_PART_SEPARATOR);
}

// Walks from current_node up through parents to the root, returning node ids in
// chronological (root-first) order. Bounded by mapping size to defend against a
// malformed parent cycle.
function activeLeafNodeIds(conv: RawConversation): string[] {
  const mapping = conv.mapping ?? {};
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = conv.current_node;
  const maxHops = Object.keys(mapping).length + 1;
  for (let hop = 0; hop < maxHops && cursor !== undefined; hop += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    ids.push(cursor);
    const node: RawNode | undefined = mapping[cursor];
    cursor = node?.parent ?? undefined;
  }
  return ids.reverse();
}

function nodeToMessage(node: RawNode | undefined): MessagePayload | null {
  const message = node?.message;
  if (!message) return null;
  const role = mapRole(message.author?.role);
  if (role === null) return null;
  const content = renderTextContent(message.content);
  if (content.length === 0) return null;
  const timestamp = epochSecondsToIso(message.create_time);
  return timestamp === null ? { role, content } : { role, content, timestamp };
}

function collectMessages(conv: RawConversation): MessagePayload[] {
  const mapping = conv.mapping ?? {};
  const messages: MessagePayload[] = [];
  for (const id of activeLeafNodeIds(conv)) {
    const message = nodeToMessage(mapping[id]);
    if (message !== null) messages.push(message);
  }
  return messages;
}

export class ChatGptNormalizer implements ConversationNormalizer {
  readonly platform = "chatgpt" as const;

  normalizeConversation(raw: unknown): NormalizedConversation | null {
    if (!raw || typeof raw !== "object") return null;
    const conv = raw as RawConversation;

    const platformId = conv.conversation_id;
    if (typeof platformId !== "string" || platformId.length === 0) return null;

    const createdAt = epochSecondsToIso(conv.create_time);
    if (createdAt === null) return null; // created_at is required by the schema.

    const messages = collectMessages(conv);
    if (messages.length === 0) return null;

    const candidate = {
      platform: "chatgpt" as const,
      platform_id: platformId,
      title: typeof conv.title === "string" ? conv.title : "",
      created_at: createdAt,
      updated_at: epochSecondsToIso(conv.update_time),
      messages,
    };

    const result = ConversationPayloadSchema.safeParse(candidate);
    return result.success ? result.data : null;
  }
}
