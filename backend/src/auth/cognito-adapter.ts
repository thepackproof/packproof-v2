import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { DomainError } from "../domain/errors.js";
import { ensureIdentityUser } from "../domain/users.js";
import { requireActiveAccount } from "../domain/account-access.js";
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
  email?: string;
  email_verified?: boolean;
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
          email: typeof id.email === "string" ? id.email : undefined,
          email_verified: id.email_verified === true,
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
    if (claims.token_use === "id") {
      const verifiedEmail = claims.email_verified === true && typeof claims.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) && claims.email.length <= 254
        ? claims.email.trim().toLowerCase() : null;
      await this.db.transaction(async tx => {
        // Serialize contact replacement for this identity and preserve the original
        // verification timestamp when provider claims are unchanged. Rewriting it
        // on every authenticated request would continually invalidate policy receipts.
        await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        await requireActiveAccount(tx, userId);
        await tx.query("DELETE FROM user_verified_contacts WHERE user_id=$1 AND ($2::text IS NULL OR email_normalized <> $2)", [userId, verifiedEmail]);
        if (verifiedEmail) {
          await tx.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,'COGNITO') ON CONFLICT(user_id,email_normalized) DO NOTHING", [userId, verifiedEmail, this.clock.now().toISOString()]);
        }
      });
    }
    return { userId };
  }
}
