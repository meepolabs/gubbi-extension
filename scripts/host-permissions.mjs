// The manifest host_permissions for a build: the two content-script origins
// plus the API and auth hosts the egress allowlist (src/lib/net/fetch.ts)
// derives from the same variables through the same parser. Shared by
// wxt.config.ts and scripts/verify-manifest.mjs so the build and its verifier
// cannot disagree.

import {
  DEFAULT_API_HOST,
  DEFAULT_AUTH_HOST,
  resolveEndpointHost,
} from "../src/lib/net/endpoint-host.mjs";

const CONTENT_HOSTS = ["chatgpt.com", "claude.ai"];

const ENDPOINT_VARIABLES = [
  ["VITE_API_BASE_URL", DEFAULT_API_HOST],
  ["VITE_AUTH_HOST", DEFAULT_AUTH_HOST],
];

export function endpointHosts(env) {
  return ENDPOINT_VARIABLES.map(([name, defaultHost]) => {
    const host = resolveEndpointHost(env[name], defaultHost);
    if (host === undefined) {
      throw new Error(
        `${name} must be an https origin or bare DNS host with no port, credentials, ` +
          "path, query, fragment or wildcard",
      );
    }
    return host;
  });
}

export function hostPermissions(env) {
  const hosts = new Set([...CONTENT_HOSTS, ...endpointHosts(env)]);
  return [...hosts].map((host) => `https://${host}/*`).toSorted();
}
