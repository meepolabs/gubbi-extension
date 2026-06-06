import type { AdapterPlatform, ConversationNormalizer } from "./base";
import { ChatGptNormalizer } from "./chatgpt/normalize";
import { ClaudeNormalizer } from "./claude/normalize";

// Background-side registry mapping each platform to its normalizer. This module
// imports the normalizers (which import the Zod schema runtime), so it is
// BACKGROUND/LIB ONLY and must never be reached from a content script.

export type NormalizerRegistry = Record<AdapterPlatform, ConversationNormalizer>;

export const NORMALIZERS: NormalizerRegistry = {
  chatgpt: new ChatGptNormalizer(),
  claude: new ClaudeNormalizer(),
};
