import type { IngestConversationRequest, IngestConversationResponse } from "./schema/ingest";

// Ingest API client. The real implementation lands in a later phase.
//
// TODO(phase-2): implement uploadConversations -- serialize `request`, POST it
// through guardedFetch (src/lib/net/fetch.ts) to `${VITE_API_BASE_URL}` +
// INGEST_PATH with the device token as a bearer credential, then parse and
// validate the response body with IngestConversationResponseSchema.

export const INGEST_PATH = "/api/v1/ingest/conversations";

export async function uploadConversations(
  _request: IngestConversationRequest,
  _deviceToken: string,
): Promise<IngestConversationResponse> {
  throw new Error("not implemented");
}
