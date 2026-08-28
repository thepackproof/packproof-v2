import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError, isUniqueViolation } from "./errors.js";

export async function ensureIdentityUser(
  db: Database,
  clock: Clock,
  provider: string,
  subject: string,
): Promise<string> {
  const existing = await db.query<{ user_id: string }>(
    `SELECT user_id FROM auth_identities
     WHERE provider = $1 AND provider_subject = $2`,
    [provider, subject],
  );
  if (existing.rows[0]) {
    return existing.rows[0].user_id;
  }

  return db.transaction(async (tx) => {
    const found = await tx.query<{ user_id: string }>(
      `SELECT user_id FROM auth_identities
       WHERE provider = $1 AND provider_subject = $2`,
      [provider, subject],
    );
    if (found.rows[0]) {
      return found.rows[0].user_id;
    }

    const userId = newId("user");
    const now = clock.now().toISOString();
    try {
      await tx.query(
        `INSERT INTO users (id, created_at, updated_at) VALUES ($1, $2, $3)`,
        [userId, now, now],
      );
      await tx.query(
        `INSERT INTO auth_identities (
           id, user_id, provider, provider_subject, created_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [newId("idt"), userId, provider, subject, now],
      );
      return userId;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const raced = await tx.query<{ user_id: string }>(
        `SELECT user_id FROM auth_identities
         WHERE provider = $1 AND provider_subject = $2`,
        [provider, subject],
      );
      if (!raced.rows[0]) {
        throw new DomainError("USER_CREATE_FAILED", "Could not create user", 500);
      }
      return raced.rows[0].user_id;
    }
  });
}

export async function insertUser(db: Database, clock: Clock, userId?: string): Promise<string> {
  const id = userId ?? newId("user");
  const now = clock.now().toISOString();
  await db.query(
    `INSERT INTO users (id, created_at, updated_at) VALUES ($1, $2, $3)`,
    [id, now, now],
  );
  return id;
}
