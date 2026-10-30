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
// the prod default. The verify gate asserts this set is a subset of the
// manifest host_permissions.
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set(
  [
    configuredHost("VITE_API_BASE_URL", import.meta.env.VITE_API_BASE_URL, DEFAULT_API_HOST),
    configuredHost("VITE_AUTH_HOST", import.meta.env.VITE_AUTH_HOST, DEFAULT_AUTH_HOST),
  ].filter((host): host is string => host !== undefined),
);

export function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (!ALLOWED_HOSTS.has(url.host)) {
    throw new Error(`Blocked outbound request to disallowed host: ${url.host}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Blocked non-HTTPS outbound request: ${url.protocol}`);
  }
  // redirect:"error" rejects any redirect rather than silently following one to
  // a host that bypassed the check above. It is placed AFTER the init spread so
  // a caller-supplied init.redirect can never weaken it: redirect blocking is
  // non-overridable, keeping an allowed host's redirect from escaping the
  // allowlist.
  return fetch(url, { ...init, redirect: "error" });
}
