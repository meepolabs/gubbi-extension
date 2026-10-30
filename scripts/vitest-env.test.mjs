import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The unit tests assert the default endpoint hosts, so a deployment's
// .env.local must not reach them. Runs the repo's real vitest.config.ts against
// a temp root holding a synthetic .env.local and a probe test that fails if
// Vite loaded it into import.meta.env.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");
const REPO_CONFIG = join(REPO, "vitest.config.ts");

const DEV_ENV =
  "VITE_API_BASE_URL=https://api.dev.example.test\nVITE_AUTH_HOST=auth.dev.example.test\n";

const PROBE = `import { expect, it } from "vitest";

it("sees no endpoint value from an env file", () => {
  expect(import.meta.env.VITE_API_BASE_URL).toBeUndefined();
  expect(import.meta.env.VITE_AUTH_HOST).toBeUndefined();
});
`;

const CONFIG_WITHOUT_ENV_DIR = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
`;

// Vitest mirrors process.env into import.meta.env, so a VITE_* value in the
// caller's shell would fail the probe for a reason unrelated to env files.
function envWithoutViteVars() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_")),
  );
}

function runProbe(root, configPath) {
  return spawnSync(process.execPath, [VITEST, "run", "--config", configPath, "--root", root], {
    cwd: root,
    env: envWithoutViteVars(),
    encoding: "utf8",
  });
}

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vitest-env-"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "probe.test.ts"), PROBE);
  writeFileSync(join(root, ".env.local"), DEV_ENV);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("vitest env loading", () => {
  it("does not load .env.local into import.meta.env under the repo config", () => {
    // Act
    const result = runProbe(root, REPO_CONFIG);

    // Assert
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /1 passed/);
  });

  it("control: the probe fails when the config leaves Vite env loading on", () => {
    // Arrange
    const configPath = join(root, "vitest.config.ts");
    writeFileSync(configPath, CONFIG_WITHOUT_ENV_DIR);

    // Act
    const result = runProbe(root, configPath);

    // Assert
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /1 failed/);
  });
});
