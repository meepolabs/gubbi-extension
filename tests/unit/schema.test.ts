import { describe, expect, it } from "vitest";

import {
  IngestConversationRequestSchema,
  IngestConversationResponseSchema,
  MAX_CONVERSATIONS_PER_REQUEST,
} from "../../src/lib/schema/ingest";

import validRequest from "../fixtures/valid-chatgpt-request.json";
import validResponse from "../fixtures/valid-response.json";

// Deep-clone fixtures before mutating so each test arranges from a clean,
// independent copy (the imported JSON is shared module state).
function cloneRequest(): Record<string, unknown> {
  return structuredClone(validRequest) as Record<string, unknown>;
}

function firstConversation(payload: Record<string, unknown>): Record<string, unknown> {
  return (payload.conversations as Array<Record<string, unknown>>)[0]!;
}

function firstMessage(payload: Record<string, unknown>): Record<string, unknown> {
  return (firstConversation(payload).messages as Array<Record<string, unknown>>)[0]!;
}

function parseWithConversationField(field: string, value: unknown): boolean {
  const payload = cloneRequest();
  firstConversation(payload)[field] = value;
  return IngestConversationRequestSchema.safeParse(payload).success;
}

function parseWithMessageField(field: string, value: unknown): boolean {
  const payload = cloneRequest();
  firstMessage(payload)[field] = value;
  return IngestConversationRequestSchema.safeParse(payload).success;
}

const ASTRAL = "\u{1F600}";
const LONE_SURROGATE = "\uD83D";

const ACCEPTED_TIMESTAMPS: Array<[string, string]> = [
  ["Z suffix", "2026-06-05T12:00:00Z"],
  ["positive offset", "2026-06-05T12:00:00+05:30"],
  ["negative zero offset", "2026-06-05T12:00:00-00:00"],
  ["naive (treated as UTC)", "2026-06-05T12:00:00"],
  ["minutes only", "2026-06-05T12:00"],
  ["minutes only with Z suffix", "2026-06-05T12:00Z"],
  ["nine-digit fraction", "2026-06-05T12:00:00.123456789Z"],
  ["year 0001", "0001-01-01T00:00:00Z"],
  ["latest UTC instant", "9999-12-31T23:59:59.999999Z"],
  ["year 9999 pulled back inside by a positive offset", "9999-12-31T23:59:00+01:00"],
  ["year 0001 pushed forward by a negative offset", "0001-01-01T00:00:00-01:00"],
  ["naive year 9999 (never converted)", "9999-12-31T23:59:59"],
];

const REJECTED_TIMESTAMPS: Array<[string, unknown]> = [
  ["date only", "2026-06-05"],
  ["space separator", "2026-06-05 12:00:00Z"],
  ["lowercase t", "2026-06-05t12:00:00Z"],
  ["lowercase z", "2026-06-05T12:00:00z"],
  ["offset without colon", "2026-06-05T12:00:00+0530"],
  ["epoch integer", 1780000000],
  ["epoch string", "1780000000"],
  ["year 0000", "0000-06-05T12:00:00Z"],
  ["February 30", "2026-02-30T12:00:00Z"],
  ["hour 24", "2026-06-05T24:00:00Z"],
  ["second 60", "2026-06-05T12:00:60Z"],
  ["past year 9999 once converted to UTC", "9999-12-31T23:59:00-01:00"],
  ["before year 0001 once converted to UTC", "0001-01-01T00:00:00+01:00"],
];

describe("IngestConversationRequestSchema", () => {
  it("parses a valid extension_chatgpt ingest request", () => {
    // Arrange
    const payload = cloneRequest();

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(true);
  });

  it("rejects a message role of tool", () => {
    // Arrange
    const payload = cloneRequest();
    const conversations = payload.conversations as Array<{ messages: Array<{ role: string }> }>;
    conversations[0]!.messages[0]!.role = "tool";

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(false);
  });

  it("rejects a conversation platform of gemini", () => {
    // Arrange
    const payload = cloneRequest();
    const conversations = payload.conversations as Array<{ platform: string }>;
    conversations[0]!.platform = "gemini";

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(false);
  });

  it("rejects a conversation with zero messages", () => {
    // Arrange
    const payload = cloneRequest();
    const conversations = payload.conversations as Array<{ messages: unknown[] }>;
    conversations[0]!.messages = [];

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(false);
  });

  it("rejects a conversation missing created_at", () => {
    // Arrange
    const payload = cloneRequest();
    const conversations = payload.conversations as Array<Record<string, unknown>>;
    delete conversations[0]!.created_at;

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(false);
  });

  it("rejects a request with more than the per-batch conversation cap", () => {
    // Arrange
    const base = cloneRequest();
    const template = (base.conversations as unknown[])[0];
    const overCap = MAX_CONVERSATIONS_PER_REQUEST + 1;
    const payload = {
      source: base.source,
      conversations: Array.from({ length: overCap }, () => structuredClone(template)),
    };

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(false);
  });

  it("rejects a malformed message timestamp", () => {
    // Arrange
    const payload = cloneRequest();
    const conversations = payload.conversations as Array<{
      messages: Array<Record<string, unknown>>;
    }>;
    conversations[0]!.messages[0]!.timestamp = "not-a-timestamp";

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(false);
  });
});

