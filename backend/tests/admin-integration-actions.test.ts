import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPgliteDatabase } from '../src/db/pglite.js';
import { migrate } from '../src/db/migrate.js';
import { requireSystemAdmin } from '../src/admin/auth.js';
import { integrationActionsRouter, adminIntegrationActions, adminWebhookDeliveryActions } from '../src/admin/integration-actions.js';
import { errorActionsRouter, adminErrorActions } from '../src/admin/error-actions.js';
import { safeHttpError } from '../src/http/boundary.js';

describe('administrative integration recovery', () => {
  let opened: Awaited<ReturnType<typeof createPgliteDatabase>>;
  let app: express.Express;
  const now = '2026-09-24T12:00:00.000Z';
  const clock = { now: () => new Date(now) };
  beforeAll(async () => {
    opened = await createPgliteDatabase();
    await migrate(opened.db);
    await opened.db.query("INSERT INTO users(id,created_at,updated_at) VALUES('integration-admin',$1,$1),('integration-owner',$1,$1)", [now]);
    await opened.db.query("INSERT INTO user_system_roles(user_id,role,granted_at) VALUES('integration-admin','SYSTEM_ADMIN',$1)", [now]);
    const deps = { db: opened.db, clock, devAuth: true };
    app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.packproofUserId = req.header('test-user') ?? 'integration-admin'; next(); });
    app.use('/admin', requireSystemAdmin(deps), integrationActionsRouter(deps), errorActionsRouter(deps));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { safeHttpError(err, res); });
  }, 30000);
  afterAll(async () => { await opened?.close(); });
  async function connection(id: string, state = 'FAILED', lease?: string) {
    await opened.db.query(`INSERT INTO integration_connections(id,owner_user_id,adapter_key,provider,credential_reference,status,auto_sync_enabled,created_at,updated_at)
      VALUES($1,'integration-owner','shopify','shopify','DO_NOT_DISCLOSE','ACTIVE',true,$2,$2)`, [id, now]);
    await opened.db.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at,run_status,attempt_count,last_error_code,last_error_retryable,
      provider_cursor,window_started_at,window_ended_at,lease_token,lease_expires_at)
      VALUES($1,$2,$3,8,'PROVIDER_TEMPORARILY_UNAVAILABLE',true,'PRIVATE_CURSOR',$2,$2,$4,$5)`, [id, now, state, lease ? 'OLD_LEASE' : null, lease ?? null]);
    await opened.db.query("INSERT INTO commerce_sync_page_checkpoints(connection_id,cursor_sha256) VALUES($1,'CHECKPOINT')", [id]);
  }
  const command = (id: string, operationId: string) => ({ operationId, reason: 'Provider recovered after outage', confirmation: id,
    expectedVersion: 0, expectedUpdatedAt: now, expectedSyncUpdatedAt: now });
  it('authorizes from server roles and refuses stale, invalid and actively leased retries', async () => {
    await connection('sync-guards', 'FAILED', '2026-09-24T12:01:00.000Z');
    const cmd = command('sync-guards', 'guard-operation');
    expect((await request(app).post('/admin/integrations/sync-guards/retry-sync').set('test-user', 'integration-owner').send(cmd)).status).toBe(403);
    expect((await request(app).post('/admin/integrations/sync-guards/retry-sync').send({ ...cmd, expectedSyncUpdatedAt: '2026-09-23T12:00:00.000Z' })).status).toBe(409);
    expect((await request(app).post('/admin/integrations/sync-guards/retry-sync').send({ ...cmd, confirmation: 'another-target' })).status).toBe(400);
    expect((await request(app).post('/admin/integrations/sync-guards/retry-sync').send(cmd)).status).toBe(409);
    await opened.db.query("UPDATE commerce_connection_sync_states SET lease_expires_at=NULL,last_error_retryable=false WHERE connection_id='sync-guards'");
    expect((await request(app).post('/admin/integrations/sync-guards/retry-sync').send(cmd)).status).toBe(409);
    expect((await opened.db.query("SELECT id FROM system_admin_audit_events WHERE target_id='sync-guards'")).rows).toHaveLength(0);
  });
  it('requeues once with immutable audit, keeps checkpoints and enforces a bounded retry budget', async () => {
    await connection('sync-requeue');
    let cmd = command('sync-requeue', 'sync-operation-1');
    const first = await request(app).post('/admin/integrations/sync-requeue/retry-sync').send(cmd);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ runStatus: 'RETRYING', attemptCount: 8, retryNumber: 1 });
    expect((await request(app).post('/admin/integrations/sync-requeue/retry-sync').send(cmd)).body).toEqual(first.body);
    expect((await request(app).post('/admin/integrations/sync-requeue/retry-sync').send({ ...cmd, reason: 'Changed operation request' })).status).toBe(409);
    expect((await request(app).post('/admin/integrations/sync-requeue/retry-sync').send({ ...cmd, operationId: 'duplicate-queue-operation', expectedSyncUpdatedAt: first.body.updatedAt })).status).toBe(409);
    const row = (await opened.db.query("SELECT provider_cursor,attempt_count,window_started_at FROM commerce_connection_sync_states WHERE connection_id='sync-requeue'")).rows[0];
    expect(row.provider_cursor).toBe('PRIVATE_CURSOR'); expect(row.attempt_count).toBe(8); expect(row.window_started_at).not.toBeNull();
    expect((await opened.db.query("SELECT cursor_sha256 FROM commerce_sync_page_checkpoints WHERE connection_id='sync-requeue'")).rows).toHaveLength(1);
    let updatedAt = first.body.updatedAt;
    for (let index = 2; index <= 3; index++) {
      await opened.db.query("UPDATE commerce_connection_sync_states SET run_status='FAILED',attempt_count=attempt_count+1 WHERE connection_id='sync-requeue'");
      cmd = { ...cmd, operationId: `sync-operation-${index}`, expectedSyncUpdatedAt: updatedAt };
      const next = await request(app).post('/admin/integrations/sync-requeue/retry-sync').send(cmd);
      expect(next.status).toBe(200); updatedAt = next.body.updatedAt;
    }
    await opened.db.query("UPDATE commerce_connection_sync_states SET run_status='FAILED',attempt_count=attempt_count+1 WHERE connection_id='sync-requeue'");
    expect((await request(app).post('/admin/integrations/sync-requeue/retry-sync').send({ ...cmd, operationId: 'sync-operation-4', expectedSyncUpdatedAt: updatedAt })).status).toBe(409);
    const audit = (await opened.db.query("SELECT before_json,after_json FROM system_admin_audit_events WHERE target_id='sync-requeue'")).rows;
    expect(audit).toHaveLength(3);
    expect(JSON.stringify([audit, first.body])).not.toMatch(/PRIVATE_CURSOR|DO_NOT_DISCLOSE|OLD_LEASE/);
  });
  it('disables locally and fences a running importer without touching source checkpoints', async () => {
    await connection('sync-disable', 'RUNNING', '2026-09-24T12:01:00.000Z');
    const cmd = { operationId: 'disable-operation', reason: 'Owner reported compromised store access', confirmation: 'sync-disable', expectedVersion: 0, expectedUpdatedAt: now };
    const result = await request(app).post('/admin/integrations/sync-disable/disable').send(cmd);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ status: 'DISABLED', localOnly: true, providerCredentialsRevoked: false });
    expect((await request(app).post('/admin/integrations/sync-disable/disable').send(cmd)).body).toEqual(result.body);
    const state = (await opened.db.query("SELECT lease_token,lease_expires_at,next_run_at,provider_cursor FROM commerce_connection_sync_states WHERE connection_id='sync-disable'")).rows[0];
    expect(state).toEqual({ lease_token: null, lease_expires_at: null, next_run_at: null, provider_cursor: 'PRIVATE_CURSOR' });
    expect((await opened.db.query("SELECT status,auto_sync_enabled,credential_reference FROM integration_connections WHERE id='sync-disable'")).rows[0])
      .toEqual({ status: 'DISABLED', auto_sync_enabled: false, credential_reference: 'DO_NOT_DISCLOSE' });
    expect((await request(app).post('/admin/integrations/sync-disable/retry-sync').send({ ...command('sync-disable', 'disabled-retry'), expectedUpdatedAt: result.body.updatedAt })).status).toBe(409);
  });
  it('only exposes actions appropriate to the state and respects provider rate limits', async () => {
    const c = { id: 'rate-limit', status: 'ACTIVE', auto_sync_enabled: true, updated_at: now };
    const sync = { run_status: 'RETRYING', attempt_count: 0, last_error_retryable: true, lease_expires_at: null, updated_at: now,
      last_error_code: 'PROVIDER_RATE_LIMITED', next_run_at: '2026-09-24T12:05:00.000Z' };
    expect(adminIntegrationActions(c, sync, clock.now()).map(a => a.id)).toEqual(['disable-integration']);
    expect(adminIntegrationActions({ ...c, status: 'DISABLED' }, sync, clock.now())).toEqual([]);
    expect(adminWebhookDeliveryActions({ id: 'delivery', state: 'delivered', attempts: 10, next_attempt_at: now })).toEqual([]);
    await connection('rate-limit', 'RETRYING');
    await opened.db.query("UPDATE commerce_connection_sync_states SET last_error_code='PROVIDER_RATE_LIMITED',next_run_at=$1 WHERE connection_id='rate-limit'", [sync.next_run_at]);
    expect((await request(app).post('/admin/integrations/rate-limit/retry-sync').send(command('rate-limit', 'rate-limit-retry'))).status).toBe(409);
  });
  it('retries only an existing dead webhook delivery and preserves its attempts and event', async () => {
    // The source event is generated by the normal append-only audit trigger.
    await opened.db.query("INSERT INTO transactions(id,created_by,created_at,updated_at) VALUES('admin-hook-txn','integration-owner',$1,$1)", [now]);
    await opened.db.query("INSERT INTO proofs(id,transaction_id,status,created_at,updated_at) VALUES('admin-hook-proof','admin-hook-txn','READY_FOR_EVIDENCE',$1,$1)", [now]);
    await opened.db.query(`INSERT INTO audit_events(id,proof_id,event_type,actor_user_id,event_version,event_data,created_at)
      VALUES('admin-hook-audit','admin-hook-proof','PROOF_CREATED','integration-owner',1,'{}',$1)`, [now]);
    await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES('admin-hook-tenant','integration-owner','Test','sandbox',$1)", [now]);
    await opened.db.query(`INSERT INTO api_webhooks(id,tenant_id,url,secret_ciphertext,event_types,created_at)
      VALUES('admin-hook','admin-hook-tenant','https://secret.invalid/private?token=DO_NOT_DISCLOSE','DO_NOT_DISCLOSE','["proof.created"]',$1)`, [now]);
    await opened.db.query(`INSERT INTO api_webhook_deliveries(id,webhook_id,event_id,state,attempts,next_attempt_at)
      VALUES('admin-delivery','admin-hook','admin-hook-audit:proof.created','dead',10,$1)`, [now]);
    const cmd = { operationId: 'webhook-retry-1', reason: 'Webhook destination repaired', confirmation: 'admin-delivery', expectedVersion: 10, expectedNextAttemptAt: now };
    const response = await request(app).post('/admin/webhooks/admin-delivery/retry').send(cmd);
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ state: 'pending', attempts: 10 });
    expect((await request(app).post('/admin/webhooks/admin-delivery/retry').send(cmd)).body).toEqual(response.body);
    expect((await request(app).post('/admin/webhooks/admin-delivery/retry').send({ ...cmd, operationId: 'webhook-retry-2' })).status).toBe(409);
    const stored = (await opened.db.query("SELECT event_id,attempts FROM api_webhook_deliveries WHERE id='admin-delivery'")).rows[0];
    expect(stored).toEqual({ event_id: 'admin-hook-audit:proof.created', attempts: 10 });
    const audit = (await opened.db.query("SELECT before_json,after_json FROM system_admin_audit_events WHERE target_id='admin-delivery'")).rows;
    expect(audit).toHaveLength(1); expect(JSON.stringify([audit, response.body])).not.toContain('DO_NOT_DISCLOSE');
  });
  it('triages errors as versioned audited annotations and rejects stale, unauthorized or invalid changes', async () => {
    const cmd = { operationId: 'triage-operation-1', reason: 'Investigating provider outage', confirmation: 'commerce:PROVIDER_TEMPORARILY_UNAVAILABLE',
      expectedVersion: 0, status: 'INVESTIGATING' };
    const path = '/admin/errors/commerce/PROVIDER_TEMPORARILY_UNAVAILABLE/status';
    expect((await request(app).post(path).set('test-user', 'integration-owner').send(cmd)).status).toBe(403);
    expect((await request(app).post(path).send({ ...cmd, status: 'DELETED' })).status).toBe(400);
    const result = await request(app).post(path).send(cmd);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ status: 'INVESTIGATING', version: 1 });
    expect((await request(app).post(path).send(cmd)).body).toEqual(result.body);
    expect((await request(app).post(path).send({ ...cmd, operationId: 'triage-operation-2', status: 'RESOLVED' })).status).toBe(409);
    const resolved = await request(app).post(path).send({ ...cmd, operationId: 'triage-operation-2', expectedVersion: 1, status: 'RESOLVED' });
    expect(resolved.status).toBe(200); expect(resolved.body).toMatchObject({ status: 'RESOLVED', version: 2 });
    const actions = adminErrorActions(resolved.body);
    expect(actions).toHaveLength(3); expect(actions.some(a => a.body.status === 'NEW')).toBe(true);
    expect((await opened.db.query("SELECT id FROM system_admin_audit_events WHERE target_id='commerce:PROVIDER_TEMPORARILY_UNAVAILABLE'")).rows).toHaveLength(2);
    expect((await opened.db.query("SELECT last_error_code FROM commerce_connection_sync_states WHERE connection_id='sync-guards'")).rows[0].last_error_code)
      .toBe('PROVIDER_TEMPORARILY_UNAVAILABLE');
  });
});
