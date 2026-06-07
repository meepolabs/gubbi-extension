// launchWebAuthFlow driver. Wraps the browser's interactive auth-window API and
// parses the redirect URL it returns. Cross-browser: chrome.identity is the
// same surface on Chrome (chromiumapp.org redirect) and Firefox MV3
// (extensions.allizom.org redirect); WXT maps `browser.*` onto `chrome.*` so
// the ambient chrome namespace works in both.
//
// Background-only: chrome.identity is unavailable to content scripts.

// Outcome of one interactive auth-window round trip. The redirect either
// carries an authorization `code` (with the echoed `state`), an `error`, or the
// flow was aborted before any redirect (window closed / user declined).
export type LaunchResult =
  | { readonly kind: "code"; readonly code: string; readonly state: string | undefined }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "aborted" };

export function getRedirectUri(): string {
  return chrome.identity.getRedirectURL();
}

// Parses the redirect URL into a LaunchResult. The authorization-code response
// params live in the query string; an OAuth error response also uses the query
// string. A missing code with no error is treated as an error.
function parseRedirect(redirectUrl: string): LaunchResult {
  let params: URLSearchParams;
  try {
    params = new URL(redirectUrl).searchParams;
  } catch {
    return { kind: "error", error: "unparseable redirect url" };
  }
  const error = params.get("error");
  if (error) return { kind: "error", error };
  const code = params.get("code");
  if (!code) return { kind: "error", error: "redirect missing authorization code" };
  return { kind: "code", code, state: params.get("state") ?? undefined };
}

// Opens the interactive auth window and resolves with the parsed redirect.
// Rejects from launchWebAuthFlow (user closed the window, no redirect captured)
// surface as `aborted` rather than throwing.
export async function launchWebAuthFlow(authorizeUrl: string): Promise<LaunchResult> {
  let redirectUrl: string | undefined;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authorizeUrl,
      interactive: true,
    });
  } catch {
    return { kind: "aborted" };
  }
  if (!redirectUrl) return { kind: "aborted" };
  return parseRedirect(redirectUrl);
}
