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

  it("accepts a Z-suffixed ISO created_at timestamp", () => {
    // Arrange
    const payload = cloneRequest();
    const conversations = payload.conversations as Array<Record<string, unknown>>;
    conversations[0]!.created_at = "2026-06-05T12:00:00Z";

    // Act
    const result = IngestConversationRequestSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(true);
  });

  it("rejects a malformed created_at timestamp", () => {
    // Arrange
    const payload = cloneRequest();
    const conversations = payload.conversations as Array<Record<string, unknown>>;
    conversations[0]!.created_at = "2026-06-05 12:00";

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
