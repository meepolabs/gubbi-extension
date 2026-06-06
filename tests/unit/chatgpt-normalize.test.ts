import { describe, expect, it } from "vitest";

import { ConversationPayloadSchema } from "../../src/lib/schema/ingest";
import { ChatGptNormalizer } from "../../src/lib/connectors/chatgpt/normalize";

import rawConversation from "../fixtures/raw-chatgpt-conversation.json";

// Deep-clone the shared fixture before mutating so each test arranges from a
// clean, independent copy.
function cloneRaw(): Record<string, unknown> {
  return structuredClone(rawConversation) as Record<string, unknown>;
}

const normalizer = new ChatGptNormalizer();

describe("ChatGptNormalizer", () => {
  it("walks the active-leaf chain and ignores the discarded regeneration branch", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw);

    // Assert
    expect(result).not.toBeNull();
    const contents = result!.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("This is the FIRST regenerated answer"))).toBe(false);
    expect(contents.some((c) => c.includes("the numbers are now sorted"))).toBe(true);
  });

  it("orders the surviving text turns chronologically root-first", () => {
    // Arrange
    const raw = cloneRaw();

    // Act: the active path is system -> user -> tool -> code -> assistant-text.
    // Only the text turns survive, in chronological order.
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("drops a tool-role node entirely (no fold prefix, no marker)", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: nothing from the python tool node survives.
    const contents = result.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("[tool:"))).toBe(false);
    expect(contents.some((c) => c.includes("sorted([3,1,2]"))).toBe(false);
  });

  it("drops a content_type:code node entirely (no fence, no text)", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: the code-typed assistant turn does not survive.
    const contents = result.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("def sort_nums"))).toBe(false);
    expect(contents.some((c) => c.includes("```"))).toBe(false);
  });

  it("keeps only the plain text of user / assistant / system turns", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    expect(result.messages.map((m) => m.content)).toEqual([
      "You are a helpful assistant.",
      "Sort these numbers for me please.",
      "Here you go: the numbers are now sorted in ascending order.",
    ]);
  });

  it("drops a multimodal_text content node rather than emitting a marker", () => {
    // Arrange: replace the final assistant turn with a multimodal_text block.
    const raw = cloneRaw();
    const mapping = raw.mapping as Record<string, { message?: { content?: unknown } }>;
    mapping["node-assistant-final"]!.message!.content = {
      content_type: "multimodal_text",
      parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://abc" }],
    };

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: no "[image]" / "[file]" marker; the turn simply vanishes.
    const contents = result.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("[image]"))).toBe(false);
    expect(contents.some((c) => c.includes("[file]"))).toBe(false);
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("converts an epoch-seconds create_time to an ISO-8601 string", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: 1717603200.5 epoch seconds -> 2024-06-05T16:00:00.500Z
    expect(result.created_at).toBe("2024-06-05T16:00:00.500Z");
    expect(result.updated_at).toBe(new Date(1717606800.25 * 1000).toISOString());
  });

  it("attaches a per-message ISO timestamp and null-skips create_time:null nodes", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: the system node has create_time null -> no timestamp field; the
    // user node has a numeric create_time -> an ISO timestamp.
    const system = result.messages.find((m) => m.role === "system")!;
    const user = result.messages.find((m) => m.role === "user")!;
    expect(system.timestamp).toBeUndefined();
    expect(user.timestamp).toBe(new Date(1717603260 * 1000).toISOString());
  });

  it("produces output that passes the ingest ConversationPayload schema", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw);

    // Assert
    expect(ConversationPayloadSchema.safeParse(result).success).toBe(true);
  });

  it("returns null when create_time is missing (malformed, required field)", () => {
    // Arrange
    const raw = cloneRaw();
    delete raw.create_time;

    // Act
    const result = normalizer.normalizeConversation(raw);

    // Assert
    expect(result).toBeNull();
  });

  it("returns null when no node carries renderable text", () => {
    // Arrange
    const raw = cloneRaw();
    raw.current_node = "node-root";

    // Act
    const result = normalizer.normalizeConversation(raw);

    // Assert
    expect(result).toBeNull();
  });

  it("returns null for a non-object input", () => {
    // Arrange / Act / Assert
    expect(normalizer.normalizeConversation(null)).toBeNull();
    expect(normalizer.normalizeConversation("not-json")).toBeNull();
  });
});
