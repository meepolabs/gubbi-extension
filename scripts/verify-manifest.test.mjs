import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { CHROME_KEY, GECKO_ID } from "./browser-identity.mjs";

const VERIFIER = fileURLToPath(new URL("./verify-manifest.mjs", import.meta.url));

const PROD_HOSTS = [
  "https://chatgpt.com/*",
  "https://claude.ai/*",
  "https://api.gubbi.ai/*",
  "https://auth.gubbi.ai/*",
];
const DEV_HOSTS = [
  "https://chatgpt.com/*",
  "https://claude.ai/*",
  "https://api.dev.example.test/*",
  "https://auth.dev.example.test/*",
];
const DEV_ENV =
  "VITE_API_BASE_URL=https://api.dev.example.test\nVITE_AUTH_HOST=auth.dev.example.test\n";

function chromeManifest(hostPermissions) {
  return {
    manifest_version: 3,
    permissions: ["storage", "alarms", "identity"],
    host_permissions: hostPermissions,
    background: { service_worker: "background.js" },
    key: CHROME_KEY,
  };
}

function firefoxManifest(hostPermissions) {
  return {
    manifest_version: 3,
    permissions: ["storage", "alarms", "identity"],
    host_permissions: hostPermissions,
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: "121.0",
        data_collection_permissions: { required: ["personalCommunications"] },
      },
    },
  };
}

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-manifest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The shape the minified egress allowlist takes in a real build: each
// endpoint variable's name followed by its inlined value (`void 0` when unset).
function allowlistSource({ api, auth }) {
  const value = (host) => (host === undefined ? "void 0" : JSON.stringify(host));
  return (
    `const Jf=new Set([Cn("VITE_API_BASE_URL",${value(api)},Xr),` +
    `Cn("VITE_AUTH_HOST",${value(auth)},Qr)].filter(e=>e!==void 0));`
  );
}

function bundleHosts(hostPermissions) {
  const hosts = hostPermissions.map((pattern) => pattern.slice("https://".length, -"/*".length));
  return {
    api: hosts.find((host) => host.startsWith("api.")),
    auth: hosts.find((host) => host.startsWith("auth.")),
  };
}

function writeBundle(browserKey, source) {
  mkdirSync(join(dir, ".output", browserKey), { recursive: true });
  writeFileSync(join(dir, ".output", browserKey, "background.js"), source);
}

// Each bundle defaults to the allowlist matching its manifest, so only the
// rows that pass `bundles` exercise a bundle that disagrees.
function writeManifests({ chrome, firefox, bundles = {} }) {
  for (const [browserKey, manifest] of [
    ["chrome-mv3", chromeManifest(chrome)],
    ["firefox-mv3", firefoxManifest(firefox)],
  ]) {
    mkdirSync(join(dir, ".output", browserKey), { recursive: true });
    writeFileSync(join(dir, ".output", browserKey, "manifest.json"), JSON.stringify(manifest));
    const source =
      browserKey in bundles
        ? bundles[browserKey]
        : allowlistSource(bundleHosts(manifest.host_permissions));
    if (source !== null) writeBundle(browserKey, source);
  }
}

function writeEnvFiles(files) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

