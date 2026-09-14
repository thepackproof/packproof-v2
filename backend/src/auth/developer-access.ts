import type { Database } from "../db/database.js";
import { DomainError } from "../domain/errors.js";
import { requireActiveAccount } from "../domain/account-access.js";

// Deliberately exact accounts: no domain, username, environment or client-side grants.
export const DEVELOPER_EMAILS = Object.freeze([
  "nericollin@gmail.com",
  "nericollin@thepackproof.com",
  "admin@thepackproof.com",
]);

export async function hasDeveloperAccess(db: Database, userId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM user_verified_contacts c JOIN users u ON u.id=c.user_id
     WHERE c.user_id=$1 AND u.status='ACTIVE' AND c.source='COGNITO'
       AND lower(trim(c.email_normalized))=ANY($2::text[]) LIMIT 1`,
    [userId, DEVELOPER_EMAILS],
  );
  return result.rows.length > 0;
}

export async function requireDeveloperAccess(db: Database, userId: string): Promise<void> {
  await requireActiveAccount(db, userId);
  if (!(await hasDeveloperAccess(db, userId))) {
    throw new DomainError("DEVELOPER_ACCESS_REQUIRED", "Developer access is not available for this account.", 403);
  }
}
