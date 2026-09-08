import type { Database } from "../db/database.js";
import { DomainError } from "./errors.js";

/** Account status is operator-controlled and checked against the current DB on
 * every authorization. Disabling an actor does not erase historical evidence or
 * revoke independent recipient grants issued while that actor was authorized. */
export async function requireActiveAccount(db: Database, userId: string): Promise<void> {
  const account = (await db.query<{ status: string }>("SELECT status FROM users WHERE id=$1", [userId])).rows[0];
  if (account?.status !== "ACTIVE") {
    throw new DomainError("UNAUTHENTICATED", "This account is unavailable", 401);
  }
}
