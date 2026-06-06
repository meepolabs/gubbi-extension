# gubbi-extension

Cross-browser MV3 extension for [gubbi](https://gubbi.ai): it turns your AI
chats into a searchable, structured diary by syncing conversations from ChatGPT
(chatgpt.com) and Claude (claude.ai) to your gubbi account. It builds for both
Chrome and Firefox as Manifest V3.

This repository is the extension skeleton (Phase 1, task 1). The ingest wire
schema, the outbound-fetch host guard, and the platform-adapter interface are
implemented for real; scrapers, sync orchestration, and UI are typed stubs that
throw `not implemented` and are filled in across later phases.

## License

AGPL-3.0-only. See [LICENSE](./LICENSE). The full, verbatim GNU Affero General
Public License v3 text governs use, modification, and distribution -- including
network use.

## Privacy invariant

The extension has exactly two classes of network egress, and nothing else:

1. **Extension-context calls** (background / popup / options) go only to the
   gubbi API host (`api.gubbi.ai`) and the auth issuer host (`auth.gubbi.ai`),
   or the hosts derived from `VITE_API_BASE_URL` / `VITE_AUTH_HOST`. Every such
   call is funneled through the host-whitelisting wrapper in
   `src/lib/net/fetch.ts`, whose `ALLOWED_HOSTS` is a closed allowlist; it
   throws on any other host, on a non-HTTPS scheme, and on any redirect
   (`redirect: "error"`).
2. **Content-script same-origin reads** of `chatgpt.com` and `claude.ai` -- the
   pages the user is already on. These do not use the fetch guard because they
   are same-origin.

### Content-script isolation

Content scripts execute in an isolated world over the page and handle raw
conversation data, so they MUST contain zero third-party runtime code (no
analytics, no SDKs that could change egress). The architecture keeps them thin:
a content script does a same-origin fetch and returns RAW platform JSON to the
background context via messages; ALL normalization and Zod validation happen in
the background / lib context, never in a content script.

This boundary is enforced two ways, both CI gates:

- **`pnpm lint`** -- an ESLint rule on `entrypoints/*.content/**` bans every
  non-relative _value_ import, dynamic `import()`, and bare re-export, EXCEPT
  the WXT framework family (`wxt`, `wxt/*`, `@wxt-dev/*`) that WXT injects into
  every content bundle. `#imports` stays banned so a content script never pulls
  the WXT barrel in. Type-only imports (erased at build) are allowed, so a
  content script may reference schema-shaped types without pulling the zod
  runtime.
- **The in-build content-isolation gate** -- lint only sees source; a relative
  import there (e.g. `../../src/lib/foo`) can still transitively pull a package
  into the bundle. A Rollup plugin (`scripts/content-isolation.ts`, injected via
  WXT's `vite:build:extendConfig` hook) walks Rollup's module graph from each
  content-script entry during the build and fails the build if any reachable
  module resolves under `node_modules` EXCEPT the pinned `wxt` / `@wxt-dev/*`
  allowlist. The exact set of allowlisted wxt-internal modules is frozen per
  browser in `content-isolation/<browser>-mv3.snapshot.json`; a drift fails the
  build so an unexpected new wxt-internal import is caught in review.
  Regenerate intentionally with `WXT_ISOLATION_UPDATE=1`.

Host permissions are restricted to `https://chatgpt.com/*`,
`https://claude.ai/*`, `https://api.gubbi.ai/*`, and `https://auth.gubbi.ai/*`.
The extension requests `storage`, `alarms`, `scripting`, and `identity`; no
`cookies`, `webRequest`, `tabs`, or `<all_urls>` access.

## Toolchain: WXT

- **`wxt` 0.20.26** (the current stable line; builds on Vite 7)

Rationale:

- WXT generates the MV3 manifest from `wxt.config.ts` and per-entrypoint
  options, builds for Chrome and Firefox from one source, and provides the
  content-script runtime (`ContentScriptContext`).
- Manifest V3 is forced for both browsers via `manifestVersion: 3` plus `--mv3`
  on the Firefox CLI invocations. Chrome emits a `service_worker` background;
  Firefox emits a `background.scripts` event page.
- Auto-imports are disabled (`imports: false`) so every dependency is imported
  explicitly -- this preserves the content-script isolation discipline.

All dependencies are pinned to exact versions (`.npmrc` sets `save-exact=true`);
no caret/tilde ranges.

## Dev setup

Requires Node `>=20.19.0` and pnpm.

```sh
pnpm install        # installs deps; runs `wxt prepare` (generates .wxt/)
pnpm dev            # start the WXT dev server (Chrome) with HMR
pnpm dev:firefox    # WXT dev server targeting Firefox MV3
pnpm build          # production MV3 bundles -> .output/chrome-mv3 + firefox-mv3
pnpm zip            # packaged zips for both browsers
pnpm check          # type-check (tsc --noEmit, via .wxt/tsconfig)
pnpm lint           # eslint (includes the content-script import ban)
pnpm format         # prettier --write
pnpm test           # vitest run
pnpm verify         # check + lint + test + both builds + manifest assertions
```

The content-isolation gate runs inside `pnpm build` (and therefore `pnpm
verify`) for both browser outputs; `pnpm verify` additionally asserts both
manifests are MV3 with the expected background shape, permissions, host
permissions, and that the fetch allowlist is a subset of the host permissions.

Do not background the dev server; run `pnpm dev` in your own terminal.

### Load the extension

**Chrome:** `pnpm build`, open `chrome://extensions`, enable Developer mode,
click **Load unpacked**, and select `.output/chrome-mv3`.

**Firefox:** `pnpm build`, open `about:debugging#/runtime/this-firefox`, click
**Load Temporary Add-on**, and select `.output/firefox-mv3/manifest.json`.

### Build-time configuration

Public, non-secret client config is injected by Vite from `VITE_*` / `WXT_*`
environment variables. Copy `.env.example` to `.env.local` and adjust. No
secrets belong in any committed file.

- `VITE_API_BASE_URL` -- gubbi API base URL (default `https://api.gubbi.ai`).
- `VITE_AUTH_HOST` -- auth issuer host (default `auth.gubbi.ai`).
- `WXT_CHROME_KEY` -- Chrome `key` manifest field (omitted when unset; Chrome
  assigns a random dev ID). PUBLIC, but must be the real packaged key -- never
  commit a value.
- `WXT_GECKO_ID` -- Firefox add-on id (default placeholder
  `gubbi-extension@gubbi.ai`). A gecko id is permanent once published to AMO.

## Development hygiene

Run `pre-commit install` once to enable the local git hooks defined in
`.pre-commit-config.yaml`: prettier `--check`, eslint (`--max-warnings=0`), the
standard pre-commit-hooks set, and a `gitleaks` secret scan -- all on staged
files only. The whole-project type-check and the content-isolation build gate
stay in CI (`pnpm verify`), not in the hook, to keep commits fast.

```sh
pip install pre-commit   # or: brew install pre-commit
pre-commit install
```

Secret scanning (`gitleaks`, config in `.gitleaks.toml`) also runs in CI on
every push and pull request. Dependency updates are managed by Renovate
(`renovate.json`): weekly, grouped, and never auto-merged -- this project
deliberately lags package versions for supply-chain safety.

## Icons

`src/assets/icons/icon-{16,48,128}.png` are solid-color placeholders served from
the public root at `/icons/*`. Final brand icons land in Phase 4.

## Layout

```
wxt.config.ts             WXT config: manifest fn, imports:false, isolation hook
scripts/
  content-isolation.ts    in-build Rollup gate: no node_modules in content bundles
  verify-manifest.mjs      post-build manifest + egress-allowlist assertions
content-isolation/        committed per-browser wxt-internal allowlist snapshots
entrypoints/
  background.ts           background: sync alarm + message router (stub)
  chatgpt.content/        chatgpt.com content script (isolated world, stub)
  claude.content/         claude.ai content script (isolated world, stub)
  popup/                  read-only popup (index.html + main.ts, stub)
  options/                options page (index.html + main.ts, stub)
src/
  lib/
    schema/ingest.ts      Zod ingest wire schema (mirror of the backend)
    net/fetch.ts          host-whitelisting fetch wrapper (egress allowlist)
    scrapers/base.ts      LLMPlatformAdapter interface + registry type
    scrapers/*.ts         per-platform adapters (stubs)
    messages.ts           background <-> content <-> popup message union + guard
    storage.ts            typed chrome.storage.local wrapper
    api.ts                ingest API client (stub)
    logger.ts             structured console logger
  assets/icons            placeholder icons (served at /icons/*)
tests/                    vitest unit tests + fixtures
```
