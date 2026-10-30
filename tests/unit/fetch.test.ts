import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  FetchDeadlineError,
  guardedFetch,
} from "../../src/lib/net/fetch";

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

const API_URL = "https://api.gubbi.ai/api/v1/ping";

// Records how a pending promise settles without awaiting it, so a test can
// advance fake timers and then inspect the outcome (awaiting a promise that
// never settles would hang the test instead of failing it).
function track<T>(promise: Promise<T>): {
  readonly state: () => string;
  readonly error: () => unknown;
} {
  let state = "pending";
  let error: unknown;
  promise.then(
    () => {
      state = "resolved";
    },
    (reason: unknown) => {
      state = "rejected";
      error = reason;
    },
  );
  return { state: () => state, error: () => error };
}

function neverSettlingFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
}

function stalledBody(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
}

describe("guardedFetch deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a never-settling fetch at the default deadline", async () => {
    // Arrange
    neverSettlingFetch();

    // Act
    const outcome = track(guardedFetch(API_URL));
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS - 1);
    const beforeDeadline = outcome.state();
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(beforeDeadline).toBe("pending");
    expect(outcome.state()).toBe("rejected");
    expect(outcome.error()).toBeInstanceOf(FetchDeadlineError);
  });

  it("rejects when the headers arrive but the body never finishes", async () => {
    // Arrange
    vi.spyOn(globalThis, "fetch").mockResolvedValue(stalledBody());

    // Act
    const outcome = track(guardedFetch(API_URL));
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS - 1);
    const beforeDeadline = outcome.state();
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(beforeDeadline).toBe("pending");
    expect(outcome.state()).toBe("rejected");
    expect(outcome.error()).toBeInstanceOf(FetchDeadlineError);
  });

  it("honors a per-call timeoutMs", async () => {
    // Arrange
    neverSettlingFetch();

    // Act
    const outcome = track(guardedFetch(API_URL, undefined, { timeoutMs: 120_000 }));
    await vi.advanceTimersByTimeAsync(119_999);
    const beforeDeadline = outcome.state();
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(beforeDeadline).toBe("pending");
    expect(outcome.state()).toBe("rejected");
  });

  it("aborts the underlying request at the deadline", async () => {
    // Arrange
    const spy = neverSettlingFetch();

    // Act
    track(guardedFetch(API_URL));
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS);

    // Assert
    const signal = spy.mock.calls[0]![1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it("still rejects when the transport settles successfully in response to the abort", async () => {
    // Arrange: a fetch that resolves with a usable response the moment it is
    // aborted, so only the deadline outcome distinguishes expiry from success.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          init?.signal?.addEventListener("abort", () => resolve(new Response("late")));
        }),
    );

    // Act
    const outcome = track(guardedFetch(API_URL));
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS);

    // Assert
    expect(outcome.state()).toBe("rejected");
    expect(outcome.error()).toBeInstanceOf(FetchDeadlineError);
  });

  it("returns the buffered status, headers and body when the response completes in time", async () => {
    // Arrange
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
    );

    // Act
    const response = await guardedFetch(API_URL);

    // Assert
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.text()).toBe("slow down");
  });

  it("returns a null-body status without failing to rebuild the response", async () => {
    // Arrange
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    // Act
    const response = await guardedFetch(API_URL);

    // Assert
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("ignores a caller signal and keeps the deadline in force", async () => {
    // Arrange
    const spy = neverSettlingFetch();
    const callerController = new AbortController();
    callerController.abort();

    // Act
    const outcome = track(guardedFetch(API_URL, { signal: callerController.signal }));
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS - 1);
    const sentSignal = spy.mock.calls[0]![1]?.signal;
    const sentAbortedBeforeDeadline = sentSignal?.aborted;
    const beforeDeadline = outcome.state();
    await vi.advanceTimersByTimeAsync(1);

    // Assert
    expect(sentSignal).not.toBe(callerController.signal);
    expect(sentAbortedBeforeDeadline).toBe(false);
    expect(beforeDeadline).toBe("pending");
    expect(outcome.state()).toBe("rejected");
  });

  it("keeps redirect:error when a caller supplies both redirect and signal", async () => {
    // Arrange
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

    // Act
    await guardedFetch(API_URL, { redirect: "follow", signal: new AbortController().signal });

    // Assert
    expect(spy.mock.calls[0]![1]?.redirect).toBe("error");
  });
});
