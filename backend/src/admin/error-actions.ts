import express, { type Request, type Response, type NextFunction } from 'express';
import { DomainError } from '../domain/errors.js';
import { type AdminDeps, requireRecentAdminAuthentication } from './auth.js';
import { appendAdminAudit, parseAdminCommand, runAdminCommand } from './audit.js';

const STATUSES = ['NEW', 'INVESTIGATING', 'RESOLVED', 'IGNORED'] as const;
export type ErrorTriageStatus = typeof STATUSES[number];
export interface AdminErrorTriage { service: string; code: string; status: ErrorTriageStatus; version: number }
const labels: Record<ErrorTriageStatus, string> = {
  NEW: 'Reopen error', INVESTIGATING: 'Mark investigating', RESOLVED: 'Mark resolved', IGNORED: 'Ignore error',
};
export function adminErrorActions(error: AdminErrorTriage) {
  return STATUSES.filter(status => status !== error.status).map(status => ({
    id: `triage-${status.toLowerCase()}`, label: labels[status], method: 'POST' as const, risk: 'high' as const,
    path: `/admin/errors/${encodeURIComponent(error.service)}/${encodeURIComponent(error.code)}/status`,
    confirmation: `${error.service}:${error.code}`, body: { expectedVersion: error.version, status },
  }));
}
const route = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

export function errorActionsRouter(deps: AdminDeps) {
  const r = express.Router();
  r.post('/errors/:service/:code/status', requireRecentAdminAuthentication(deps), route(async (req, res) => {
    const { service, code } = req.params;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(service) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(code))
      throw new DomainError('INVALID_ADMIN_ERROR_TARGET', 'Use an error service and diagnostic code from the dashboard', 400);
    const target = `${service}:${code}`, cmd = parseAdminCommand(req.body, target, ['status']);
    if (!STATUSES.includes(cmd.status as ErrorTriageStatus))
      throw new DomainError('INVALID_ERROR_TRIAGE_STATUS', 'Choose NEW, INVESTIGATING, RESOLVED or IGNORED', 400);
    res.json(await runAdminCommand(deps.db, deps.clock, req.packproofUserId!, 'ERROR_TRIAGE_CHANGED', target, cmd, async (tx, operationId) => {
      const current = (await tx.query<{ status: ErrorTriageStatus; version: number; updated_at: Date | string }>(
        'SELECT status,version,updated_at FROM admin_error_triage WHERE service=$1 AND code=$2 FOR UPDATE', [service, code])).rows[0];
      const before = { status: current?.status ?? 'NEW', version: current?.version ?? 0 };
      if (before.version !== cmd.expectedVersion)
        throw new DomainError('ADMIN_VERSION_CONFLICT', 'This error was triaged by another operation. Refresh before retrying.', 409);
      if (before.status === cmd.status)
        throw new DomainError('ERROR_TRIAGE_UNCHANGED', 'This error already has that triage status', 409);
      const updatedAt = new Date(Math.max(deps.clock.now().getTime(), current ? new Date(current.updated_at).getTime() + 1 : 0)).toISOString();
      const after = { service, code, status: cmd.status, version: before.version + 1, updatedAt };
      await tx.query(`INSERT INTO admin_error_triage(service,code,status,version,updated_at,updated_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(service,code) DO UPDATE SET status=EXCLUDED.status,
        version=EXCLUDED.version,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by`,
      [service, code, cmd.status, after.version, updatedAt, req.packproofUserId!]);
      await appendAdminAudit(tx, deps.clock, { actorId: req.packproofUserId!, action: 'ERROR_TRIAGE_CHANGED', targetType: 'error', targetId: target,
        reason: cmd.reason, before, after, operationId });
      return after;
    }));
  }));
  return r;
}
