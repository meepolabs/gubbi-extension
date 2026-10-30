// Host-whitelisting wrapper for outbound fetches made from the EXTENSION
// context (background / popup / options). Every api-client call must go through
// this guard so a compromised dependency cannot exfiltrate to an arbitrary
// host. It is the single egress chokepoint for the extension context.
//
// The extension reaches exactly two remote hosts: the gubbi API and the auth
// issuer. Both are seeded into the allowlist below from build-time env vars
// (with public defaults), so the set is a closed whitelist -- any other host is
// rejected before fetch is called.
//
// Content-script same-origin reads of chatgpt.com / claude.ai do NOT use this
// wrapper -- they are same-origin reads of the page the user is already on, and
// are the only other documented network egress for this extension. Content
// scripts never import this module.

import { logger } from "../logger";
import { DEFAULT_API_HOST, DEFAULT_AUTH_HOST, resolveEndpointHost } from "./endpoint-host.mjs";

function configuredHost(
  name: string,
  value: string | undefined,
  defaultHost: string,
): string | undefined {
  const host = resolveEndpointHost(value, defaultHost);
  if (host === undefined) {
    logger.warn("endpoint host rejected; requests to it are blocked", { variable: name });
  }
  return host;
}

// Closed egress allowlist, frozen at build time. An env var set to an invalid
// value contributes no host, so requests to it are blocked rather than sent to
// the prod default. The verify gate asserts the manifest host_permissions are
// exactly these hosts plus the content-script hosts; it reads them out of the
// built bundle as each variable-name literal followed by its inlined value, so
// configuredHost must keep taking the name and the value as adjacent arguments.
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(
  [
    configuredHost("VITE_API_BASE_URL", import.meta.env.VITE_API_BASE_URL, DEFAULT_API_HOST),
    configuredHost("VITE_AUTH_HOST", import.meta.env.VITE_AUTH_HOST, DEFAULT_AUTH_HOST),
  ].filter((host): host is string => host !== undefined),
);

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export class FetchDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`Outbound request exceeded its ${timeoutMs} ms deadline`);
    this.name = "FetchDeadlineError";
  }
}

export interface GuardedFetchOptions {
  readonly timeoutMs?: number;
}

// The Response constructor rejects a body for these statuses.
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

// The body is read to completion here, under the same deadline as the request,
// so a server that sends headers and then stalls cannot hold the caller past
// the deadline. Callers get an in-memory Response; url / redirected / type are
// not carried over.
async function fetchBuffered(url: URL, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Not async: the allowlist and scheme checks throw synchronously, before any
// request exists.
export function guardedFetch(
  input: string | URL,
  init?: RequestInit,
  options?: GuardedFetchOptions,
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (!ALLOWED_HOSTS.has(url.host)) {
    throw new Error(`Blocked outbound request to disallowed host: ${url.host}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Blocked non-HTTPS outbound request: ${url.protocol}`);
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  // redirect:"error" rejects any redirect rather than silently following one to
  // a host that bypassed the check above. It and the deadline signal are placed
  // AFTER the init spread so a caller-supplied init.redirect or init.signal can
  // never weaken redirect blocking or outlive the deadline.
  const request = fetchBuffered(url, { ...init, redirect: "error", signal: controller.signal });

  return new Promise<Response>((resolve, reject) => {
    // Expiry rejects on its own rather than relying on the abort to reject: a
    // transport may still settle successfully once aborted, and expiry must win.
    const timer = setTimeout(() => {
      reject(new FetchDeadlineError(timeoutMs));
      controller.abort();
    }, timeoutMs);
    request.then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
