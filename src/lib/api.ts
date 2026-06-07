import { guardedFetch } from "./net/fetch";
import {
  HTTP_FORBIDDEN,
  HTTP_SERVER_ERROR_FLOOR,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
} from "./net/http-constants";
import {
  IngestConversationResponseSchema,
  MAX_CONVERSATIONS_PER_REQUEST,
  type IngestConversationRequest,
  type IngestConversationResponse,
} from "./schema/ingest";
import type { TokenProvider } from "./token-provider";

// Thin, typed ingest client. It POSTs one batch of conversations and maps the
// single HTTP response to a discriminated outcome -- nothing more. It depends on
// the TokenProvider contract (dependency-inverted) and never imports the auth
// module; the orchestrator wires a concrete provider in.
//
// This client owns NO retry/refresh policy: a 401 maps to `needs_refresh` and
// returns. The orchestrator owns the refresh-and-retry-once decision.

export const INGEST_PATH = "/v1/ingest/conversations";

const DEFAULT_API_ORIGIN = "https://api.gubbi.ai";

const MILLIS_PER_SECOND = 1000;

// Accepts a bare host ("api.gubbi.ai") or a full URL; returns the origin. Mirrors
// the egress allowlist + auth config so the request lands on the allowed host.
function apiOrigin(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (!configured) return DEFAULT_API_ORIGIN;
  try {
    return new URL(configured).origin;
  } catch {
    return `https://${configured}`;
  }
}

// Discriminated outcome of a single upload attempt. `ok` carries the full
// validated response body -- `budget_exhausted: true` is still `ok` (a saved
// batch with extraction paused, not a failure). `auth_unavailable` means the
// provider could not yield a token (session lost / re-pairing required) so no
// request was made; `needs_refresh` means the server rejected an otherwise-valid
// token (401) and a forced refresh + single retry is the orchestrator's call.
export type UploadOutcome =
  | { readonly status: "ok"; readonly response: IngestConversationResponse }
  | { readonly status: "needs_refresh" }
  | { readonly status: "insufficient_scope" }
  | { readonly status: "rate_limited"; readonly retryAfterSeconds: number | null }
  | { readonly status: "transient_http"; readonly httpStatus: number }
  | { readonly status: "network" }
  | { readonly status: "malformed_response" }
  | { readonly status: "oversize_batch" }
  | { readonly status: "auth_unavailable" };

// Parses a Retry-After header value: either a delta-seconds integer or an
// HTTP-date. Returns whole seconds from now for a date (clamped at >= 0), or
// null when the header is absent or unparseable.
function parseRetryAfter(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const dateMillis = Date.parse(trimmed);
  if (Number.isNaN(dateMillis)) return null;
  const deltaSeconds = Math.round((dateMillis - Date.now()) / MILLIS_PER_SECOND);
  return deltaSeconds < 0 ? 0 : deltaSeconds;
}

async function parseOkBody(response: Response): Promise<UploadOutcome> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { status: "malformed_response" };
  }

  const result = IngestConversationResponseSchema.safeParse(parsed);
  if (!result.success) return { status: "malformed_response" };
  return { status: "ok", response: result.data };
}

function mapErrorStatus(response: Response): UploadOutcome {
  if (response.status === HTTP_UNAUTHORIZED) return { status: "needs_refresh" };
  if (response.status === HTTP_FORBIDDEN) return { status: "insufficient_scope" };
  if (response.status === HTTP_TOO_MANY_REQUESTS) {
    return {
      status: "rate_limited",
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    };
  }
  if (response.status >= HTTP_SERVER_ERROR_FLOOR) {
    return { status: "transient_http", httpStatus: response.status };
  }
  // Any other non-2xx (e.g. an unexpected 4xx) is treated as transient at the
  // HTTP layer; the orchestrator decides whether to surface or back off.
  return { status: "transient_http", httpStatus: response.status };
}

export async function uploadConversations(
  request: IngestConversationRequest,
  tokenProvider: TokenProvider,
): Promise<UploadOutcome> {
  if (request.conversations.length > MAX_CONVERSATIONS_PER_REQUEST) {
    return { status: "oversize_batch" };
  }

  let accessToken: string;
  try {
    accessToken = await tokenProvider.getAccessToken();
  } catch {
    return { status: "auth_unavailable" };
  }

  const url = new URL(INGEST_PATH, apiOrigin()).toString();

  let response: Response;
  try {
    response = await guardedFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch {
    // Transport failure, redirect rejection, or disallowed host.
    return { status: "network" };
  }

  if (response.ok) return parseOkBody(response);
  return mapErrorStatus(response);
}
