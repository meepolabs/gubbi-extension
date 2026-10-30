// Single parser for the configured remote endpoints (VITE_API_BASE_URL,
// VITE_AUTH_HOST). Plain ESM with no imports so the extension source, the WXT
// config and node build scripts all share one definition of a valid host.
//
// The parsed host feeds two consumers that must agree: the egress allowlist,
// which compares WHATWG `url.host` (port included), and manifest match
// patterns, which in Firefox cannot carry a port. An accepted host is
// byte-identical to the WHATWG `url.host` of its https origin: lowercase ASCII
// (punycode for IDNs), no port. It is also a plain DNS name: dot-separated
// letter-digit-hyphen labels of 1-63 octets that neither start nor end with a
// hyphen, and a last label that is not all digits. That excludes IP literals,
// a trailing dot and empty labels, so every accepted host is expressible as an
// exact `https://<host>/*` match pattern in both Chrome and Firefox.

export const DEFAULT_API_HOST = "api.gubbi.ai";
export const DEFAULT_AUTH_HOST = "auth.gubbi.ai";

const HTTPS_PREFIX = "https://";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ALL_DIGITS = /^[0-9]+$/;

function isDnsName(host) {
  const labels = host.split(".");
  const last = labels[labels.length - 1];
  return labels.every((label) => DNS_LABEL.test(label)) && !ALL_DIGITS.test(last);
}

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
  if (!canonicalForms.includes(value)) return undefined;
  return isDnsName(host) ? host : undefined;
}

export function resolveEndpointHost(value, defaultHost) {
  if (value === undefined) return defaultHost;
  return parseEndpointHost(value);
}

export function originOf(host) {
  return host === undefined ? undefined : `${HTTPS_PREFIX}${host}`;
}
