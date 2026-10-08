import type { RawFetchOutcome } from "./base";

// Content-safe HTTP helpers shared by the per-platform raw fetchers.
//
// CONTENT-SCRIPT ISOLATION: this module is imported (transitively) by content
// scripts, so it MUST stay free of any third-party runtime code -- no zod, no
// schema, nothing from node_modules. It uses only the platform `fetch` global.
// All requests are same-origin reads of the page the user is on, so they do NOT
// go through the background egress guard (src/lib/net/fetch.ts).

const HTTP_TOO_MANY_REQUESTS = 429;

// Same-origin GET with cookies. Returns the raw Response so callers can inspect
// status before consuming the body.
export function sameOriginGet(url: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "GET",
    credentials: "include",
    // Reject redirects rather than silently following a cross-origin hop -- a
    // same-origin read should never bounce off-origin.
    redirect: "error",
    headers: headers ?? {},
  });
}

// Parses a Retry-After header. Per RFC 7231 it is either a number of seconds or
// an HTTP-date; both are handled. Returns undefined when absent/unparseable.
export function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds;
  const asDate = Date.parse(header);
  if (Number.isNaN(asDate)) return undefined;
  const deltaMs = asDate - Date.now();
  return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : 0;
}

// Maps a non-OK Response to a RawFetchOutcome failure variant. A 429 becomes
// `rate_limited` (honoring Retry-After); anything else becomes `error` with a
// terse, non-leaky message (status only, no response body).
export function failureFromResponse<T>(response: Response): RawFetchOutcome<T> {
  if (response.status === HTTP_TOO_MANY_REQUESTS) {
    const retryAfterSeconds = parseRetryAfter(response);
    return retryAfterSeconds === undefined
      ? { status: "rate_limited" }
      : { status: "rate_limited", retryAfterSeconds };
  }
  return { status: "error", error: `request failed with status ${response.status}` };
}

// Wraps a fetch-and-parse-JSON in a try/catch that maps a thrown network error
// (offline, DNS, redirect:error rejection) to a RawFetchOutcome error rather
// than letting it propagate. The body is parsed as JSON only on a 2xx.
export async function fetchJson<T>(
  url: string,
  headers?: Record<string, string>,
): Promise<RawFetchOutcome<T>> {
  let response: Response;
  try {
    response = await sameOriginGet(url, headers);
  } catch (e) {
    return { status: "error", error: networkErrorMessage(e) };
  }
  if (!response.ok) return failureFromResponse<T>(response);
  try {
    const data = (await response.json()) as T;
    return { status: "ok", data };
  } catch {
    return { status: "error", error: "response body was not valid JSON" };
  }
}

function networkErrorMessage(e: unknown): string {
  return e instanceof Error ? `network request failed: ${e.message}` : "network request failed";
}
