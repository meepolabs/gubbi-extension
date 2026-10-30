// Post-build verification gate. Asserts both browser manifests are MV3 with the
// expected background shape and permissions, that host_permissions is exactly
// the set the build env yields (content hosts plus the API and auth hosts the
// egress allowlist allows), and that the Chrome key and Firefox gecko id match
// the pinned browser identities.
//
// Run after `wxt build` for both browsers: `node scripts/verify-manifest.mjs`.
// Exit 0 = all assertions pass; exit 1 = a mismatch (details printed).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { chromeIdFromKey } from "./extension-id.mjs";
import { endpointHosts, hostPermissions } from "./host-permissions.mjs";

const ROOT = process.cwd();
const BUILD_MODE = "production";
const ENDPOINT_VARIABLES = ["VITE_API_BASE_URL", "VITE_AUTH_HOST"];

const EXPECTED_PERMISSIONS = ["alarms", "identity", "storage"];

// Typed out independently of scripts/browser-identity.mjs so a swapped key or
// gecko id fails here instead of passing by construction. Both are permanent
// from the first Chrome Web Store / AMO publish: Hydra registers the redirect
// URIs derived from them.
export const EXPECTED_CHROME_ID = "afkainjmkhdpnllolcfljoiojcgojppf";
export const EXPECTED_GECKO_ID = "gubbi-extension@gubbi.ai";

// The env-file list and precedence of WXT's loadEnv (wxt/dist/core/utils/env.mjs)
// for `wxt build`: later files win, then a non-empty shell value wins over all
// files. WXT also runs dotenv-expand over the values; this loader does not, so
// a "$" reference is passed through and fails the endpoint parser rather than
// verifying against a value the build never saw.
function envFiles(browser) {
  return [
    ".env",
    ".env.local",
    `.env.${BUILD_MODE}`,
    `.env.${BUILD_MODE}.local`,
    `.env.${browser}`,
    `.env.${browser}.local`,
    `.env.${BUILD_MODE}.${browser}`,
    `.env.${BUILD_MODE}.${browser}.local`,
  ];
}

function loadBuildEnv(browser) {
  const env = {};
  for (const file of envFiles(browser)) {
    const path = resolve(ROOT, file);
    if (existsSync(path)) Object.assign(env, parseEnv(readFileSync(path, "utf8")));
  }
  for (const name of ENDPOINT_VARIABLES) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return Object.fromEntries(ENDPOINT_VARIABLES.map((name) => [name, env[name]]));
}

