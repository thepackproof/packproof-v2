import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { asRequiredIso } from "./types.js";

export const CONNECTED_ACCOUNT_AUDIT_TYPES = [
  "CONNECTED_ACCOUNT_LINKED",
  "CONNECTED_ACCOUNT_REAUTHORIZED",
  "CONNECTED_ACCOUNT_DISCONNECTED",
  "CONNECTED_ACCOUNT_AUTH_ERROR",
] as const;

export type ConnectedAccountAuditType = (typeof CONNECTED_ACCOUNT_AUDIT_TYPES)[number];

export interface AccountAuditEventView {
  eventId: string;
  eventType: string;
  actorUserId: string | null;
  connectedAccountId: string | null;
  at: string;
  data: Record<string, unknown>;
}

export async function appendAccountAudit(
  db: Database,
  input: {
    actorUserId: string | null;
    connectedAccountId?: string | null;
    eventType: ConnectedAccountAuditType | string;
    eventData: Record<string, unknown>;
    at: Date;
  },
): Promise<string> {
  const id = newId("aae");
  await db.query(
    `INSERT INTO account_audit_events (
       id, actor_user_id, connected_account_id, event_type, event_version, event_data, created_at
     ) VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6)`,
    [
      id,
      input.actorUserId,
      input.connectedAccountId ?? null,
      input.eventType,
      JSON.stringify(redactAuditData(input.eventData)),
      input.at.toISOString(),
    ],
  );
  return id;
}

export async function listAccountAudit(
  db: Database,
  actorUserId: string,
): Promise<AccountAuditEventView[]> {
  const found = await db.query<{
    id: string;
    actor_user_id: string | null;
    connected_account_id: string | null;
    event_type: string;
    event_data: unknown;
    created_at: Date | string;
  }>(
    `SELECT id, actor_user_id, connected_account_id, event_type, event_data, created_at
       FROM account_audit_events
      WHERE actor_user_id = $1
      ORDER BY created_at ASC, id ASC`,
    [actorUserId],
  );
  return found.rows.map((row) => ({
    eventId: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    connectedAccountId: row.connected_account_id,
    at: asRequiredIso(row.created_at),
    data: asObject(row.event_data),
  }));
}

function redactAuditData(data: Record<string, unknown>): Record<string, unknown> {
  const blocked = /token|secret|password|authorization|refresh|client_secret|access_token/i;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (blocked.test(key)) {
      continue;
    }
    if (typeof value === "string" && blocked.test(value) && value.length > 24) {
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
