import { describe, expect, it } from "vitest";

import { buildAuthorizeUrl } from "../../src/lib/auth/authorize-url";

const REDIRECT_URI = "https://abcdef.chromiumapp.org/";

describe("buildAuthorizeUrl", () => {
  it("targets the /oauth2/auth endpoint on the configured auth host", () => {
    // Arrange / Act
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: REDIRECT_URI,
        state: "state-123",
        codeChallenge: "challenge-abc",
      }),
    );

    // Assert
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("auth.gubbi.ai");
    expect(url.pathname).toBe("/oauth2/auth");
  });

  it("includes exactly the required authorization-code + PKCE params", () => {
    // Arrange / Act
    const params = new URL(
      buildAuthorizeUrl({
        redirectUri: REDIRECT_URI,
        state: "state-123",
        codeChallenge: "challenge-abc",
      }),
    ).searchParams;

    // Assert
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("journal-extension");
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("scope")).toBe("journal offline_access");
    expect(params.get("state")).toBe("state-123");
    expect(params.get("code_challenge")).toBe("challenge-abc");
    expect(params.get("code_challenge_method")).toBe("S256");
  });
});
