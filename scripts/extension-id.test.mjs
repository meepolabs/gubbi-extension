import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHROME_KEY, GECKO_ID } from "./browser-identity.mjs";
import { chromeExtensionId, chromeIdFromKey, firefoxRedirectHost } from "./extension-id.mjs";
import { checkChromeIdentity, checkFirefoxIdentity } from "./verify-manifest.mjs";

describe("extension id derivation", () => {
  it("matches the Chromium id_util unittest vector for the bytes of 'test'", () => {
    assert.equal(chromeExtensionId(Buffer.from("test")), "jpignaibiiemhngfjkcpokkamffknabf");
  });

  it("derives the pinned Chrome id from the committed public key", () => {
    assert.equal(chromeIdFromKey(CHROME_KEY), "afkainjmkhdpnllolcfljoiojcgojppf");
  });

  it("derives the Firefox identity redirect host from the gecko id", () => {
    assert.equal(
      firefoxRedirectHost(GECKO_ID),
      "d67283d49ef103004467ac3339488c5fa148fc0d.extensions.allizom.org",
    );
  });
});

function withOneCharChanged(key) {
  const at = Math.floor(key.length / 2);
  const replacement = key[at] === "A" ? "B" : "A";
  return key.slice(0, at) + replacement + key.slice(at + 1);
}

describe("verify-manifest browser identity", () => {
  it("accepts the committed Chrome key", () => {
    assert.deepEqual(checkChromeIdentity({ key: CHROME_KEY }), []);
  });

  const chromeRejects = [
    { name: "missing key", manifest: {} },
    { name: "empty key", manifest: { key: "" } },
    { name: "one key char changed", manifest: { key: withOneCharChanged(CHROME_KEY) } },
    { name: "non-canonical base64", manifest: { key: `${CHROME_KEY}\n` } },
  ];
  for (const { name, manifest } of chromeRejects) {
    it(`rejects a Chrome manifest with ${name}`, () => {
      assert.notDeepEqual(checkChromeIdentity(manifest), []);
    });
  }

  it("accepts the committed gecko id", () => {
    assert.deepEqual(checkFirefoxIdentity({ id: GECKO_ID }), []);
  });

  const firefoxRejects = [
    { name: "missing gecko id", gecko: {} },
    { name: "different gecko id", gecko: { id: "gubbi-extension@gubbi.example.test" } },
    { name: "case-changed gecko id", gecko: { id: GECKO_ID.toUpperCase() } },
  ];
  for (const { name, gecko } of firefoxRejects) {
    it(`rejects a Firefox manifest with ${name}`, () => {
      assert.notDeepEqual(checkFirefoxIdentity(gecko), []);
    });
  }
});