describe("ingest timestamps", () => {
  it.each(ACCEPTED_TIMESTAMPS)("created_at accepts %s", (_name, value) => {
    expect(parseWithConversationField("created_at", value)).toBe(true);
  });

  it.each(REJECTED_TIMESTAMPS)("created_at rejects %s", (_name, value) => {
    expect(parseWithConversationField("created_at", value)).toBe(false);
  });

  it.each([
    [
      "updated_at accepts a valid timestamp",
      "conversation",
      "updated_at",
      "2026-06-05T12:00:00+05:30",
      true,
    ],
    ["updated_at accepts null", "conversation", "updated_at", null, true],
    ["updated_at rejects year 0000", "conversation", "updated_at", "0000-06-05T12:00:00Z", false],
    [
      "message timestamp accepts a valid timestamp",
      "message",
      "timestamp",
      "2026-06-05T12:00:00",
      true,
    ],
    ["message timestamp accepts null", "message", "timestamp", null, true],
    ["message timestamp rejects year 0000", "message", "timestamp", "0000-06-05T12:00:00Z", false],
  ] as Array<[string, "conversation" | "message", string, unknown, boolean]>)(
    "%s",
    (_name, level, field, value, expected) => {
      const parse = level === "conversation" ? parseWithConversationField : parseWithMessageField;
      expect(parse(field, value)).toBe(expected);
    },
  );
});

describe("ingest id bounds", () => {
  it.each([
    [
      "platform_id accepts 512 astral characters",
      "conversation",
      "platform_id",
      ASTRAL.repeat(512),
      true,
    ],
    [
      "platform_id rejects 513 astral characters",
      "conversation",
      "platform_id",
      ASTRAL.repeat(513),
      false,
    ],
    ["platform_id rejects an empty string", "conversation", "platform_id", "", false],
    [
      "platform_id rejects a lone surrogate",
      "conversation",
      "platform_id",
      `abc${LONE_SURROGATE}`,
      false,
    ],
    ["message_id accepts 512 astral characters", "message", "message_id", ASTRAL.repeat(512), true],
    [
      "message_id rejects 513 astral characters",
      "message",
      "message_id",
      ASTRAL.repeat(513),
      false,
    ],
    ["message_id rejects an empty string", "message", "message_id", "", false],
    ["message_id rejects a lone surrogate", "message", "message_id", `abc${LONE_SURROGATE}`, false],
    ["message_id accepts null", "message", "message_id", null, true],
    ["rejects a lone high surrogate at the end", "message", "message_id", "abc\uD83D", false],
    [
      "rejects a high surrogate followed by a non-surrogate",
      "message",
      "message_id",
      "\uD83Dabc",
      false,
    ],
    ["rejects a lone low surrogate at the start", "message", "message_id", "\uDE00abc", false],
    ["accepts a valid surrogate pair", "message", "message_id", "a\uD83D\uDE00b", true],
    [
      "rejects a low surrogate followed by a high surrogate",
      "message",
      "message_id",
      "\uDE00\uD83D",
      false,
    ],
  ] as Array<[string, "conversation" | "message", string, unknown, boolean]>)(
    "%s",
    (_name, level, field, value, expected) => {
      const parse = level === "conversation" ? parseWithConversationField : parseWithMessageField;
      expect(parse(field, value)).toBe(expected);
    },
  );

  it("accepts a message with no message_id", () => {
    // Arrange
    const payload = cloneRequest();
    delete firstMessage(payload).message_id;

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(true);
  });

  it("keeps message_id on the parsed payload", () => {
    // Arrange
    const payload = cloneRequest();
    firstMessage(payload).message_id = "msg-1";

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(true);
    expect(result.data?.conversations[0]?.messages[0]?.message_id).toBe("msg-1");
  });
});

describe("IngestConversationResponseSchema", () => {
  it("parses a valid response body with budget_exhausted true", () => {
    // Arrange
    const payload = structuredClone(validResponse);

    // Act
    const result = IngestConversationResponseSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budget_exhausted).toBe(true);
    }
  });
});