function runVerifier(shellEnv = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITE_")),
  );
  const result = spawnSync(process.execPath, [VERIFIER], {
    cwd: dir,
    env: { ...env, ...shellEnv },
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  return {
    status: result.status,
    output,
    passed: (browserKey) => output.includes(`verify-manifest OK for ${browserKey}`),
    failed: (browserKey) => output.includes(`verify-manifest FAILED for ${browserKey}`),
  };
}

describe("verify-manifest host_permissions against the build env", () => {
  it("passes prod manifests when no env file or shell value is set", () => {
    writeManifests({ chrome: PROD_HOSTS, firefox: PROD_HOSTS });

    const result = runVerifier();

    assert.equal(result.status, 0, result.output);
  });

  it("fails prod manifests when .env.local sets DEV hosts", () => {
    writeManifests({ chrome: PROD_HOSTS, firefox: PROD_HOSTS });
    writeEnvFiles({ ".env.local": DEV_ENV });

    const result = runVerifier();

    assert.equal(result.status, 1, result.output);
    assert.ok(result.failed("chrome-mv3") && result.failed("firefox-mv3"), result.output);
  });

  it("passes manifests carrying exactly the DEV set from .env.local", () => {
    writeManifests({ chrome: DEV_HOSTS, firefox: DEV_HOSTS });
    writeEnvFiles({ ".env.local": DEV_ENV });

    const result = runVerifier();

    assert.equal(result.status, 0, result.output);
  });

  const rejectedHostSets = [
    { name: "an extra host", hosts: [...DEV_HOSTS, "https://other.example.test/*"] },
    { name: "a wildcard host", hosts: [...DEV_HOSTS, "https://*.example.test/*"] },
    { name: "a duplicated host", hosts: [...DEV_HOSTS, "https://claude.ai/*"] },
    { name: "a missing host", hosts: DEV_HOSTS.slice(1) },
  ];
  for (const { name, hosts } of rejectedHostSets) {
    it(`fails a manifest carrying the DEV set plus ${name}`, () => {
      writeManifests({ chrome: hosts, firefox: DEV_HOSTS });
      writeEnvFiles({ ".env.local": DEV_ENV });

      const result = runVerifier();

      assert.equal(result.status, 1, result.output);
      assert.ok(result.failed("chrome-mv3") && result.passed("firefox-mv3"), result.output);
    });
  }

  it("applies .env.firefox.local only to the firefox-mv3 check", () => {
    const firefoxHosts = [...DEV_HOSTS.slice(0, 3), "https://auth.ff.example.test/*"];
    writeEnvFiles({
      ".env.local": DEV_ENV,
      ".env.firefox.local": "VITE_AUTH_HOST=auth.ff.example.test\n",
    });

    writeManifests({ chrome: DEV_HOSTS, firefox: firefoxHosts });
    const matched = runVerifier();
    writeManifests({ chrome: firefoxHosts, firefox: DEV_HOSTS });
    const swapped = runVerifier();

    assert.equal(matched.status, 0, matched.output);
    assert.ok(swapped.failed("chrome-mv3") && swapped.failed("firefox-mv3"), swapped.output);
  });

  it("lets a later production env file override an earlier one", () => {
    writeManifests({ chrome: DEV_HOSTS, firefox: DEV_HOSTS });
    writeEnvFiles({
      ".env": "VITE_API_BASE_URL=api.base.example.test\nVITE_AUTH_HOST=auth.dev.example.test\n",
      ".env.production.local": "VITE_API_BASE_URL=api.dev.example.test\n",
    });

    const result = runVerifier();

    assert.equal(result.status, 0, result.output);
  });

  it("ignores development-mode env files", () => {
    writeManifests({ chrome: PROD_HOSTS, firefox: PROD_HOSTS });
    writeEnvFiles({ ".env.development.local": DEV_ENV, ".env.development.chrome": DEV_ENV });

    const result = runVerifier();

    assert.equal(result.status, 0, result.output);
  });

  it("lets a non-empty shell value win over env files", () => {
    const shellHosts = [...DEV_HOSTS.slice(0, 3), "https://auth.shell.example.test/*"];
    writeManifests({ chrome: shellHosts, firefox: shellHosts });
    writeEnvFiles({ ".env.local": DEV_ENV });

    const result = runVerifier({ VITE_AUTH_HOST: "auth.shell.example.test" });

    assert.equal(result.status, 0, result.output);
  });

  it("keeps the env file value when the shell value is empty", () => {
    writeManifests({ chrome: DEV_HOSTS, firefox: DEV_HOSTS });
    writeEnvFiles({ ".env.local": DEV_ENV });

    const result = runVerifier({ VITE_AUTH_HOST: "" });

    assert.equal(result.status, 0, result.output);
  });

  const invalidEnvValues = [
    { name: "a port", file: "VITE_AUTH_HOST=auth.gubbi.ai:8443\n" },
    { name: "an empty value", file: "VITE_AUTH_HOST=\n" },
    { name: "a path", file: "VITE_API_BASE_URL=https://api.gubbi.ai/v1\n" },
    { name: "a variable reference", file: "VITE_AUTH_HOST=${OTHER_HOST}\n" },
  ];
  for (const { name, file } of invalidEnvValues) {
    it(`fails instead of falling back to prod when an env value carries ${name}`, () => {
      writeManifests({ chrome: PROD_HOSTS, firefox: PROD_HOSTS });
      writeEnvFiles({ ".env.local": file });

      const result = runVerifier();

      assert.equal(result.status, 1, result.output);
    });
  }
});

describe("verify-manifest host_permissions against the shipped bundle", () => {
  const EVIL_AUTH_BUNDLE = allowlistSource({ auth: "auth.evil.example.test" });
  const EVIL_API_BUNDLE = allowlistSource({ api: "api.evil.example.test" });

  // Lines node:util parseEnv skips but the bundler's dotenv reads: the env
  // re-derivation sees prod while the build inlined another host.
  const divergentEnvFiles = [
    {
      name: "a colon-form assignment",
      file: "VITE_AUTH_HOST: auth.evil.example.test\n",
      bundle: EVIL_AUTH_BUNDLE,
    },
    {
      name: "a byte order mark before the first assignment",
      file: "\uFEFFVITE_API_BASE_URL=https://api.evil.example.test\n",
      bundle: EVIL_API_BUNDLE,
    },
  ];
  for (const { name, file, bundle } of divergentEnvFiles) {
    it(`fails prod manifests whose bundle allowlists another host after ${name} in .env`, () => {
      writeEnvFiles({ ".env": file });
      writeManifests({
        chrome: PROD_HOSTS,
        firefox: PROD_HOSTS,
        bundles: { "chrome-mv3": bundle, "firefox-mv3": bundle },
      });

      const result = runVerifier();

      assert.equal(result.status, 1, result.output);
      assert.ok(result.failed("chrome-mv3") && result.failed("firefox-mv3"), result.output);
      assert.match(result.output, /bundle allowlist/);
    });
  }

  it("passes when the bundle carries the prod hosts as literals", () => {
    const literal = allowlistSource({ api: "https://api.gubbi.ai", auth: "auth.gubbi.ai" });
    writeManifests({
      chrome: PROD_HOSTS,
      firefox: PROD_HOSTS,
      bundles: { "chrome-mv3": literal, "firefox-mv3": literal },
    });

    const result = runVerifier();

    assert.equal(result.status, 0, result.output);
  });

  it("reads the allowlist from a nested chunk", () => {
    writeManifests({
      chrome: DEV_HOSTS,
      firefox: DEV_HOSTS,
      bundles: { "chrome-mv3": "const x=1;" },
    });
    mkdirSync(join(dir, ".output", "chrome-mv3", "chunks"), { recursive: true });
    writeFileSync(
      join(dir, ".output", "chrome-mv3", "chunks", "fetch-abc.js"),
      allowlistSource(bundleHosts(DEV_HOSTS)),
    );
    writeEnvFiles({ ".env.local": DEV_ENV });

    const result = runVerifier();

    assert.equal(result.status, 0, result.output);
  });

  const unreadableBundles = [
    { name: "no script at all", source: null },
    { name: "no allowlist in the scripts", source: "const x=1;" },
    {
      name: "a computed value",
      source: 'Cn("VITE_API_BASE_URL",a+b,Xr),Cn("VITE_AUTH_HOST",void 0,Qr)',
    },
    {
      name: "an escape sequence in the value",
      source:
        'Cn("VITE_API_BASE_URL",void 0,Xr),Cn("VITE_AUTH_HOST","auth.evil\\x2eexample.test",Qr)',
    },
    {
      name: "conflicting values at two sites",
      source: `${allowlistSource({})}${allowlistSource({ auth: "auth.evil.example.test" })}`,
    },
  ];
  for (const { name, source } of unreadableBundles) {
    it(`fails closed on a bundle with ${name}`, () => {
      writeManifests({
        chrome: PROD_HOSTS,
        firefox: PROD_HOSTS,
        bundles: { "chrome-mv3": source },
      });

      const result = runVerifier();

      assert.equal(result.status, 1, result.output);
      assert.ok(result.failed("chrome-mv3") && result.passed("firefox-mv3"), result.output);
      assert.match(result.output, /bundle allowlist/);
    });
  }
});