function sortedEqual(actual, expected) {
  if (!Array.isArray(actual)) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function readManifest(browserKey) {
  const file = resolve(ROOT, ".output", browserKey, "manifest.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

// Firefox MV3 must carry a gecko id, the pinned strict_min_version, and the
// AMO-required data collection declaration.
function checkFirefoxSpecific(manifest, errors) {
  const gecko = manifest.browser_specific_settings?.gecko;
  if (!gecko) {
    errors.push("expected browser_specific_settings.gecko (Firefox MV3)");
    return;
  }
  errors.push(...checkFirefoxIdentity(gecko));
  if (gecko.strict_min_version !== "121.0") {
    errors.push(
      `gecko.strict_min_version is ${JSON.stringify(gecko.strict_min_version)}, expected "121.0"`,
    );
  }
  if (!gecko.data_collection_permissions) {
    errors.push("expected gecko.data_collection_permissions (AMO requirement)");
  }
}

/**
 * @param {{ id?: unknown }} gecko
 * @returns {string[]}
 */
export function checkFirefoxIdentity(gecko) {
  if (gecko.id !== EXPECTED_GECKO_ID) {
    return [
      `gecko.id is ${JSON.stringify(gecko.id)}, expected ${JSON.stringify(EXPECTED_GECKO_ID)}`,
    ];
  }
  return [];
}

/**
 * Chromium rejects a `key` that is not valid base64, so only the canonical
 * encoding is accepted rather than whatever a lenient decoder would salvage.
 * @param {{ key?: unknown }} manifest
 * @returns {string[]}
 */
export function checkChromeIdentity(manifest) {
  const key = manifest.key;
  if (typeof key !== "string" || key.length === 0) {
    return ["expected manifest.key (pins the Chrome extension ID)"];
  }
  if (Buffer.from(key, "base64").toString("base64") !== key) {
    return ["manifest.key is not canonical base64"];
  }
  const id = chromeIdFromKey(key);
  if (id !== EXPECTED_CHROME_ID) {
    return [`manifest.key derives Chrome ID ${id}, expected ${EXPECTED_CHROME_ID}`];
  }
  return [];
}

// Chrome MV3 must NOT carry any gecko / browser_specific_settings, and must
// carry the key that derives the pinned extension ID.
function checkChromeSpecific(manifest, errors) {
  if (manifest.browser_specific_settings) {
    errors.push("chrome-mv3 must not carry browser_specific_settings / gecko fields");
  }
  errors.push(...checkChromeIdentity(manifest));
}

function checkHostPermissions(manifest, browser, errors) {
  let expected;
  let egress;
  try {
    const env = loadBuildEnv(browser);
    expected = hostPermissions(env);
    egress = endpointHosts(env);
  } catch (err) {
    errors.push(`build env: ${err.message}`);
    return;
  }
  const actual = manifest.host_permissions;
  if (!sortedEqual(actual, expected)) {
    errors.push(`host_permissions ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  for (const host of egress) {
    if (!Array.isArray(actual) || !actual.includes(`https://${host}/*`)) {
      errors.push(`egress host ${host} not covered by an exact host_permission`);
    }
  }
}

function checkManifest(browserKey, browser, expectBackground) {
  const errors = [];
  const manifest = readManifest(browserKey);

  if (manifest.manifest_version !== 3) {
    errors.push(`manifest_version is ${manifest.manifest_version}, expected 3`);
  }
  if (!sortedEqual(manifest.permissions, EXPECTED_PERMISSIONS)) {
    errors.push(
      `permissions ${JSON.stringify(manifest.permissions)} != ${JSON.stringify(EXPECTED_PERMISSIONS)}`,
    );
  }
  checkHostPermissions(manifest, browser, errors);

  const background = manifest.background ?? {};
  if (expectBackground === "service_worker" && typeof background.service_worker !== "string") {
    errors.push("expected background.service_worker (Chrome MV3)");
  }
  if (expectBackground === "scripts" && !Array.isArray(background.scripts)) {
    errors.push("expected background.scripts event page (Firefox MV3)");
  }

  if (browserKey === "firefox-mv3") checkFirefoxSpecific(manifest, errors);
  if (browserKey === "chrome-mv3") checkChromeSpecific(manifest, errors);

  return errors;
}

function main() {
  const targets = [
    ["chrome-mv3", "chrome", "service_worker"],
    ["firefox-mv3", "firefox", "scripts"],
  ];
  let failed = false;
  for (const [browserKey, browser, expectBackground] of targets) {
    let errors;
    try {
      errors = checkManifest(browserKey, browser, expectBackground);
    } catch (err) {
      failed = true;
      if (err && err.code === "ENOENT") {
        console.error(
          `verify-manifest FAILED for ${browserKey}: manifest not found. ` +
            "Run `wxt build` before verify-manifest.",
        );
      } else {
        console.error(`verify-manifest FAILED for ${browserKey}: ${err?.message ?? err}`);
      }
      continue;
    }
    if (errors.length > 0) {
      failed = true;
      console.error(`verify-manifest FAILED for ${browserKey}:`);
      for (const error of errors) console.error(`  - ${error}`);
    } else {
      console.log(
        `verify-manifest OK for ${browserKey}: MV3, ${expectBackground} background, ` +
          `permissions match, host_permissions equal the build env set, identity pinned.`,
      );
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
