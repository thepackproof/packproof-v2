import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { DomainError } from '../domain/errors.js';
import { assertSystemAdmin } from './auth.js';

export interface AdminCommand {
  operationId: string; reason: string; confirmation: string; expectedVersion: number;
}
export function parseAdminCommand(body: unknown, target: string, extra: readonly string[] = []): AdminCommand & Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError('INVALID_ADMIN_COMMAND', 'Provide an administrative command', 400);
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some(key => !['operationId','reason','confirmation','expectedVersion',...extra].includes(key)) ||
    typeof row.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(row.operationId) ||
    typeof row.reason !== 'string' || row.reason.trim().length < 8 || row.reason.length > 1000 ||
    row.confirmation !== target || !Number.isSafeInteger(row.expectedVersion) || Number(row.expectedVersion) < 0)
    throw new DomainError('INVALID_ADMIN_COMMAND', 'A reason, exact target confirmation, operation ID and current version are required', 400);
  return { ...row, reason: row.reason.trim() } as AdminCommand & Record<string, unknown>;
}
export async function appendAdminAudit(tx: Database, clock: Clock, input: {
  actorId: string | null; action: string; targetType: string; targetId: string; reason: string;
  before: unknown; after: unknown; operationId: string; severity?: 'info' | 'warning' | 'critical';
}) {
  const id = newId('admin_event');
  await tx.query(`INSERT INTO system_admin_audit_events(id,actor_id,action,target_type,target_id,reason,before_json,after_json,operation_id,severity,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id,input.actorId,input.action,input.targetType,input.targetId,input.reason,
    JSON.stringify(input.before),JSON.stringify(input.after),input.operationId,input.severity??'warning',clock.now().toISOString()]);
  return id;
}
/** The effect, immutable audit and retry receipt all commit together. Lock order is
 * shared across administrative mutations, preventing concurrent admin lockouts. */
export async function runAdminCommand<T>(db: Database, clock: Clock, actorId: string, action: string, targetId: string,
  command: AdminCommand & Record<string, unknown>, apply: (tx: Database, auditOperationId: string) => Promise<T>): Promise<T> {
  const digest = sha256Hex(canonicalize({ action, targetId, command }));
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(1347438146,69)');
    await assertSystemAdmin(tx, actorId);
    const previous = (await tx.query<{request_sha256:string;response_json:T}>(
      'SELECT request_sha256,response_json FROM admin_command_receipts WHERE actor_id=$1 AND operation_id=$2',[actorId,command.operationId])).rows[0];
    if (previous) {
      if (previous.request_sha256 !== digest) throw new DomainError('ADMIN_IDEMPOTENCY_CONFLICT','This operation ID was already used for a different command',409);
      return previous.response_json;
    }
    const result = await apply(tx, `${actorId}:${command.operationId}`);
    await tx.query('INSERT INTO admin_command_receipts(actor_id,operation_id,request_sha256,response_json,created_at) VALUES($1,$2,$3,$4,$5)',
      [actorId,command.operationId,digest,JSON.stringify(result),clock.now().toISOString()]);
    return result;
  });
}
