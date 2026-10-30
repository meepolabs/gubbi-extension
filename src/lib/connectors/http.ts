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

const MILLIS_PER_SECOND = 1000;

const DELAY_SECONDS = /^\d+$/;
const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const LONG_DAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const TIME = "\\d{2}:\\d{2}:\\d{2}";
const IMF_FIXDATE = new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`);
const RFC850_DATE = new RegExp(`^${LONG_DAY}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} (?: \\d|\\d{2}) ${TIME} \\d{4}$`);

// Parses a Retry-After header (RFC 9110 10.2.3): delay-seconds (1*DIGIT) or an
// HTTP-date, as whole seconds from now rounded up (a past date is 0). Any other
// value is treated as absent and yields undefined.
export function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  if (DELAY_SECONDS.test(header)) return Number.parseInt(header, 10);
  const dateMs = httpDateMs(header);
  if (dateMs === undefined) return undefined;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / MILLIS_PER_SECOND));
}

// asctime carries no zone token but is GMT by definition; Date.parse would read
// it as local time, so the zone is appended before parsing.
function httpDateMs(value: string): number | undefined {
  let parsed = Number.NaN;
  if (IMF_FIXDATE.test(value) || RFC850_DATE.test(value)) parsed = Date.parse(value);
  else if (ASCTIME_DATE.test(value)) parsed = Date.parse(`${value} GMT`);
  return Number.isNaN(parsed) ? undefined : parsed;
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
