import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { asRequiredIso, type AuditEventRow } from "./types.js";

export interface AuditEventView {
  eventId: string;
  eventType: string;
  eventVersion: number;
  actorUserId: string | null;
  at: string;
  data: Record<string, unknown>;
}

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
  const events = await listAuditEvents(db, proofId);
  return events.map((event) => event.eventId);
}

export async function listAuditEvents(
  db: Database,
  proofId: string,
): Promise<AuditEventView[]> {
  const result = await db.query<AuditEventRow>(
    `SELECT * FROM audit_events WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return result.rows.map((row) => ({
    eventId: row.id,
    eventType: row.event_type,
    eventVersion: Number(row.event_version),
    actorUserId: row.actor_user_id,
    at: asRequiredIso(row.created_at),
    data: asEventData(row.event_data),
  }));
}

export function asEventData(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return asEventData(parsed);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
