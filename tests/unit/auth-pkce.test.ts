import { describe, expect, it } from "vitest";

import { generatePkce, VERIFIER_MAX_LEN, VERIFIER_MIN_LEN } from "../../src/lib/auth/pkce";

// RFC 7636 Appendix B test vector: the canonical verifier maps to a known
// S256 challenge. This anchors the SHA-256 + base64url implementation.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const BASE64URL_CHARSET = /^[A-Za-z0-9\-_]+$/;

describe("PKCE S256", () => {
  it("derives the RFC 7636 challenge from the RFC verifier", async () => {
    // Arrange / Act
    const challenge = await import("../../src/lib/auth/pkce").then((m) =>
      m.challengeFromVerifier(RFC_VERIFIER),
    );

    // Assert
    expect(challenge).toBe(RFC_CHALLENGE);
  });

  it("generates a verifier within the RFC length bounds", async () => {
    // Arrange / Act
    const { codeVerifier } = await generatePkce();

    // Assert
    expect(codeVerifier.length).toBeGreaterThanOrEqual(VERIFIER_MIN_LEN);
    expect(codeVerifier.length).toBeLessThanOrEqual(VERIFIER_MAX_LEN);
  });

  it("generates a verifier using only the base64url charset", async () => {
    // Arrange / Act
    const { codeVerifier } = await generatePkce();

    // Assert
    expect(codeVerifier).toMatch(BASE64URL_CHARSET);
  });

  it("generates a challenge that round-trips against its own verifier", async () => {
    // Arrange / Act
    const { codeVerifier, codeChallenge } = await generatePkce();
    const recomputed = await import("../../src/lib/auth/pkce").then((m) =>
      m.challengeFromVerifier(codeVerifier),
    );

    // Assert
    expect(codeChallenge).toBe(recomputed);
  });

  it("produces a distinct verifier on each call", async () => {
    // Arrange / Act
    const a = await generatePkce();
    const b = await generatePkce();

    // Assert
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});
