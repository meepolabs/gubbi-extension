export declare const DEFAULT_API_HOST: "api.gubbi.ai";
export declare const DEFAULT_AUTH_HOST: "auth.gubbi.ai";

/**
 * Returns the host of an https origin or bare host, or undefined when the value
 * carries a scheme other than https, credentials, a port, a non-root path, a
 * query, a fragment or a wildcard, or is empty.
 *
 * An accepted host is byte-identical to WHATWG `url.host` for its https origin
 * (lowercase ASCII, punycode, no port) and is a DNS name of letter-digit-hyphen
 * labels: never an IP literal, a trailing-dot host or a host with an empty,
 * hyphen-edged or over-63-octet label. The input must already be in that
 * canonical form; nothing is normalised.
 */
export declare function parseEndpointHost(value: string | undefined): string | undefined;

/**
 * Unset (undefined) resolves to `defaultHost`; any set value must parse, and an
 * invalid one resolves to undefined rather than to the default.
 */
export declare function resolveEndpointHost(
  value: string | undefined,
  defaultHost: string,
): string | undefined;

export declare function originOf(host: string | undefined): string | undefined;
