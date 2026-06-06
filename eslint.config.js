import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

// Bans bare (non-relative) module specifiers via an AST selector, EXCEPT the
// WXT framework family (`wxt`, `wxt/*`, `@wxt-dev/*`). A relative import source
// begins with "."; a third-party / absolute specifier does not. The WXT define
// utilities (e.g. `wxt/utils/define-content-script`) are the only sanctioned
// non-relative imports in a content entry -- they are part of the framework
// runtime that the isolation gate already allowlists. `#imports` stays banned
// so a content script never pulls the WXT barrel (and @wxt-dev/browser) in.
const BARE_SPECIFIER = "[source.value=/^(?!\\.|wxt\\/|wxt$|@wxt-dev\\/)./]";
const CONTENT_IMPORT_MESSAGE =
  "Content scripts may import only chrome.* globals, the wxt define utilities, " +
  "and local src/lib modules (relative paths); no other third-party packages " +
  "and no #imports. Type-only imports are allowed.";

export default tseslint.config(
  {
    ignores: [".output/**", ".wxt/**", "node_modules/**", "coverage/**", "src/assets/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions },
    },
    rules: {
      // TypeScript resolves identifiers; the core rule double-reports globals.
      "no-undef": "off",
      // The sanctioned console sink is src/lib/logger.ts (override below).
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Type-aware linting scoped to the extension entrypoints and library
    // source. Catches floating promises -- e.g. an unawaited MV3 chrome.* call
    // such as chrome.alarms.create -- which would otherwise fail silently. Type
    // info comes from the chrome-typed root project (./tsconfig.json).
    files: ["entrypoints/**/*.ts", "src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    // Privacy invariant (CI-enforced): content scripts execute in an isolated
    // world over the page and MUST stay free of third-party runtime code. They
    // may import only chrome.* globals (ambient), the wxt define utilities, and
    // local modules under src/lib/** via relative paths. Banning every other
    // bare (non-relative) value specifier keeps packages such as @sentry/* and
    // zod out of the content-script bundle. Type-only imports (importKind
    // 'type') are erased at build and carry zero runtime weight, so they are
    // exempt -- this is what lets a content script reference schema-shaped types
    // without pulling the zod runtime. Value imports, dynamic import(), and
    // re-exports from bare specifiers stay banned because each can emit runtime
    // code. The in-build content-isolation gate is the second line of defense.
    files: ["entrypoints/*.content/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportDeclaration[importKind!='type']${BARE_SPECIFIER}`,
          message: CONTENT_IMPORT_MESSAGE,
        },
        { selector: `ImportExpression${BARE_SPECIFIER}`, message: CONTENT_IMPORT_MESSAGE },
        { selector: `ExportNamedDeclaration${BARE_SPECIFIER}`, message: CONTENT_IMPORT_MESSAGE },
        { selector: `ExportAllDeclaration${BARE_SPECIFIER}`, message: CONTENT_IMPORT_MESSAGE },
      ],
    },
  },
  {
    files: ["src/lib/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Node-run build tooling and config: console / process are their channels.
    files: ["scripts/**/*.{js,mjs,cjs,ts}", "wxt.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
    },
  },
);
