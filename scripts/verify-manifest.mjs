// Post-build verification gate. Asserts both browser manifests are MV3 with the
// expected background shape, permissions, and host permissions, and that the
// fetch.ts egress allowlist is a subset of the manifest host permissions.
//
// Run after `wxt build` for both browsers: `node scripts/verify-manifest.mjs`.
// Exit 0 = all assertions pass; exit 1 = a mismatch (details printed).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

const EXPECTED_PERMISSIONS = ["alarms", "identity", "storage"];
const EXPECTED_HOST_PERMISSIONS = [
  "https://api.gubbi.ai/*",
  "https://auth.gubbi.ai/*",
  "https://chatgpt.com/*",
  "https://claude.ai/*",
];

// Mirrors src/lib/net/fetch.ts hostFrom + defaults; kept in sync deliberately
// so the gate is an independent re-derivation of the allowed egress hosts.
function hostFrom(value) {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    try {
      return new URL(`https://${value}`).host;
    } catch {
      return undefined;
    }
  }
}

function allowedEgressHosts() {
  const apiHost = hostFrom(process.env.VITE_API_BASE_URL) ?? "api.gubbi.ai";
  const authHost = hostFrom(process.env.VITE_AUTH_HOST) ?? "auth.gubbi.ai";
  return new Set([apiHost, authHost]);
}

function sortedEqual(actual, expected) {
  if (!Array.isArray(actual)) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function hostOfPattern(pattern) {
  try {
    return new URL(pattern.replace(/\*$/, "")).host;
  } catch {
    return undefined;
  }
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
  if (typeof gecko.id !== "string" || gecko.id.length === 0) {
    errors.push("expected browser_specific_settings.gecko.id");
  }
  if (gecko.strict_min_version !== "121.0") {
    errors.push(
      `gecko.strict_min_version is ${JSON.stringify(gecko.strict_min_version)}, expected "121.0"`,
    );
  }
  if (!gecko.data_collection_permissions) {
    errors.push("expected gecko.data_collection_permissions (AMO requirement)");
  }
}

// Chrome MV3 must NOT carry any gecko / browser_specific_settings, and the
// `key` field is present IFF WXT_CHROME_KEY was set at build time. Build and
// verify run in the same `pnpm verify` shell, so the env is observable here.
function checkChromeSpecific(manifest, errors) {
  if (manifest.browser_specific_settings) {
    errors.push("chrome-mv3 must not carry browser_specific_settings / gecko fields");
  }
  const expectKey = Boolean(process.env.WXT_CHROME_KEY);
  const hasKey = typeof manifest.key === "string" && manifest.key.length > 0;
  if (expectKey && !hasKey) {
    errors.push("expected manifest.key when WXT_CHROME_KEY is set");
  }
  if (!expectKey && hasKey) {
    errors.push("unexpected manifest.key when WXT_CHROME_KEY is unset");
  }
}

function checkManifest(browserKey, expectBackground) {
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
  if (!sortedEqual(manifest.host_permissions, EXPECTED_HOST_PERMISSIONS)) {
    errors.push(
      `host_permissions ${JSON.stringify(manifest.host_permissions)} != ` +
        JSON.stringify(EXPECTED_HOST_PERMISSIONS),
    );
  }

  const background = manifest.background ?? {};
  if (expectBackground === "service_worker" && typeof background.service_worker !== "string") {
    errors.push("expected background.service_worker (Chrome MV3)");
  }
  if (expectBackground === "scripts" && !Array.isArray(background.scripts)) {
    errors.push("expected background.scripts event page (Firefox MV3)");
  }

  const permittedHosts = new Set(
    (manifest.host_permissions ?? []).map(hostOfPattern).filter(Boolean),
  );
  for (const host of allowedEgressHosts()) {
    if (!permittedHosts.has(host)) {
      errors.push(`egress host ${host} not covered by any host_permission`);
    }
  }

  if (browserKey === "firefox-mv3") checkFirefoxSpecific(manifest, errors);
  if (browserKey === "chrome-mv3") checkChromeSpecific(manifest, errors);

  return errors;
}

function main() {
  const targets = [
    ["chrome-mv3", "service_worker"],
    ["firefox-mv3", "scripts"],
  ];
  let failed = false;
  for (const [browserKey, expectBackground] of targets) {
    let errors;
    try {
      errors = checkManifest(browserKey, expectBackground);
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
          `permissions + host_permissions match, egress allowlist is a subset.`,
      );
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
