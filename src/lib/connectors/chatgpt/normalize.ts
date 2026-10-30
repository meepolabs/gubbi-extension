import type { ConversationNormalizer, NormalizedConversation } from "../base";
import { ConversationPayloadSchema, type MessagePayload, type Role } from "../../schema/ingest";

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
// chronological order -- this ignores sibling regeneration branches. Each
// message is sent with its node id as message_id.
//
// TEXT-ONLY rule: journal only the plain text of messages whose author.role is
// user / assistant / system AND whose content_type is "text". Everything else
// (tool turns, code / execution_output / multimodal_text content, ...) is
// dropped entirely -- no folding, no markers, no placeholders.

interface RawNode {
  id?: string;
  message?: RawMessage | null;
  parent?: unknown;
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
  mapping?: Record<string, unknown>;
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

interface PathNode {
  readonly id: string;
  readonly node: RawNode;
}

function isRawNode(value: unknown): value is RawNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// True when the mapping has exactly one node with an explicit `parent: null`
// and that node carries no message, the root shape of recorded payloads. With
// a single parent-null node, any walk that terminates ends at it.
function hasSingleEmptyRoot(mapping: Record<string, unknown>): boolean {
  let root: RawNode | null = null;
  for (const node of Object.values(mapping)) {
    if (!isRawNode(node) || node.parent !== null) continue;
    if (root !== null) return false;
    root = node;
  }
  return root !== null && (root.message === null || root.message === undefined);
}

// Walks from current_node up through parents to the root, returning the nodes in
// chronological (root-first) order. The server appends unseen message ids and
// never deletes, so a partial path would be permanent: the walk must end at the
// mapping's root (see hasSingleEmptyRoot). A cycle, a node missing from the
// mapping or not an object, a parent that is absent or not a string, a second
// `parent: null` node, a root carrying a message, or running past the mapping
// size returns null instead.
function activeLeafPath(conv: RawConversation): PathNode[] | null {
  const mapping: Record<string, unknown> = conv.mapping ?? {};
  if (!hasSingleEmptyRoot(mapping)) return null;
  const path: PathNode[] = [];
  const seen = new Set<string>();
  const maxHops = Object.keys(mapping).length + 1;
  let cursor: unknown = conv.current_node;
  if (typeof cursor !== "string") return null;
  while (cursor !== null) {
    if (typeof cursor !== "string") return null;
    if (seen.has(cursor) || path.length >= maxHops) return null;
    const node = Object.prototype.hasOwnProperty.call(mapping, cursor)
      ? mapping[cursor]
      : undefined;
    if (!isRawNode(node)) return null;
    seen.add(cursor);
    path.push({ id: cursor, node });
    cursor = node.parent;
  }
  return path.reverse();
}

function nodeToMessage(node: RawNode, nodeId: string): MessagePayload | null {
  const message = node.message;
  if (!message) return null;
  const role = mapRole(message.author?.role);
  if (role === null) return null;
  const content = renderTextContent(message.content);
  if (content.length === 0) return null;
  const timestamp = epochSecondsToIso(message.create_time);
  return timestamp === null
    ? { role, content, message_id: nodeId }
    : { role, content, message_id: nodeId, timestamp };
}

function collectMessages(conv: RawConversation): MessagePayload[] | null {
  const path = activeLeafPath(conv);
  if (path === null) return null;
  const messages: MessagePayload[] = [];
  for (const { id, node } of path) {
    const message = nodeToMessage(node, id);
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
    if (messages === null || messages.length === 0) return null;

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
