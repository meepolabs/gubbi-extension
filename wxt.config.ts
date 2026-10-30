import { defineConfig } from "wxt";

import { CHROME_KEY, GECKO_ID } from "./scripts/browser-identity.mjs";
import { contentIsolationPlugin } from "./scripts/content-isolation";
import { hostPermissions } from "./scripts/host-permissions.mjs";

// WXT config. Targets Chrome and Firefox as MV3 (Firefox MV3 is forced via the
// `manifestVersion: 3` default below plus `--mv3` on the firefox CLI invocations
// in package.json). The previous CRXJS scaffold (manifest.config.ts +
// vite.config.ts + a standalone isolation script) has been removed.

// WXT loads .env* files only after this module is evaluated, so an env read at
// module level silently ignores .env.local; env reads belong inside the
// `manifest` function. The browser identities are committed constants, not env
// reads at all: a permanent identity must not be overridable.

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
      // Exactly the content hosts plus the API and auth hosts the egress
      // allowlist allows; an invalid VITE_* value throws and fails the build.
      host_permissions: hostPermissions(process.env),
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

    // Chrome (and Chromium family). `key` pins the extension ID across unpacked
    // and packed installs.
    return { ...base, key: CHROME_KEY };
  },

  // WXT has already loaded the .env* files into process.env with node:util
  // parseEnv. Vite's own env loader parses the same files with a looser
  // grammar, so letting it run could inline a VITE_* value the manifest never
  // saw; with envDir off, import.meta.env.VITE_* comes from process.env only.
  vite: () => ({ envDir: false }),

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
