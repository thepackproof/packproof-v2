import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { DomainError } from "../domain/errors.js";
import { ensureIdentityUser } from "../domain/users.js";
import {
  extractBearerToken,
  type AuthContext,
  type AuthenticationAdapter,
} from "./adapter.js";

export interface CognitoTokenClaims {
  sub: string;
  token_use?: string;
  client_id?: string;
  aud?: string | string[];
  iss: string;
  exp: number;
}

export interface CognitoTokenVerifier {
  verify(token: string): Promise<CognitoTokenClaims>;
}

export function createCognitoJwtVerifier(input: {
  userPoolId: string;
  clientId: string;
}): CognitoTokenVerifier {
  const accessVerifier = CognitoJwtVerifier.create({
    userPoolId: input.userPoolId,
    tokenUse: "access",
    clientId: input.clientId,
  });
  const idVerifier = CognitoJwtVerifier.create({
    userPoolId: input.userPoolId,
    tokenUse: "id",
    clientId: input.clientId,
  });

  return {
    async verify(token: string): Promise<CognitoTokenClaims> {
      try {
        const access = await accessVerifier.verify(token);
        return {
          sub: access.sub,
          token_use: access.token_use,
          client_id: access.client_id,
          iss: access.iss,
          exp: access.exp,
        };
      } catch {
        const id = await idVerifier.verify(token);
        return {
          sub: id.sub,
          token_use: id.token_use,
          aud: id.aud,
          iss: id.iss,
          exp: id.exp,
        };
      }
    },
  };
}

export class CognitoJwtAdapter implements AuthenticationAdapter {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly verifier: CognitoTokenVerifier,
  ) {}

  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthContext> {
    const token = extractBearerToken(headers);
    let claims: CognitoTokenClaims;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      throw new DomainError("UNAUTHENTICATED", "Invalid authentication token", 401);
    }

    if (!claims.sub || typeof claims.sub !== "string") {
      throw new DomainError("UNAUTHENTICATED", "Invalid authentication token", 401);
    }
    if (claims.token_use && claims.token_use !== "access" && claims.token_use !== "id") {
      throw new DomainError("UNAUTHENTICATED", "Invalid authentication token", 401);
    }
    if (typeof claims.exp === "number" && claims.exp * 1000 <= this.clock.now().getTime()) {
      throw new DomainError("UNAUTHENTICATED", "Authentication token expired", 401);
    }

    const userId = await ensureIdentityUser(this.db, this.clock, "cognito", claims.sub);
    return { userId };
  }
}
