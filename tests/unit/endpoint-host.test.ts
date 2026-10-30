import { describe, expect, it } from "vitest";

import {
  DEFAULT_API_HOST,
  DEFAULT_AUTH_HOST,
  parseEndpointHost,
  resolveEndpointHost,
} from "../../src/lib/net/endpoint-host.mjs";

describe("parseEndpointHost", () => {
  it.each([
    ["bare host", "api.gubbi.ai", "api.gubbi.ai"],
    ["https origin", "https://auth.gubbi.ai", "auth.gubbi.ai"],
    ["https origin with root slash", "https://auth.gubbi.ai/", "auth.gubbi.ai"],
    ["https origin on a nested subdomain", "https://api.dev.example.test", "api.dev.example.test"],
    ["single-label host", "localhost", "localhost"],
    ["hyphen inside a label", "api-two.example.test", "api-two.example.test"],
    ["digits in a label", "api2.example.test", "api2.example.test"],
    ["punycode label", "xn--bcher-kva.example.test", "xn--bcher-kva.example.test"],
  ])("accepts %s", (_name, input, expected) => {
    expect(parseEndpointHost(input)).toBe(expected);
  });

  it.each([
    ["http scheme", "http://x.test"],
    ["non-web scheme", "ftp://x.test"],
    ["userinfo", "https://u:p@x.test"],
    ["username only", "https://u@x.test"],
    ["explicit port on a bare host", "x.test:8443"],
    ["explicit port on an origin", "https://x.test:8443"],
    ["explicit default port", "https://x.test:443"],
    ["non-root path", "https://x.test/v1"],
    ["query", "https://x.test?a"],
    ["empty query", "https://x.test?"],
    ["fragment", "https://x.test#f"],
    ["wildcard host", "*.x.test"],
    ["wildcard in an origin", "https://*.x.test"],
    ["empty", ""],
    ["blank", "   "],
    ["surrounding whitespace", " api.gubbi.ai "],
    ["uppercase host", "API.gubbi.ai"],
    ["unparseable host", "exa mple.test"],
    ["trailing-dot host", "api.gubbi.ai."],
    ["trailing-dot origin", "https://api.gubbi.ai."],
    ["bracketed IPv6", "[::1]"],
    ["bracketed IPv6 origin", "https://[::1]"],
    ["IPv4 literal", "127.0.0.1"],
    ["shorthand IPv4 literal", "127.1"],
    ["hex IPv4 literal", "0x7f.1"],
    ["numeric last label", "x.123"],
    ["empty label", "x..test"],
    ["leading-hyphen label", "-x.test"],
    ["trailing-hyphen label", "x-.test"],
    ["underscore label", "x_y.test"],
    ["dollar sign", "$x.test"],
    ["label longer than 63 octets", `${"a".repeat(64)}.test`],
    ["non-ASCII host", "b\u00fccher.test"],
    ["fullwidth full stop", "x\uff0etest"],
    ["backslash before userinfo", "https://evil.test\\@x.test"],
  ])("rejects %s", (_name, input) => {
    expect(parseEndpointHost(input)).toBeUndefined();
  });
});

describe("resolveEndpointHost", () => {
  it("returns the default host when the value is unset", () => {
    expect(resolveEndpointHost(undefined, DEFAULT_API_HOST)).toBe("api.gubbi.ai");
  });

  it("returns the parsed host when the value is valid", () => {
    expect(resolveEndpointHost("https://api.dev.example.test", DEFAULT_API_HOST)).toBe(
      "api.dev.example.test",
    );
  });

  it("returns no host, never the default, when the value is invalid", () => {
    expect(resolveEndpointHost("auth.example.test:8443", DEFAULT_AUTH_HOST)).toBeUndefined();
  });

  it("returns no host, never the default, when the value is set but empty", () => {
    expect(resolveEndpointHost("", DEFAULT_AUTH_HOST)).toBeUndefined();
  });
});
