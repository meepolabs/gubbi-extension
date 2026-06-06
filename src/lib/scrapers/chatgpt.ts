import type { ConversationSummary, LLMPlatformAdapter, NormalizedConversation } from "./base";

// ChatGPT (chatgpt.com) platform adapter.
//
// TODO(phase-1b): implement against the chatgpt.com same-origin endpoints. The
// scraping runs inside the content script; this adapter is the typed surface
// the background sync loop drives.
export class ChatGptAdapter implements LLMPlatformAdapter {
  readonly platform = "chatgpt" as const;

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
