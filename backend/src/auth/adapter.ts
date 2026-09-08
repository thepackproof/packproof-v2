import type { Database } from "../db/database.js";
import { DomainError } from "../domain/errors.js";
import { requireActiveAccount } from "../domain/account-access.js";

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
    await requireActiveAccount(this.db, userId);
    return { userId };
  }
}
