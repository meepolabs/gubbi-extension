import { describe, expect, it } from "vitest";

import { ConversationPayloadSchema } from "../../src/lib/schema/ingest";
import { ClaudeNormalizer } from "../../src/lib/connectors/claude/normalize";

import rawConversation from "../fixtures/raw-claude-conversation.json";

function cloneRaw(): Record<string, unknown> {
  return structuredClone(rawConversation) as Record<string, unknown>;
}

const normalizer = new ClaudeNormalizer();

describe("ClaudeNormalizer", () => {
  it("maps sender human to role user and assistant to assistant", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("maps a system sender to role system", () => {
    // Arrange
    const raw = cloneRaw();
    const messages = raw.chat_messages as Array<Record<string, unknown>>;
    messages[0]!.sender = "system";

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    expect(result.messages[0]!.role).toBe("system");
  });

  it("orders messages by their index field", () => {
    // Arrange: present the messages out of index order.
    const raw = cloneRaw();
    const messages = raw.chat_messages as unknown[];
    raw.chat_messages = [messages[1], messages[0]];

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[1]!.role).toBe("assistant");
  });

  it("drops a tool_use content block entirely (no fold prefix, no marker)", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: only the text block of the assistant message survives.
    const assistant = result.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).not.toContain("[tool:");
    expect(assistant.content).toBe("Start with three short essays, then one novel.");
  });

  it("drops attachments and files entirely (no marker, no extracted content)", () => {
    // Arrange: msg-1 carries an attachment (notes.txt) and a file (diagram.png).
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: just the user's text, no "[attachment: ...]" marker and no leak of
    // the attachment's extracted_content.
    const user = result.messages.find((m) => m.role === "user")!;
    expect(user.content).toBe("Can you help me plan a short reading list?");
    expect(user.content).not.toContain("[attachment:");
    expect(user.content).not.toContain("SECRET extracted body");
  });

  it("drops thinking blocks while keeping the resulting text", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: the assistant text survives; the thinking field does not.
    const assistant = result.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toContain("Start with three short essays, then one novel.");
    expect(assistant.content).not.toContain("Consider essays then a novel");
  });

  it("normalizes a thinking-tool-text assistant message to just the text", () => {
    // Arrange: content is [thinking, tool_use, text], no legacy flat text.
    const raw = cloneRaw();
    const messages = raw.chat_messages as Array<Record<string, unknown>>;
    delete messages[1]!.text;
    messages[1]!.content = [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "tool_use", name: "web_search", text: "" },
      { type: "text", text: "answer" },
    ];

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    const assistant = result.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("answer");
  });

  it("drops an artifact block entirely (no fenced rendering)", () => {
    // Arrange: assistant content is [artifact, text].
    const raw = cloneRaw();
    const messages = raw.chat_messages as Array<Record<string, unknown>>;
    delete messages[1]!.text;
    messages[1]!.content = [
      {
        type: "artifact",
        name: "snippet.py",
        language: "python",
        content: "print('hi')",
      },
      { type: "text", text: "Here is your snippet." },
    ];

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: only the text survives; no artifact label, fence, or body.
    const assistant = result.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("Here is your snippet.");
    expect(assistant.content).not.toContain("snippet.py");
    expect(assistant.content).not.toContain("print('hi')");
    expect(assistant.content).not.toContain("```");
  });

  it("drops a content[]-present message with only non-text blocks even when flat text exists", () => {
    // Arrange: assistant has thinking + tool_use blocks and content[] IS present,
    // while the legacy flat `text` is left intact. Strict text-only must NOT fall
    // back to flat text when content[] exists -- the message must still drop.
    const raw = cloneRaw();
    const messages = raw.chat_messages as Array<Record<string, unknown>>;
    messages[1]!.content = [
      { type: "thinking", thinking: "only internal reasoning" },
      { type: "tool_use", name: "web_search", text: "" },
    ];

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: only the user message remains; flat text on the assistant ("Sure,
    // here is a plan.") must not have rescued the non-text-only message.
    expect(messages[1]!.text).toBe("Sure, here is a plan.");
    expect(result.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps a message via the legacy flat text fallback when content[] is absent", () => {
    // Arrange: assistant has NO content field at all, only the legacy flat text.
    const raw = cloneRaw();
    const messages = raw.chat_messages as Array<Record<string, unknown>>;
    delete messages[1]!.content;

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert: the assistant message survives via the flat-text legacy path.
    const assistant = result.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("Sure, here is a plan.");
  });

  it("passes through an already-ISO created_at timestamp on each message", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    expect(result.created_at).toBe("2026-06-05T09:00:00.000000Z");
    expect(result.messages[1]!.timestamp).toBe("2026-06-05T09:15:00.000000Z");
  });

  it("falls back to the flat text field when content blocks are absent", () => {
    // Arrange
    const raw = cloneRaw();
    const messages = raw.chat_messages as Array<Record<string, unknown>>;
    delete messages[0]!.content;

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    const user = result.messages.find((m) => m.role === "user")!;
    expect(user.content).toContain("Can you help me plan a short reading list?");
  });

  it("produces output that passes the ingest ConversationPayload schema", () => {
    // Arrange
    const raw = cloneRaw();

    // Act
    const result = normalizer.normalizeConversation(raw);

    // Assert
    expect(ConversationPayloadSchema.safeParse(result).success).toBe(true);
  });

  it("returns null when created_at is missing (malformed, required field)", () => {
    // Arrange
    const raw = cloneRaw();
    delete raw.created_at;

    // Act
    const result = normalizer.normalizeConversation(raw);

    // Assert
    expect(result).toBeNull();
  });

  it("returns null when there are zero usable messages", () => {
    // Arrange
    const raw = cloneRaw();
    raw.chat_messages = [];

    // Act
    const result = normalizer.normalizeConversation(raw);

    // Assert
    expect(result).toBeNull();
  });

  it("drops messages whose sender is unknown", () => {
    // Arrange
    const raw = cloneRaw();
    const messages = raw.chat_messages as Array<Record<string, unknown>>;
    messages[0]!.sender = "system_bot";

    // Act
    const result = normalizer.normalizeConversation(raw)!;

    // Assert
    expect(result.messages.map((m) => m.role)).toEqual(["assistant"]);
  });
});
