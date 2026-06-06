import type { ConversationSummary, LLMPlatformAdapter, NormalizedConversation } from "./base";

// Claude (claude.ai) platform adapter.
//
// TODO(phase-1b): implement against the claude.ai same-origin endpoints. The
// scraping runs inside the content script; this adapter is the typed surface
// the background sync loop drives.
export class ClaudeAdapter implements LLMPlatformAdapter {
  readonly platform = "claude" as const;

  async isSessionActive(): Promise<boolean> {
    throw new Error("not implemented");
  }

  async listConversations(_since?: string): Promise<ConversationSummary[]> {
    throw new Error("not implemented");
  }

  async fetchConversation(_id: string): Promise<NormalizedConversation> {
    throw new Error("not implemented");
  }
}
