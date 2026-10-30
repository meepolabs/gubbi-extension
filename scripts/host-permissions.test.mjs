import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hostPermissions } from "./host-permissions.mjs";

describe("hostPermissions", () => {
  it("emits the four prod patterns when no endpoint variable is set", () => {
    assert.deepEqual(hostPermissions({}), [
      "https://api.gubbi.ai/*",
      "https://auth.gubbi.ai/*",
      "https://chatgpt.com/*",
      "https://claude.ai/*",
    ]);
  });

  it("emits exact patterns for configured endpoint hosts", () => {
    const env = {
      VITE_API_BASE_URL: "https://api.dev.example.test",
      VITE_AUTH_HOST: "auth.dev.example.test",
    };

    assert.deepEqual(hostPermissions(env), [
      "https://api.dev.example.test/*",
      "https://auth.dev.example.test/*",
      "https://chatgpt.com/*",
      "https://claude.ai/*",
    ]);
  });

  it("collapses an endpoint host shared by both variables into one pattern", () => {
    const env = { VITE_API_BASE_URL: "dev.example.test", VITE_AUTH_HOST: "dev.example.test" };

    assert.deepEqual(hostPermissions(env), [
      "https://chatgpt.com/*",
      "https://claude.ai/*",
      "https://dev.example.test/*",
    ]);
  });

  const invalid = [
    { name: "VITE_AUTH_HOST", env: { VITE_AUTH_HOST: "x.test:8443" } },
    { name: "VITE_AUTH_HOST", env: { VITE_AUTH_HOST: "" } },
    { name: "VITE_API_BASE_URL", env: { VITE_API_BASE_URL: "https://*.example.test" } },
    { name: "VITE_API_BASE_URL", env: { VITE_API_BASE_URL: "127.0.0.1" } },
  ];
  for (const { name, env } of invalid) {
    it(`throws naming ${name} for ${JSON.stringify(env[name])} instead of using the default`, () => {
      assert.throws(() => hostPermissions(env), new RegExp(`^Error: ${name} must be`));
    });
  }
});
