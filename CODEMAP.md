# CODEMAP -- gubbi-extension

> Module-level navigation for this repo. File-by-file detail lives in the
> code; this answers "what is here, what are the modules, what do they
> import." Setup, the privacy invariant, and the content-isolation gate are
> in [`README.md`](./README.md).

## What it is

A browser extension (Chrome + Firefox, MV3) that imports a user's own
ChatGPT and Claude conversation history into their gubbi journal. It reads
each platform's conversation API from a logged-in tab (the user's existing
session, no credentials handled), normalizes the messages to plain text,
and uploads them to the hosted gubbi ingest API. Public, AGPL-3.0.

## Where it fits

A client of the hosted product. It depends on two public endpoints and no
private code:

- **Ingest API** (`api.gubbi.ai/v1/ingest/conversations`) -- receives
  batches of normalized conversations under a bearer access token. The wire
  shape is mirrored by a hand-maintained Zod schema here (this repo is
  standalone -- it cannot import the server's types).
- **OAuth server** (`auth.gubbi.ai`) -- OAuth2 authorization-code + PKCE
  pairing, token refresh (rotating refresh tokens), and revoke. The
  extension holds opaque access/refresh tokens and presents the access
  token as a bearer credential to the ingest API.

The companion data-plane server (the ingest + extraction service) is the
public `gubbi` sibling repo; the extension never imports it, only calls its
HTTP surface.

## Modules

All runtime code is background-only unless noted. Content scripts run in an
isolated world over the page and may hold no third-party runtime code (see
the privacy invariant in the README); the build enforces this.

| Path | Purpose |
|---|---|
| `src/lib/auth/` | OAuth "redirect-flow" pairing + token lifecycle. `pkce` (S256 verifier/challenge), `authorize-url`, `launch` (the browser identity redirect driver), `exchange` (code -> tokens), `refresh` (rotation-safe refresh), `revoke`, `provider` (the `TokenProvider` implementation: cached-or-refresh + force-refresh), `startup` (reconciles an interrupted refresh), `config`, `errors`, `token-body` (shared token-response parser), `index`. |
| `src/lib/sync/` | `collect` drives one platform tab through list -> per-conversation fetch -> normalize and returns a typed outcome (ok / rate-limited / failed). `orchestrator` runs the sync under a single-flight lease: finds a tab, collects, uploads in capped batches, advances a per-platform cursor only after a confirmed save, and maps every failure to a typed pause/backoff or a reconnect. |
| `src/lib/connectors/` | Per-platform adapters. `*/fetch` (content-side raw reads via the page session), `*/normalize` (background-side Zod normalization to the wire schema), `base` (the adapter interface), `registry`, `http`, `outcome` (raw-fetch outcome mapping), `content-listener` (the content-script message handler). |
| `src/lib/net/` | `fetch` -- the single egress chokepoint: a closed host-allowlist, https-only, redirect-blocking fetch wrapper for all extension-context network IO. `http-constants` -- shared HTTP status codes. |
| `src/lib/schema/` | `ingest` -- the Zod wire schema mirroring the ingest API request/response (the contract boundary). |
| `src/lib/` (root) | `storage` (typed `chrome.storage.local` wrapper; every blob is schema-validated, corrupt = absent; holds the auth blob, refresh marker, per-platform cursor/pause-state/counters, status, and a content-free event ring buffer), `messages` (the background <-> content <-> popup discriminated-union envelope + guard), `locks` (`withStorageLock`: heartbeated, owner-checked, stale-takeover -- wraps both the auth lock and the sync lease), `token-provider` (the interface the upload client depends on, so it never imports `auth/`), `api` (the typed ingest upload client), `logger`. |
| `scripts/` | `content-isolation` (in-build Rollup gate: fails if any third-party module is reachable from a content bundle), `verify-manifest` (post-build manifest + egress-allowlist assertions). |

## Entry points

- `entrypoints/background.ts` -- the service worker. On every cold start it
  reconciles any interrupted token refresh before doing token work; a 30-min
  alarm and a manual "sync now" message both drive the sync orchestrator; it
  answers status queries for the popup.
- `entrypoints/chatgpt.content/`, `entrypoints/claude.content/` -- the
  isolated-world content scripts that perform the platform reads on request.
- `entrypoints/popup/`, `entrypoints/options/` -- the user-facing UI
  (plain TS + HTML). Currently scaffolding; the full UI is a later phase.

## Cross-repo deps

- The hosted **ingest API** and **OAuth server** (HTTP only -- see "Where it
  fits"). No code dependency; the wire contract is mirrored by the local Zod
  schema.
- No shared packages. This repo is intentionally standalone so the
  cookie-touching client is independently auditable.

## Deeper docs

- [`README.md`](./README.md) -- the privacy invariant, content-script
  isolation (the ESLint ban + the in-build Rollup gate), the WXT toolchain,
  dev setup, and build-time configuration.
