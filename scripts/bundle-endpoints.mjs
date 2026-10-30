// Reads the endpoint values a built extension actually ships. The egress
// allowlist (src/lib/net/fetch.ts) passes each variable's name as a string
// literal next to its build-time value, so the minified bundle carries
// `"VITE_AUTH_HOST",<value>` where <value> is `void 0` (unset) or the string
// literal Vite inlined. Reading those pairs back checks the shipped allowlist
// itself rather than a re-derivation of the env that should have produced it.
//
// Fails closed on any shape it does not recognise: a name occurrence not
// followed by a plain literal, an escape sequence or template interpolation in
// the literal, sites that disagree, or a variable with no site at all.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UNSET_FORMS = new Set(["void 0", "undefined"]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sitePattern(name) {
  const quoted = `(["'\`])${escapeRegExp(name)}\\1`;
  const value = String.raw`void 0|undefined|"[^"\\]*"|'[^'\\]*'|\`[^\`\\$]*\``;
  return new RegExp(`${quoted}\\s*,\\s*(${value})(?=\\s*[,)])`, "g");
}

function literalValue(token) {
  return UNSET_FORMS.has(token) ? undefined : token.slice(1, -1);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function valueOf(name, sources) {
  const values = new Set();
  let sites = 0;
  for (const source of sources) {
    const matches = [...source.matchAll(sitePattern(name))];
    if (matches.length !== countOccurrences(source, name)) {
      throw new Error(`${name} appears in the bundle in an unrecognised form`);
    }
    sites += matches.length;
    for (const match of matches) values.add(literalValue(match[2]));
  }
  if (sites === 0) throw new Error(`${name} not found in the bundle`);
  if (values.size !== 1) throw new Error(`${name} has conflicting values in the bundle`);
  return [...values][0];
}

/**
 * @param {readonly string[]} names
 * @param {readonly string[]} sources
 * @returns {Record<string, string | undefined>}
 */
export function bundleEndpointEnv(names, sources) {
  return Object.fromEntries(names.map((name) => [name, valueOf(name, sources)]));
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
export function readBundleSources(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .toSorted()
    .map((file) => readFileSync(join(dir, file), "utf8"));
}
