import type { Database } from "../db/database.js";
import { DomainError } from "../domain/errors.js";

export type PackProofUserId = string;

export interface AuthContext {
  userId: PackProofUserId;
}

export interface AuthenticationAdapter {
  authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthContext>;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function extractBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string {
  const header = headerValue(headers, "authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new DomainError("UNAUTHENTICATED", "Missing bearer token", 401);
  }
  const token = header.slice(7).trim();
  if (!token) {
    throw new DomainError("UNAUTHENTICATED", "Missing bearer token", 401);
  }
  return token;
}

export class BearerUserAdapter implements AuthenticationAdapter {
  constructor(private readonly db: Database) {}

  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthContext> {
    const userId = extractBearerToken(headers);
    const found = await this.db.query(`SELECT id FROM users WHERE id = $1`, [
      userId,
    ]);
    if (!found.rows[0]) {
      throw new DomainError("UNAUTHENTICATED", "Unknown PackProof user", 401);
    }
    return { userId };
  }
}
