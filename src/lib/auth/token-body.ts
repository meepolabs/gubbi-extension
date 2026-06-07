// Shared OAuth token-response body parser. The authorization-code exchange and
// the refresh flow both narrow the same three fields off an unknown JSON body;
// extracting one parser keeps the narrowing in a single place.
//
// Background-only (only the auth flows import it).

export interface ParsedToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

// Narrows a parsed JSON body to the token shape, or undefined when any of the
// three required fields is missing or the wrong type.
export function tokenFromBody(raw: unknown): ParsedToken | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = raw as Record<string, unknown>;
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  const expiresIn = body.expires_in;
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof expiresIn !== "number"
  ) {
    return undefined;
  }
  return { accessToken, refreshToken, expiresInSeconds: expiresIn };
}
