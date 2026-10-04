import { defineContentScript } from "wxt/utils/define-content-script";

import { makeContentMessageListener } from "../../src/lib/connectors/content-listener";
import { ChatGptFetcher } from "../../src/lib/connectors/chatgpt/fetch";

// ChatGPT content script (chatgpt.com).
//
// CONTENT-SCRIPT ISOLATION (CI-enforced): runs in an isolated world over the
// page and handles raw conversation data, so it MUST contain zero third-party
// runtime code. It imports only the wxt define utility and content-safe
// first-party modules (the listener factory + the ChatGptFetcher, neither of
// which pulls zod/schema). It does same-origin reads of chatgpt.com and returns
// RAW platform JSON to the background; ALL normalization + Zod validation happen
// in the background, never here. Ambient chrome.* only (no `browser`/#imports).

export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  runAt: "document_idle",
  world: "ISOLATED",
  main() {
    chrome.runtime.onMessage.addListener(
      makeContentMessageListener("chatgpt", new ChatGptFetcher()),
    );
  },
});
