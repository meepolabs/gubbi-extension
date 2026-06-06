import { logger } from "../../src/lib/logger";

// Options page stub. Renders a neutral connection state; no actions yet.
// The device-token read was removed with the storage deviceToken key.
// TODO(phase-2): read the OAuth auth blob and render the real connection state.
// TODO(phase-3): connection management, sync preferences.

const STATUS = "Not connected. Connect your gubbi account to start syncing.";

function render(): void {
  const root = document.getElementById("app");
  if (root === null) return;
  root.textContent = STATUS;
}

try {
  render();
} catch (error: unknown) {
  logger.error("options render failed", { error: String(error) });
}
