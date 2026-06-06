import { defineContentScript } from "wxt/utils/define-content-script";

import { logger } from "../../src/lib/logger";
import { isExtensionMessage, type ScrapeResultMessage } from "../../src/lib/messages";

// Claude content script (claude.ai). Skeleton only.
//
// Content-script isolation rule: this script runs in the page's world and
// handles raw conversation data, so it MUST contain zero third-party runtime
// code (CI-enforced by the eslint entrypoints/*.content/** rule and by the
// in-build content-isolation gate). It uses the ambient chrome.* globals only
// -- it must NOT import `browser` or anything from #imports, which would pull
// @wxt-dev/browser into the content bundle. It does a same-origin fetch of the
// page the user is on and returns RAW platform JSON to the background context
// via messages. ALL normalization and Zod validation happen in the background
// / lib context -- NEVER here. That is why the same-origin scrape does not use
// the net/fetch host guard and imports no schema runtime.
//
// TODO(phase-1b): implement the same-origin scrape of claude.ai here.

const PLATFORM = "claude" as const;

export default defineContentScript({
  matches: ["https://claude.ai/*"],
  runAt: "document_idle",
  world: "ISOLATED",
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isExtensionMessage(message) || message.type !== "SCRAPE_REQUEST") return false;
      logger.info("scrape request received (not implemented)", {
        platform: PLATFORM,
        conversationId: message.conversationId,
      });
      const response: ScrapeResultMessage = {
        type: "SCRAPE_RESULT",
        platform: PLATFORM,
        conversationId: message.conversationId,
        result: { ok: false, error: "not implemented" },
      };
      sendResponse(response);
      return false;
    });
  },
});
