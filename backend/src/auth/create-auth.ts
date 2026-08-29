import type { Clock } from "../clock.js";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/database.js";
import { BearerUserAdapter, type AuthenticationAdapter } from "./adapter.js";
import { CognitoJwtAdapter, createCognitoJwtVerifier } from "./cognito-adapter.js";

export function isDevLoginEnabled(config: AppConfig): boolean {
  return config.authMode === "dev" && config.devAuth;
}

export function createAuthentication(
  config: AppConfig,
  db: Database,
  clock: Clock,
): AuthenticationAdapter {
  if (config.authMode === "dev") {
    return new BearerUserAdapter(db);
  }

  if (!config.cognitoUserPoolId || !config.cognitoClientId) {
    throw new Error(
      "PACKPROOF_COGNITO_USER_POOL_ID and PACKPROOF_COGNITO_CLIENT_ID are required when PACKPROOF_AUTH_MODE=cognito",
    );
  }

  return new CognitoJwtAdapter(
    db,
    clock,
    createCognitoJwtVerifier({
      userPoolId: config.cognitoUserPoolId,
      clientId: config.cognitoClientId,
    }),
  );
}
