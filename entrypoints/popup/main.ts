import { logger } from "../../src/lib/logger";

// Read-only popup stub. Renders a neutral connection state; no actions yet.
// The device-token read was removed with the storage deviceToken key.
// TODO(phase-2): read the OAuth auth blob and render Connected / Not connected.
// TODO(phase-3): real popup UI (sync status, manual sync, connect flow).

const STATUS = "Not connected. Connect your gubbi account to start syncing.";

function render(): void {
  const root = document.getElementById("app");
  if (root === null) return;
  root.textContent = STATUS;
}

try {
  render();
} catch (error: unknown) {
  logger.error("popup render failed", { error: String(error) });
}
