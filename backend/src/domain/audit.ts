import type { Database } from "../db/database.js";
import { newId } from "../ids.js";

export async function appendAudit(
  db: Database,
  input: {
    proofId: string;
    actorUserId: string | null;
    eventType: string;
    eventData: Record<string, unknown>;
    at: Date;
  },
): Promise<string> {
  const id = newId("aud");
  await db.query(
    `INSERT INTO audit_events (
       id, proof_id, actor_user_id, event_type, event_version, event_data, created_at
     ) VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6)`,
    [
      id,
      input.proofId,
      input.actorUserId,
      input.eventType,
      JSON.stringify(input.eventData),
      input.at.toISOString(),
    ],
  );
  return id;
}

export async function listAuditIds(db: Database, proofId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM audit_events WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return result.rows.map((row) => row.id);
}
