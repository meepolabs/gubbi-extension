import { afterEach, describe, expect, it, vi } from "vitest";

import { failureFromResponse, fetchJson, parseRetryAfter } from "../../src/lib/connectors/http";

afterEach(() => {
  vi.restoreAllMocks();
});

function retryAfterResponse(header: string | null): Response {
  return new Response(null, {
    status: 429,
    headers: header === null ? {} : { "retry-after": header },
  });
}

describe("parseRetryAfter", () => {
  const NOW_MS = Date.parse("2026-06-06T12:00:00.000Z");

  it.each([
    { name: "a decimal", header: "1.5" },
    { name: "an exponent", header: "1e3" },
    { name: "a negative number", header: "-1" },
    { name: "trailing garbage", header: "5x" },
    { name: "an empty value", header: "" },
    { name: "a non-GMT date", header: "Sat, 06 Jun 2026 12:00:02 PST" },
    { name: "free text", header: "soon-ish" },
  ])("treats $name ($header) as absent", ({ header }) => {
    // Arrange
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);

    // Act / Assert
    expect(parseRetryAfter(retryAfterResponse(header))).toBeUndefined();
  });

  it("returns undefined when the header is absent", () => {
    // Act / Assert
    expect(parseRetryAfter(retryAfterResponse(null))).toBeUndefined();
  });

  it.each([
    { name: "delay-seconds", header: "120", expected: 120 },
    { name: "zero delay-seconds", header: "0", expected: 0 },
  ])("parses $name as whole seconds", ({ header, expected }) => {
    // Act / Assert
    expect(parseRetryAfter(retryAfterResponse(header))).toBe(expected);
  });

  it.each([
    { name: "IMF-fixdate", header: "Sat, 06 Jun 2026 12:00:02 GMT" },
    { name: "RFC 850 date", header: "Saturday, 06-Jun-26 12:00:02 GMT" },
    { name: "asctime date", header: "Sat Jun  6 12:00:02 2026" },
  ])("rounds an $name 1.2 s ahead up to 2 seconds", ({ header }) => {
    // Arrange: the date is 2 s past a whole second; now sits 1.2 s before it.
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS + 800);

    // Act / Assert
    expect(parseRetryAfter(retryAfterResponse(header))).toBe(2);
  });

  it("clamps an HTTP-date in the past to 0", () => {
    // Arrange
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);

    // Act / Assert
    expect(parseRetryAfter(retryAfterResponse("Sat, 06 Jun 2026 11:59:00 GMT"))).toBe(0);
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
