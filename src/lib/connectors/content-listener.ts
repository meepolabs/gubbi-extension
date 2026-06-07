import { logger } from "../logger";
import {
  isExtensionMessage,
  type ListResultMessage,
  type ConversationResultMessage,
} from "../messages";
import type { AdapterPlatform, RawConversationFetcher } from "./base";
import { toListOutcome, toConversationOutcome } from "./outcome";

// Content-safe message-listener factory shared by both content scripts.
//
// CONTENT-SCRIPT ISOLATION: imported by content scripts -- no third-party
// runtime code (logger is first-party and zod-free; message/base imports are
// type-only or first-party). Ambient chrome.* only.
//
// The returned listener answers LIST_REQUEST / CONVERSATION_REQUEST for its own
// platform by driving the raw fetcher and returning RAW JSON via the envelope.
// It returns `true` to keep the message channel open for the async
// sendResponse, per the MV3 onMessage contract.

type SendResponse = (response: ListResultMessage | ConversationResultMessage) => void;

export function makeContentMessageListener(
  platform: AdapterPlatform,
  fetcher: RawConversationFetcher,
): (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean {
  return (message, _sender, sendResponse) => {
    if (!isExtensionMessage(message)) return false;

    if (message.type === "LIST_REQUEST" && message.platform === platform) {
      fetcher
        .listConversationsRaw(message.since)
        .then((raw) =>
          sendResponse({ type: "LIST_RESULT", platform, result: toListOutcome(raw) }),
        )
        .catch((e: unknown) => {
          logger.error("list request failed", { platform, error: String(e) });
          sendResponse({
            type: "LIST_RESULT",
            platform,
            result: { ok: false, reason: "transient_http" },
          });
        });
      return true;
    }

    if (message.type === "CONVERSATION_REQUEST" && message.platform === platform) {
      const { conversationId } = message;
      fetcher
        .fetchConversationRaw(conversationId)
        .then((raw) =>
          sendResponse({
            type: "CONVERSATION_RESULT",
            platform,
            conversationId,
            result: toConversationOutcome(raw),
          }),
        )
        .catch((e: unknown) => {
          logger.error("conversation request failed", { platform, error: String(e) });
          sendResponse({
            type: "CONVERSATION_RESULT",
            platform,
            conversationId,
            result: { ok: false, reason: "transient_http" },
          });
        });
      return true;
    }

    // DEFAULT CASE: any message this content script does not own -- an unknown
    // type (e.g. a STATUS_* or future type a newer background sends to an older
    // content script), or a LIST_/CONVERSATION_ request for a different platform
    // -- is ignored. Returning false (without throwing and without calling
    // sendResponse) tells the MV3 runtime this listener will not answer, so an
    // older content script survives a future message type rather than breaking.
    return false;
  };
}
