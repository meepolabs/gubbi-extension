// A control message is honored only from this extension's own pages: not from a
// tab (content scripts carry sender.tab) and not from another extension.
export function isTrustedControlSender(
  sender: chrome.runtime.MessageSender | undefined,
  runtimeId: string,
): boolean {
  if (sender === undefined) return false;
  if (sender.tab !== undefined) return false;
  return sender.id === runtimeId;
}
