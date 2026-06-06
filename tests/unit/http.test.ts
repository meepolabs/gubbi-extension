import { afterEach, describe, expect, it, vi } from "vitest";

import {
  failureFromResponse,
  fetchJson,
  parseRetryAfter,
} from "../../src/lib/connectors/http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRetryAfter", () => {
  it("parses a numeric seconds Retry-After header", () => {
    // Arrange
    const response = new Response(null, { status: 429, headers: { "retry-after": "30" } });

    // Act / Assert
    expect(parseRetryAfter(response)).toBe(30);
  });

  it("returns undefined when the header is absent", () => {
    // Arrange
    const response = new Response(null, { status: 429 });

    // Act / Assert
    expect(parseRetryAfter(response)).toBeUndefined();
  });
});

describe("failureFromResponse", () => {
  it("maps a 429 with Retry-After to a rate_limited outcome", () => {
    // Arrange
    const response = new Response(null, { status: 429, headers: { "retry-after": "12" } });

    // Act
    const outcome = failureFromResponse(response);

    // Assert
    expect(outcome).toEqual({ status: "rate_limited", retryAfterSeconds: 12 });
  });

  it("maps a non-429 failure to an error outcome carrying only the status", () => {
    // Arrange
    const response = new Response("server exploded with secrets", { status: 500 });

    // Act
    const outcome = failureFromResponse(response);

    // Assert: no response body leaks into the error message.
    expect(outcome).toEqual({ status: "error", error: "request failed with status 500" });
  });
});

describe("fetchJson", () => {
  it("returns ok with the parsed body on a 2xx", async () => {
    // Arrange
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    );

    // Act
    const outcome = await fetchJson<{ hello: string }>("https://claude.ai/x");

    // Assert
    expect(outcome).toEqual({ status: "ok", data: { hello: "world" } });
  });

  it("maps a 429 response to a rate_limited outcome", async () => {
    // Arrange
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 429, headers: { "retry-after": "5" } }),
    );

    // Act
    const outcome = await fetchJson("https://chatgpt.com/x");

    // Assert
    expect(outcome).toEqual({ status: "rate_limited", retryAfterSeconds: 5 });
  });

  it("maps a thrown network error to an error outcome", async () => {
    // Arrange
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    // Act
    const outcome = await fetchJson("https://chatgpt.com/x");

    // Assert
    expect(outcome.status).toBe("error");
  });

  it("sends credentials:include for same-origin cookie auth", async () => {
    // Arrange
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    // Act
    await fetchJson("https://claude.ai/api/organizations");

    // Assert
    const init = spy.mock.calls[0]![1];
    expect(init?.credentials).toBe("include");
  });
});
