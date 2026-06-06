import { afterEach, describe, expect, it, vi } from "vitest";

import { guardedFetch } from "../../src/lib/net/fetch";

// The allowed hosts default to api.gubbi.ai and auth.gubbi.ai when
// VITE_API_BASE_URL / VITE_AUTH_HOST are unset, which is the case under vitest.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guardedFetch", () => {
  it("allows the gubbi API host and forwards redirect:error by default", async () => {
    // Arrange
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    // Act
    await guardedFetch("https://api.gubbi.ai/api/v1/ingest/conversations");

    // Assert
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]![1];
    expect(init?.redirect).toBe("error");
  });

  it("allows the auth issuer host", async () => {
    // Arrange
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    // Act
    await guardedFetch("https://auth.gubbi.ai/oauth/token");

    // Assert
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("forces redirect:error even when a caller tries to override it", async () => {
    // Arrange
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    // Act
    await guardedFetch("https://api.gubbi.ai/api/v1/ping", { redirect: "follow" });

    // Assert
    const init = spy.mock.calls[0]![1];
    expect(init?.redirect).toBe("error");
  });

  it("throws on a disallowed host", () => {
    // Arrange / Act / Assert
    expect(() => guardedFetch("https://evil.example/steal")).toThrow(/disallowed host/);
  });

  it("throws on a non-HTTPS scheme even for the allowed host", () => {
    // Arrange / Act / Assert
    expect(() => guardedFetch("http://api.gubbi.ai/api/v1/ping")).toThrow(/non-HTTPS/);
  });

  it("never reaches fetch when the host is disallowed", () => {
    // Arrange
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    // Act
    expect(() => guardedFetch("https://attacker.test/x")).toThrow();

    // Assert
    expect(spy).not.toHaveBeenCalled();
  });
});
