import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RawFetchOutcome } from "../../src/lib/connectors/base";
import {
  SOURCE_REQUEST_SPACING_MS,
  SOURCE_REQUEST_TIMEOUT_MS,
  failureFromResponse,
  fetchJson,
  parseRetryAfter,
  resetSourceRequestTiming,
} from "../../src/lib/connectors/http";
import { toFailure } from "../../src/lib/connectors/outcome";

type ErrorOutcome = Extract<RawFetchOutcome<unknown>, { status: "error" }>;

beforeEach(() => {
  resetSourceRequestTiming();
});

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

describe("fetchJson pacing", () => {
  beforeEach(() => {
    resetSourceRequestTiming();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSourceRequestTiming();
  });

  it("starts consecutive same-origin requests at least the spacing apart", async () => {
    // Arrange
    const startedAt: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      startedAt.push(Date.now());
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    // Act
    const run = (async () => {
      for (let i = 0; i < 3; i += 1) await fetchJson("https://claude.ai/api/organizations");
    })();
    await vi.runAllTimersAsync();
    await run;

    // Assert
    expect(startedAt).toHaveLength(3);
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(SOURCE_REQUEST_SPACING_MS);
    expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(SOURCE_REQUEST_SPACING_MS);
  });

  it("gives concurrent callers distinct slots", async () => {
    // Arrange
    const startedAt: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      startedAt.push(Date.now());
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    // Act
    const pending = Promise.all([
      fetchJson("https://chatgpt.com/a"),
      fetchJson("https://chatgpt.com/b"),
    ]);
    await vi.runAllTimersAsync();
    await pending;

    // Assert
    expect(startedAt).toHaveLength(2);
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(SOURCE_REQUEST_SPACING_MS);
  });
});

describe("fetchJson deadline", () => {
  beforeEach(() => {
    resetSourceRequestTiming();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSourceRequestTiming();
  });

  it("classifies a fetch that never settles as network at the deadline", async () => {
    // Arrange
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    let outcome: RawFetchOutcome<unknown> | undefined;

    // Act
    const pending = fetchJson("https://chatgpt.com/x").then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(SOURCE_REQUEST_TIMEOUT_MS - 1);
    const settledBeforeDeadline = outcome !== undefined;
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    // Assert
    expect(settledBeforeDeadline).toBe(false);
    expect(outcome?.status).toBe("error");
    expect(toFailure(outcome as ErrorOutcome)).toEqual({ ok: false, reason: "network" });
    expect(fetchSpy.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies a 200 whose body never settles as network at the deadline", async () => {
    // Arrange
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockReturnValue(new Promise(() => {}));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    let outcome: RawFetchOutcome<unknown> | undefined;

    // Act
    const pending = fetchJson("https://claude.ai/x").then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(SOURCE_REQUEST_TIMEOUT_MS - 1);
    const settledBeforeDeadline = outcome !== undefined;
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    // Assert
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(settledBeforeDeadline).toBe(false);
    expect(toFailure(outcome as ErrorOutcome)).toEqual({ ok: false, reason: "network" });
    expect(fetchSpy.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("leaves no timer pending after a successful call", async () => {
    // Arrange
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    // Act
    const outcome = await fetchJson("https://claude.ai/x");

    // Assert
    expect(outcome).toEqual({ status: "ok", data: {} });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still reports an unparseable 200 body as invalid JSON", async () => {
    // Arrange
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));

    // Act
    const outcome = await fetchJson("https://claude.ai/x");

    // Assert
    expect(outcome).toEqual({ status: "error", error: "response body was not valid JSON" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
