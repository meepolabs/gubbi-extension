import { createHash } from "node:crypto";

const CHROME_ID_HEX_LENGTH = 32;
const FIREFOX_REDIRECT_DOMAIN = "extensions.allizom.org";

/**
 * Chromium's crx_file::id_util::GenerateId: SHA-256 of the DER public key,
 * first 16 bytes as hex, each hex digit 0-f mapped to a-p.
 * @param {Uint8Array} derKey
 * @returns {string}
 */
export function chromeExtensionId(derKey) {
  const hex = createHash("sha256").update(derKey).digest("hex").slice(0, CHROME_ID_HEX_LENGTH);
  return Array.from(hex, (digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

/**
 * @param {string} base64Key manifest `key` value (base64 DER)
 * @returns {string}
 */
export function chromeIdFromKey(base64Key) {
  return chromeExtensionId(Buffer.from(base64Key, "base64"));
}

/**
 * Host of Firefox's identity.getRedirectURL(): sha1 hex of the add-on id under
 * the default identity.redirectDomain pref.
 * @param {string} geckoId
 * @returns {string}
 */
export function firefoxRedirectHost(geckoId) {
  return `${createHash("sha1").update(geckoId).digest("hex")}.${FIREFOX_REDIRECT_DOMAIN}`;
}
