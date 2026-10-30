// A control message is honored only from this extension's own pages (popup,
// options, any extension page open in a tab), never from a content script or
// another extension. A content script runs under this extension's id but reports
// the web page's origin, so the origin check is what refuses it.
export function isTrustedControlSender(
  sender: chrome.runtime.MessageSender | undefined,
  runtimeId: string,
  extensionOrigin: string,
): boolean {
  if (sender === undefined) return false;
  if (sender.id !== runtimeId) return false;
  const origin = sender.origin ?? (sender.url === undefined ? undefined : originOf(sender.url));
  return origin !== undefined && origin === extensionOrigin;
}

// URL.origin is the opaque "null" for schemes the URL standard does not know,
// which includes chrome-extension: and moz-extension: outside the browser, so the
// origin is assembled from scheme and host instead.
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.host === "") return undefined;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}
