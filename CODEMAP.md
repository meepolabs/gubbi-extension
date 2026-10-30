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
| `src/lib/auth/` | OAuth "redirect-flow" pairing + token lifecycle. `pkce` (S256 verifier/challenge), `authorize-url`, `launch` (the browser identity redirect driver), `exchange` (code -> tokens), `refresh` (rotation-safe refresh), `revoke` (unpair: best-effort revoke, then clears credentials and all account state even if the revoke fails), `provider` (the `TokenProvider` implementation: cached-or-refresh + force-refresh), `startup` (reconciles an interrupted refresh), `transition` (runs pair / unpair / recovery under the sync lease then the auth lock, or reports busy), `config`, `errors`, `token-body` (shared token-response parser), `index` (`pair` installs new credentials under those locks after sweeping the previous account's state, and refuses them as superseded if an unpair landed meanwhile). |
| `src/lib/sync/` | `collect` drives one platform tab through list -> per-conversation fetch -> normalize and returns a typed outcome (ok / rate-limited / failed); detail is fetched oldest first whatever the listing order, so a stopped run leaves an oldest prefix. `orchestrator` runs the sync under a single-flight lease: finds a tab, collects, uploads in batches capped by conversation count and serialized body size (a conversation too large for any request is dropped), advances a per-platform cursor only after a confirmed save, and maps every failure to a typed pause/backoff or a reconnect. A partial save holds the cursor for a bounded number of runs before committing anyway, and a conversation whose detail fetch keeps failing is skipped after a bounded number of stops; both are recorded as skipped. `timestamps` (zone-less timestamps read as UTC). |
| `src/lib/connectors/` | Per-platform adapters. `*/fetch` (content-side raw reads via the page session), `*/normalize` (background-side Zod normalization to the wire schema), `base` (the adapter interface), `registry`, `http` (content-safe same-origin GET with request pacing, a per-request deadline, and the single `parseRetryAfter`), `outcome` (raw-fetch outcome mapping), `content-listener` (the content-script message handler). Claude lists through the paged v2 endpoint (with a page cap) and syncs exactly one chat-capable organization, failing closed on none or several; ChatGPT adds an archived-chats list pass merged by id. |
| `src/lib/control/` | Background handling of the typed control messages the extension's own pages send. `schemas` (strict Zod union of control payloads), `sender` (honors only this extension's own pages, refusing content scripts and other extensions), `status` (builds the status snapshot field by field from persisted state), `handlers` (`handleControlMessage`: validates sender and payload, dispatches sync / pair / unpair / enable-toggle over injected deps, and builds every reply from enumerated fields). |
| `src/lib/net/` | `fetch` -- the single egress chokepoint: a closed host-allowlist, https-only, redirect-blocking fetch wrapper for all extension-context network IO, with a per-request deadline that also covers reading the body (callers get a buffered response). `endpoint-host` (plain `.mjs` + `.d.mts`) -- the one parser for the configured API and auth hosts (DNS names only, no port; an invalid value yields no host, so requests to it are blocked rather than defaulted), shared by `fetch`, `api`, `auth/config` and the build scripts (`scripts/host-permissions`, which the WXT config and the verifier use). `http-constants` -- shared HTTP status codes. |
| `src/lib/schema/` | `ingest` -- the Zod wire schema mirroring the ingest API request/response (the contract boundary). |
| `src/lib/` (root) | `storage` (typed `chrome.storage.local` wrapper; every blob is schema-validated, corrupt = absent; holds the auth blob, refresh marker, per-platform cursor/pause-state/counters/enabled flag/last-run time, status, the account generation, and a content-free event ring buffer), `account-state` (clears everything the paired account owns by key prefix with a keep-list, so a later account inherits nothing), `messages` (the background <-> content <-> popup discriminated-union envelope + guard, including the control message, response and status-snapshot types), `locks` (`withStorageLock`: heartbeated, owner-checked, stale-takeover -- wraps both the auth lock and the sync lease), `token-provider` (the interface the upload client depends on, so it never imports `auth/`; also defines `ReconnectRequiredError`), `api` (the typed ingest upload client with a longer upload deadline; owns the request serialization and defines the shared per-request body-size cap, which `sync/orchestrator` enforces when it splits batches and drops an oversized conversation), `logger`. |
| `scripts/` | `content-isolation` (in-build Rollup gate: fails if any third-party module is reachable from a content bundle), `verify-manifest` (post-build gate: manifest shape, host_permissions equal to both the env-derived set and the endpoint values read back from the built bundle, and the pinned browser identities), `browser-identity` (the pinned Chrome public key and Firefox add-on id), `extension-id` (derives the Chrome extension id and Firefox redirect host from them), `host-permissions` (the manifest host_permissions for a build, from the same endpoint parser; shared by the WXT config and the verifier), `bundle-endpoints` (reads the inlined endpoint values out of the built bundle, failing closed on any unrecognized shape), `verify-required-needs` (asserts the CI `required` job depends on every other CI job; byte copy of gubbi-web's checker, pinned by sha256 in its test). |

## Entry points

- `entrypoints/background.ts` -- the service worker. On every cold start it
  reconciles any interrupted token refresh before doing token work; a 30-min
  alarm, a short continuation alarm and a sync-start control message drive the
  sync orchestrator; all control messages (status, sync, pair, unpair,
  per-platform enable) are answered through `src/lib/control/`.
- `entrypoints/chatgpt.content/`, `entrypoints/claude.content/` -- the
  isolated-world content scripts that perform the platform reads on request.
- `entrypoints/popup/` -- the minimal control surface (plain TS + HTML):
  connection and per-platform sync status, pair or reconnect / sync now / disconnect,
  and per-platform enable toggles. `view-model` is the pure mapping from
  control replies to what is shown; `main` sends the messages and renders it.
- `entrypoints/options/` -- options page; currently a stub.

## Cross-repo deps

- The hosted **ingest API** and **OAuth server** (HTTP only -- see "Where it
  fits"). No code dependency; the wire contract is mirrored by the local Zod
  schema, which is checked against a byte-pinned copy of the backend's
  generated contract fixture (`tests/fixtures/ingest-contract.json`).
- No shared packages. This repo is intentionally standalone so the
  cookie-touching client is independently auditable.

## Deeper docs

- [`README.md`](./README.md) -- the privacy invariant, content-script
  isolation (the ESLint ban + the in-build Rollup gate), the WXT toolchain,
  dev setup, and build-time configuration.
