// Single parser for the configured remote endpoints (VITE_API_BASE_URL,
// VITE_AUTH_HOST). Plain ESM with no imports so the extension source, the WXT
// config and node build scripts all share one definition of a valid host.
//
// The parsed host feeds two consumers that must agree: the egress allowlist,
// which compares WHATWG `url.host` (port included), and manifest match
// patterns, which in Firefox cannot carry a port. Only a canonical https host
// with no port, credentials, path, query, fragment or wildcard satisfies both.

export const DEFAULT_API_HOST = "api.gubbi.ai";
export const DEFAULT_AUTH_HOST = "auth.gubbi.ai";

const HTTPS_PREFIX = "https://";

export function parseEndpointHost(value) {
  if (typeof value !== "string" || value === "" || value.includes("*")) return undefined;
  const candidate = value.startsWith(HTTPS_PREFIX) ? value : `${HTTPS_PREFIX}${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  const { host } = url;
  // url.host keeps a non-default port, so a bare "host:port" would survive the
  // round-trip below; reject it explicitly.
  if (host === "" || url.port !== "") return undefined;
  // Demanding an exact round-trip rejects what the parser silently normalises
  // away (":443", empty "?" or "#", uppercase, whitespace) and what it moves
  // out of the host (userinfo, path, query, fragment).
  const canonicalForms = [host, `${HTTPS_PREFIX}${host}`, `${HTTPS_PREFIX}${host}/`];
  return canonicalForms.includes(value) ? host : undefined;
}

export function resolveEndpointHost(value, defaultHost) {
  if (value === undefined) return defaultHost;
  return parseEndpointHost(value);
}

export function originOf(host) {
  return host === undefined ? undefined : `${HTTPS_PREFIX}${host}`;
}
