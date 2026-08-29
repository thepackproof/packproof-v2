import { describe, expect, it } from "vitest";
import { createCognitoJwtVerifier } from "../src/auth/cognito-adapter.js";
import { loadConfig } from "../src/config.js";

const enabled = process.env.PACKPROOF_COGNITO_INTEGRATION === "1";

describe.skipIf(!enabled)("opt-in live Cognito integration", () => {
  it("rejects an unsigned token against the configured User Pool", async () => {
    const config = loadConfig(process.env);
    expect(config.authMode).toBe("cognito");
    expect(config.cognitoUserPoolId).toBeTruthy();
    expect(config.cognitoClientId).toBeTruthy();

    const verifier = createCognitoJwtVerifier({
      userPoolId: config.cognitoUserPoolId as string,
      clientId: config.cognitoClientId as string,
    });

    await expect(verifier.verify("not-a-real-cognito-jwt")).rejects.toBeTruthy();
  });
});
