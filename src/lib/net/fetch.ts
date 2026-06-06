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

const DEFAULT_API_HOST = "api.gubbi.ai";
const DEFAULT_AUTH_HOST = "auth.gubbi.ai";

// Accepts either a full URL ("https://api.gubbi.ai") or a bare host
// ("api.gubbi.ai") and returns the host, or undefined when unparseable.
function hostFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    try {
      return new URL(`https://${value}`).host;
    } catch {
      return undefined;
    }
  }
}

// Closed egress allowlist, frozen at build time. The verify gate asserts this
// set is a subset of the manifest host_permissions.
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  hostFrom(import.meta.env.VITE_API_BASE_URL) ?? DEFAULT_API_HOST,
  hostFrom(import.meta.env.VITE_AUTH_HOST) ?? DEFAULT_AUTH_HOST,
]);

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
