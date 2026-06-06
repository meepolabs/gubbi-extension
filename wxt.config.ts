import { defineConfig } from "wxt";

import { contentIsolationPlugin } from "./scripts/content-isolation";

// WXT config. Targets Chrome and Firefox as MV3 (Firefox MV3 is forced via the
// `manifestVersion: 3` default below plus `--mv3` on the firefox CLI invocations
// in package.json). The previous CRXJS scaffold (manifest.config.ts +
// vite.config.ts + a standalone isolation script) has been removed.

// Public, env-injected manifest values. Read from process.env in the config
// (Node) rather than import.meta.env (bundle-only). All are non-secret.
//
// WXT_CHROME_KEY: Chrome's `key` field pins a stable extension ID across
// unpacked loads. It is PUBLIC but must be the real packaged key; it is never
// invented or committed here. When unset the field is omitted and Chrome
// assigns a random dev ID. See .env.example.
const CHROME_KEY = process.env.WXT_CHROME_KEY;

// Firefox add-on id. Placeholder until the real id is registered on AMO; a
// gecko id is permanent once published, so this stays a documented placeholder.
const GECKO_ID = process.env.WXT_GECKO_ID ?? "gubbi-extension@gubbi.ai";

const COMMON_HOST_PERMISSIONS = [
  "https://chatgpt.com/*",
  "https://claude.ai/*",
  "https://api.gubbi.ai/*",
  "https://auth.gubbi.ai/*",
];

export default defineConfig({
  // Disable ALL auto-imports: every dependency must be imported explicitly,
  // which preserves the content-script isolation discipline (no implicit
  // `browser` / framework globals leaking into a content bundle).
  imports: false,

  // Icons live under src/assets/icons; serving src/assets as the public root
  // copies them verbatim to /icons/* in every build output.
  srcDir: ".",
  publicDir: "src/assets",

  // Force MV3 for every target, including Firefox.
  manifestVersion: 3,

  manifest: ({ browser }) => {
    const base = {
      name: "gubbi -- sync ChatGPT and Claude to your diary",
      description: "Turn your AI chats into a searchable, structured diary.",
      // Content scripts are declared statically (defineContentScript ->
      // manifest content_scripts), so `scripting` is not needed. `identity` is
      // for the OAuth pairing flow (launchWebAuthFlow).
      permissions: ["storage", "alarms", "identity"],
      host_permissions: COMMON_HOST_PERMISSIONS,
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self'; base-uri 'self'",
      },
      icons: {
        16: "/icons/icon-16.png",
        48: "/icons/icon-48.png",
        128: "/icons/icon-128.png",
      },
    };

    if (browser === "firefox") {
      return {
        ...base,
        browser_specific_settings: {
          gecko: {
            id: GECKO_ID,
            strict_min_version: "121.0",
            // AMO requires data_collection_permissions for new submissions
            // (Firefox built-in data consent, effective 2025-11-03). The
            // extension transmits the user's AI chat messages to their own
            // gubbi account; chat messages are personalCommunications.
            // FOUNDER/LEGAL CONFIRM before AMO submission: data_collection categories.
            data_collection_permissions: { required: ["personalCommunications"] },
          },
        },
      };
    }

    // Chrome (and Chromium family). `key` is only emitted when provided.
    return CHROME_KEY ? { ...base, key: CHROME_KEY } : base;
  },

  hooks: {
    // Inject the content-isolation Rollup gate into every build step that
    // includes content-script entrypoints. The gate walks each content entry's
    // module graph and fails the build if any third-party (node_modules) code
    // outside the wxt / @wxt-dev allowlist is reachable.
    "vite:build:extendConfig": (entrypoints, viteConfig) => {
      const contentInputPaths = entrypoints
        .filter((entry) => entry.type === "content-script")
        .map((entry) => entry.inputPath);
      if (contentInputPaths.length === 0) return;
      viteConfig.plugins ??= [];
      viteConfig.plugins.push(contentIsolationPlugin({ contentInputPaths }));
    },
  },
});
