import { defineConfig } from "vitest/config";

// Standalone Vitest config. Unit tests cover the framework-agnostic src/lib
// modules, which use the ambient chrome.* globals (stubbed per-test) and
// import.meta.env -- they need no WXT build context, so this config does not
// load wxt.config.ts or the WXT vitest plugin.
export default defineConfig({
  // Matches the build (`envDir: false` in wxt.config.ts): a deployment's
  // .env.local must not change the endpoint hosts the unit tests assert.
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
