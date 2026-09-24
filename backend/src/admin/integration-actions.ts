import express, { type Request, type Response, type NextFunction } from 'express';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { requireRecentAdminAuthentication, type AdminDeps } from './auth.js';
import { appendAdminAudit, parseAdminCommand, runAdminCommand } from './audit.js';

const route = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const iso = (value: Date | string) => new Date(value).toISOString();
const RETRY_LIMIT = 3;
export interface AdminIntegrationState {
  id: string; status: string; auto_sync_enabled: boolean; updated_at: Date | string;
}
export interface AdminIntegrationSyncState {
  run_status: string; attempt_count: number; last_error_retryable: boolean | null;
  lease_expires_at: Date | string | null; updated_at: Date | string;
  last_error_code?: string | null; next_run_at?: Date | string | null;
}
interface SyncRow extends AdminIntegrationSyncState { last_succeeded_at: Date | string | null }
export interface AdminWebhookDeliveryState {
  id: string; state: string; attempts: number; next_attempt_at: Date | string;
  revoked_at?: Date | string | null; last_status?: number | null;
}

/** Only operational columns enter descriptors, receipts or audit records. */
export function adminIntegrationActions(connection: AdminIntegrationState, sync?: AdminIntegrationSyncState | null, now = new Date()) {
  const base = { method: 'POST' as const, risk: 'high' as const, confirmation: connection.id,
    body: { expectedVersion: 0, expectedUpdatedAt: iso(connection.updated_at) } };
  const actions = connection.status === 'DISABLED' ? [] : [{ ...base, id: 'disable-integration',
    label: 'Disable connection in PackProof', path: `/admin/integrations/${encodeURIComponent(connection.id)}/disable` }];
  if (sync && connection.status === 'ACTIVE' && connection.auto_sync_enabled && sync.last_error_retryable === true &&
    ['FAILED', 'RETRYING'].includes(sync.run_status) &&
    (!sync.lease_expires_at || new Date(sync.lease_expires_at).getTime() <= now.getTime()) &&
    !(sync.run_status === 'RETRYING' && (!sync.next_run_at || new Date(sync.next_run_at).getTime() <= now.getTime())) &&
    !(sync.last_error_code === 'PROVIDER_RATE_LIMITED' && sync.next_run_at && new Date(sync.next_run_at).getTime() > now.getTime())) {
    actions.push({ ...base, id: 'retry-sync', label: 'Retry failed order sync',
      path: `/admin/integrations/${encodeURIComponent(connection.id)}/retry-sync`,
      body: { ...base.body, ...{ expectedSyncUpdatedAt: iso(sync.updated_at) } } });
  }
  return actions;
}
export function adminWebhookDeliveryActions(delivery: AdminWebhookDeliveryState, now = new Date()) {
  if (delivery.state !== 'dead' || delivery.revoked_at ||
    (delivery.last_status === 429 && new Date(delivery.next_attempt_at).getTime() > now.getTime())) return [];
  return [{ id: 'retry-webhook', label: 'Retry failed webhook delivery', method: 'POST' as const, risk: 'high' as const,
    path: `/admin/webhooks/${encodeURIComponent(delivery.id)}/retry`, confirmation: delivery.id,
    body: { expectedVersion: delivery.attempts, expectedNextAttemptAt: iso(delivery.next_attempt_at) } }];
}
function requiredTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new DomainError('INVALID_ADMIN_COMMAND', 'The current timestamp is required. Refresh this record.', 400);
  return iso(value);
}
function assertTimestamp(actual: Date | string, expected: unknown) {
  if (iso(actual) !== requiredTimestamp(expected))
    throw new DomainError('ADMIN_VERSION_CONFLICT', 'This record changed. Refresh before retrying.', 409);
}
function changedAt(now: Date, before: Date | string) {
  return new Date(Math.max(now.getTime(), new Date(before).getTime() + 1)).toISOString();
}
async function lockedConnection(tx: Database, id: string, expectedUpdatedAt: unknown, expectedVersion: number) {
  const connection = (await tx.query<AdminIntegrationState>(
    'SELECT id,status,auto_sync_enabled,updated_at FROM integration_connections WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!connection) throw new DomainError('INTEGRATION_NOT_FOUND', 'Integration connection not found', 404);
  if (expectedVersion !== 0) throw new DomainError('ADMIN_VERSION_CONFLICT', 'Refresh this connection before retrying.', 409);
  assertTimestamp(connection.updated_at, expectedUpdatedAt);
  return connection;
}
async function assertRetryBudget(tx: Database, action: string, id: string, since?: Date | string | null) {
  const count = Number((await tx.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM system_admin_audit_events WHERE action=$1 AND target_id=$2
      AND ($3::timestamptz IS NULL OR created_at>$3::timestamptz)`, [action, id, since ?? null])).rows[0].count);
  if (count >= RETRY_LIMIT) throw new DomainError('ADMIN_RETRY_LIMIT', 'Three administrative retries have already been requested. Investigate the failure before further recovery.', 409);
  return count + 1;
}

export function integrationActionsRouter(deps: AdminDeps) {
  const r = express.Router();
  r.post('/integrations/:id/disable', requireRecentAdminAuthentication(deps), route(async (req, res) => {
    const id = req.params.id, cmd = parseAdminCommand(req.body, id, ['expectedUpdatedAt']);
    requiredTimestamp(cmd.expectedUpdatedAt);
    res.json(await runAdminCommand(deps.db, deps.clock, req.packproofUserId!, 'INTEGRATION_DISABLED', id, cmd, async (tx, operationId) => {
      const before = await lockedConnection(tx, id, cmd.expectedUpdatedAt, cmd.expectedVersion);
      if (before.status === 'DISABLED') throw new DomainError('INTEGRATION_ALREADY_DISABLED', 'This connection is already disabled', 409);
      const sync = (await tx.query<{ run_status: string; updated_at: Date | string }>(
        'SELECT run_status,updated_at FROM commerce_connection_sync_states WHERE connection_id=$1 FOR UPDATE', [id])).rows[0];
      const updatedAt = changedAt(deps.clock.now(), before.updated_at);
      await tx.query("UPDATE integration_connections SET status='DISABLED',auto_sync_enabled=false,updated_at=$2 WHERE id=$1", [id, updatedAt]);
      // Invalidates in-flight import fencing tokens. Source checkpoints and evidence stay intact.
      await tx.query(`UPDATE commerce_connection_sync_states SET run_status='IDLE',lease_token=NULL,
        lease_expires_at=NULL,next_run_at=NULL,updated_at=$2 WHERE connection_id=$1`, [id, sync ? changedAt(deps.clock.now(), sync.updated_at) : updatedAt]);
      const after = { connectionId: id, status: 'DISABLED', autoSyncEnabled: false, updatedAt,
        localOnly: true, providerCredentialsRevoked: false };
      await appendAdminAudit(tx, deps.clock, { actorId: req.packproofUserId!, action: 'INTEGRATION_DISABLED', targetType: 'integration', targetId: id,
        reason: cmd.reason, before: { status: before.status, autoSyncEnabled: before.auto_sync_enabled, syncState: sync?.run_status ?? null }, after, operationId });
      return after;
    }));
  }));
  r.post('/integrations/:id/retry-sync', requireRecentAdminAuthentication(deps), route(async (req, res) => {
    const id = req.params.id, cmd = parseAdminCommand(req.body, id, ['expectedUpdatedAt', 'expectedSyncUpdatedAt']);
    requiredTimestamp(cmd.expectedUpdatedAt); requiredTimestamp(cmd.expectedSyncUpdatedAt);
    res.json(await runAdminCommand(deps.db, deps.clock, req.packproofUserId!, 'INTEGRATION_SYNC_REQUEUED', id, cmd, async (tx, operationId) => {
      const connection = await lockedConnection(tx, id, cmd.expectedUpdatedAt, cmd.expectedVersion);
      if (connection.status !== 'ACTIVE' || !connection.auto_sync_enabled)
        throw new DomainError('INTEGRATION_NOT_RETRYABLE', 'An active connection with automatic sync enabled is required', 409);
      const sync = (await tx.query<SyncRow>(`SELECT run_status,attempt_count,last_error_retryable,lease_expires_at,
        last_error_code,next_run_at,last_succeeded_at,updated_at FROM commerce_connection_sync_states WHERE connection_id=$1 FOR UPDATE`, [id])).rows[0];
      if (!sync) throw new DomainError('INTEGRATION_NOT_RETRYABLE', 'No existing failed sync is available to retry', 409);
      assertTimestamp(sync.updated_at, cmd.expectedSyncUpdatedAt);
      if (!['FAILED', 'RETRYING'].includes(sync.run_status) || sync.last_error_retryable !== true ||
        (sync.lease_expires_at && new Date(sync.lease_expires_at).getTime() > deps.clock.now().getTime()))
        throw new DomainError('INTEGRATION_NOT_RETRYABLE', 'Only retryable failed syncs without an active worker can be retried', 409);
      if (sync.run_status === 'RETRYING' && (!sync.next_run_at || new Date(sync.next_run_at).getTime() <= deps.clock.now().getTime()))
        throw new DomainError('INTEGRATION_RETRY_ALREADY_QUEUED', 'This sync is already queued for the next worker run', 409);
      if (sync.last_error_code === 'PROVIDER_RATE_LIMITED' && sync.next_run_at && new Date(sync.next_run_at).getTime() > deps.clock.now().getTime())
        throw new DomainError('INTEGRATION_RATE_LIMITED', 'Wait until the provider retry time before retrying', 409);
      const retryNumber = await assertRetryBudget(tx, 'INTEGRATION_SYNC_REQUEUED', id, sync.last_succeeded_at);
      const updatedAt = changedAt(deps.clock.now(), sync.updated_at), nextRunAt = deps.clock.now().toISOString();
      // Preserve attempts, window, cursor, checkpoints and diagnostics. A terminally exhausted
      // job receives one further attempt through the existing worker's bounded retry policy.
      await tx.query(`UPDATE commerce_connection_sync_states SET run_status='RETRYING',next_run_at=$2,
        lease_token=NULL,lease_expires_at=NULL,updated_at=$3 WHERE connection_id=$1`, [id, nextRunAt, updatedAt]);
      const after = { connectionId: id, runStatus: 'RETRYING', attemptCount: sync.attempt_count, nextRunAt, updatedAt, retryNumber };
      await appendAdminAudit(tx, deps.clock, { actorId: req.packproofUserId!, action: 'INTEGRATION_SYNC_REQUEUED', targetType: 'integration', targetId: id,
        reason: cmd.reason, before: { runStatus: sync.run_status, attemptCount: sync.attempt_count }, after, operationId });
      return after;
    }));
  }));
  r.post('/webhooks/:id/retry', requireRecentAdminAuthentication(deps), route(async (req, res) => {
    const id = req.params.id, cmd = parseAdminCommand(req.body, id, ['expectedNextAttemptAt']);
    requiredTimestamp(cmd.expectedNextAttemptAt);
    res.json(await runAdminCommand(deps.db, deps.clock, req.packproofUserId!, 'WEBHOOK_DELIVERY_REQUEUED', id, cmd, async (tx, operationId) => {
      const delivery = (await tx.query<AdminWebhookDeliveryState>(`SELECT d.id,d.state,d.attempts,d.next_attempt_at,d.last_status,w.revoked_at
        FROM api_webhook_deliveries d JOIN api_webhooks w ON w.id=d.webhook_id WHERE d.id=$1 FOR UPDATE OF d,w`, [id])).rows[0];
      if (!delivery) throw new DomainError('WEBHOOK_DELIVERY_NOT_FOUND', 'Webhook delivery not found', 404);
      assertTimestamp(delivery.next_attempt_at, cmd.expectedNextAttemptAt);
      if (delivery.attempts !== cmd.expectedVersion) throw new DomainError('ADMIN_VERSION_CONFLICT', 'This delivery changed. Refresh before retrying.', 409);
      if (delivery.state !== 'dead' || delivery.revoked_at)
        throw new DomainError('DELIVERY_NOT_RETRYABLE', 'Only failed deliveries for an active webhook can be retried', 409);
      if (delivery.last_status === 429 && new Date(delivery.next_attempt_at).getTime() > deps.clock.now().getTime())
        throw new DomainError('WEBHOOK_RATE_LIMITED', 'Wait until the webhook retry time before retrying', 409);
      const retryNumber = await assertRetryBudget(tx, 'WEBHOOK_DELIVERY_REQUEUED', id);
      const nextAttemptAt = deps.clock.now().toISOString();
      await tx.query("UPDATE api_webhook_deliveries SET state='pending',next_attempt_at=$2,lease_token=NULL WHERE id=$1", [id, nextAttemptAt]);
      const after = { deliveryId: id, state: 'pending', attempts: delivery.attempts, nextAttemptAt, retryNumber };
      await appendAdminAudit(tx, deps.clock, { actorId: req.packproofUserId!, action: 'WEBHOOK_DELIVERY_REQUEUED', targetType: 'webhook_delivery', targetId: id,
        reason: cmd.reason, before: { state: delivery.state, attempts: delivery.attempts, lastStatus: delivery.last_status }, after, operationId });
      return after;
    }));
  }));
  return r;
}
