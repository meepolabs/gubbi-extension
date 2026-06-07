// Shared HTTP status-code constants. Plain consts only -- NO third-party runtime
// imports -- so this module is content-script safe (outcome.ts, reachable from a
// content entry, imports it). Centralizes the codes that were redeclared across
// the auth, api, and connector layers so they cannot drift apart.

export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_TOO_MANY_REQUESTS = 429;

// Any status at or above this floor is a server-side error (5xx), treated as
// transient by the callers.
export const HTTP_SERVER_ERROR_FLOOR = 500;
