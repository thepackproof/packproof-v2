import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { randomBytes } from 'node:crypto';
import request from './in-process-http.js';
import { openIsolatedTestDatabase } from './isolated-test-database.js';
import { migrate } from '../src/db/migrate.js';
import { insertUser } from '../src/domain/users.js';
import { DomainError } from '../src/domain/errors.js';
import type { AppDependencies } from '../src/app.js';
import {
  createOrganization, setOrganizationEntitlement, addOrganizationMember, createServicePrincipal,
  issuePartnerCredential, createDelegation, createIntegrationAccount, authenticatePartner,
  revokeDelegation, PARTNER_SCOPES, type PartnerActor,
} from '../src/platform/organizations.js';
import { importPartnerOrder } from '../src/platform/partner-proofs.js';
import { createPartnerRouter } from '../src/platform/partner-router.js';
import { createWebhook, dispatchWebhooks, verifyWebhook, signWebhook } from '../src/platform/webhooks.js';
import {
  listPartnerWebhooks, listPartnerWebhookDeliveries, readPartnerWebhookDelivery,
  rotatePartnerWebhookSecret, retryPartnerWebhookDelivery, revokePartnerWebhook,
} from '../src/platform/partner-webhook-operations.js';

describe('partner webhook diagnostics and recovery', () => {
  let opened: Awaited<ReturnType<typeof openIsolatedTestDatabase>>, app: ReturnType<typeof express>;
  let now = Date.now();
  const clock = {now: () => new Date(now)};
  const config = {encryptionKey: randomBytes(32).toString('base64'), allowedHosts: ['example.com']};
  const history = {signingKey: randomBytes(32).toString('base64')};
  let admin: string, ownerA: string, ownerB: string, operator: string, partner: string;
  let merchantA: string, merchantB: string, membership: string, account: string, grantA: string, grantB: string;
  let credential: string, actor: PartnerActor, sibling: PartnerActor, crossed: PartnerActor;
  let serial = 0;
  const expires = () => new Date(Date.now() + 7 * 86400000).toISOString();
  const headers = () => ({Authorization: 'Bearer ' + credential, 'PackProof-Merchant-Id': merchantA, 'PackProof-Delegation-Id': grantA});
  beforeAll(async () => {
    vi.stubEnv('PACKPROOF_ORGANIZATIONS_ENABLED', 'true');
    vi.stubEnv('PACKPROOF_EVENT_CURSOR_KEY', history.signingKey);
    opened = await openIsolatedTestDatabase();
    await migrate(opened.db);
    [admin, ownerA, ownerB, operator] = await Promise.all(Array.from({length: 4}, () => insertUser(opened.db, clock)));
    await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'nericollin@gmail.com',$2,'COGNITO')", [admin, clock.now().toISOString()]);
    merchantA = (await createOrganization(opened.db, clock, admin, {kind: 'MERCHANT', name: 'Webhook merchant A', ownerUserId: ownerA}, 'setup')).id;
    merchantB = (await createOrganization(opened.db, clock, admin, {kind: 'MERCHANT', name: 'Webhook merchant B', ownerUserId: ownerB}, 'setup')).id;
    partner = (await createOrganization(opened.db, clock, admin, {kind: 'PARTNER', name: 'Webhook partner'}, 'setup')).id;
    for (const id of [merchantA, merchantB, partner]) await setOrganizationEntitlement(opened.db, clock, admin, id, {enabled: true}, 'setup');
    membership = String((await addOrganizationMember(opened.db, clock, ownerA, merchantA, {userId: operator, role: 'OPERATOR'}, 'setup')).id);
    account = (await createIntegrationAccount(opened.db, clock, ownerA, merchantA, {provider: 'reference', externalAccountId: 'webhook-merchant'}, 'setup')).id;
    grantA = (await createDelegation(opened.db, clock, ownerA, merchantA, {partnerOrganizationId: partner, scopes: [...PARTNER_SCOPES], operatorUserIds: [operator], expiresAt: expires()}, 'setup')).id;
    grantB = (await createDelegation(opened.db, clock, ownerB, merchantB, {partnerOrganizationId: partner, scopes: [...PARTNER_SCOPES], operatorUserIds: [], expiresAt: expires()}, 'setup')).id;
    const principal = (await createServicePrincipal(opened.db, clock, admin, partner, {name: 'Webhook adapter'}, 'setup')).id;
    credential = (await issuePartnerCredential(opened.db, clock, admin, partner, principal, {scopes: [...PARTNER_SCOPES], expiresAt: expires()}, 'setup')).token;
    actor = await authenticatePartner(opened.db, clock, 'Bearer ' + credential, merchantA, grantA, 'history-test');
    crossed = await authenticatePartner(opened.db, clock, 'Bearer ' + credential, merchantB, grantB, 'cross-test');
    const other = (await createServicePrincipal(opened.db, clock, admin, partner, {name: 'Sibling adapter'}, 'setup')).id;
    const siblingCredential = (await issuePartnerCredential(opened.db, clock, admin, partner, other, {scopes: [...PARTNER_SCOPES], expiresAt: expires()}, 'setup')).token;
    sibling = await authenticatePartner(opened.db, clock, 'Bearer ' + siblingCredential, merchantA, grantA, 'sibling-test');
    app = express();
    app.use(express.json());
    app.use('/v1/partner', createPartnerRouter({db: opened.db, clock, webhookConfig: config, publicBaseUrl: 'https://example.com'} as AppDependencies));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof DomainError) res.status(error.httpStatus).json({code: error.code});
      else res.status(500).json({error: String(error)});
    });
  }, 60000);
  afterAll(async () => { await opened?.close(); vi.unstubAllEnvs(); });

  async function subscription(owner = actor) {
    now += 1000;
    return opened.db.transaction(async tx => {
      const result = await createWebhook(tx, clock, owner.tenantId, {url: 'https://example.com/events', eventTypes: ['proof.created']}, config);
      await tx.query('INSERT INTO platform_webhook_authorizations(webhook_id,merchant_id,credential_id,delegation_id) VALUES($1,$2,$3,$4)',
        [result.id, owner.merchantId, owner.credentialId, owner.delegationGrantId]);
      return result;
    });
  }
  async function seedDelivery(webhookId: string, state: 'pending' | 'dead' = 'dead') {
    const proof = await importPartnerOrder(opened.db, clock, actor, {integrationAccountId: account, externalId: 'WEBHOOK-' + (++serial),
      operatorMembershipId: membership, transaction: {itemTitle: 'Synthetic parcel', quantity: 1}});
    const event = (await opened.db.query<{id: string}>("SELECT id FROM proof_outbox WHERE proof_id=$1 AND event_type='proof.created'", [proof.proofId])).rows[0];
    const id = webhookId + ':' + event.id;
    await opened.db.query('INSERT INTO api_webhook_deliveries(id,webhook_id,event_id,state,attempts,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6)',
      [id, webhookId, event.id, state, state === 'dead' ? 10 : 0, clock.now().toISOString()]);
    return {id, eventId: event.id, proofId: proof.proofId};
  }

  it('isolates subscriptions and delivery diagnostics by merchant and originating principal', async () => {
    const own = await subscription(), other = await subscription(sibling);
    const delivery = await seedDelivery(own.id);
    const visible = await listPartnerWebhooks(opened.db, clock, actor, history);
    expect(visible.webhooks.some(w => w.id === own.id)).toBe(true);
    expect(visible.webhooks.some(w => w.id === other.id)).toBe(false);
    for (const denied of [crossed, sibling]) {
      await expect(listPartnerWebhookDeliveries(opened.db, clock, denied, own.id, history)).rejects.toMatchObject({code: 'WEBHOOK_NOT_FOUND'});
      await expect(rotatePartnerWebhookSecret(opened.db, clock, denied, own.id, {}, config)).rejects.toMatchObject({code: 'WEBHOOK_NOT_FOUND'});
      await expect(retryPartnerWebhookDelivery(opened.db, clock, denied, own.id, delivery.id, {})).rejects.toMatchObject({code: 'WEBHOOK_NOT_FOUND'});
      await expect(revokePartnerWebhook(opened.db, clock, denied, own.id)).rejects.toMatchObject({code: 'WEBHOOK_NOT_FOUND'});
    }
    const result = await readPartnerWebhookDelivery(opened.db, clock, actor, own.id, delivery.id);
    expect(result.delivery).toMatchObject({id: delivery.id, eventId: delivery.eventId, proofId: delivery.proofId, state: 'dead', attempts: 10, retryable: true, nextAttemptAt: null});
    expect(JSON.stringify(result)).not.toContain(own.secret);
    await revokePartnerWebhook(opened.db, clock, actor, own.id);
    await revokePartnerWebhook(opened.db, clock, sibling, other.id);
  });

  it('binds bounded pagination to the resource, actor and credential and rejects tampering/expiry', async () => {
    const own = await subscription(), second = await subscription();
    const a = await seedDelivery(own.id), b = await seedDelivery(own.id);
    const first = await listPartnerWebhookDeliveries(opened.db, clock, actor, own.id, history, {limit: 1});
    const rotatedCredential = (await issuePartnerCredential(opened.db, clock, admin, partner, actor.principalId, {scopes: [...PARTNER_SCOPES], expiresAt: expires()}, 'setup')).token;
    const rotatedActor = await authenticatePartner(opened.db, clock, 'Bearer ' + rotatedCredential, merchantA, grantA, 'new-credential');
    await expect(listPartnerWebhookDeliveries(opened.db, clock, rotatedActor, own.id, history, {after: first.nextCursor})).rejects.toMatchObject({code: 'INVALID_CURSOR'});
    expect(first.hasMore).toBe(true);
    const next = await listPartnerWebhookDeliveries(opened.db, clock, actor, own.id, history, {limit: 1, after: first.nextCursor});
    expect(new Set([...first.deliveries, ...next.deliveries].map(d => d.id))).toEqual(new Set([a.id, b.id]));
    await expect(listPartnerWebhookDeliveries(opened.db, clock, actor, second.id, history, {after: first.nextCursor})).rejects.toMatchObject({code: 'INVALID_CURSOR'});
    await expect(listPartnerWebhookDeliveries(opened.db, clock, actor, own.id, history, {after: first.nextCursor + 'x'})).rejects.toMatchObject({code: 'INVALID_CURSOR'});
    for (const limit of [0, 101, 1.5, ['2'], '1e2']) await expect(listPartnerWebhookDeliveries(opened.db, clock, actor, own.id, history, {limit})).rejects.toMatchObject({code: 'INVALID_LIMIT'});
    await expect(listPartnerWebhookDeliveries(opened.db, {now: () => new Date(now + 86400001)}, actor, own.id, history, {after: first.nextCursor})).rejects.toMatchObject({code: 'WEBHOOK_HISTORY_CURSOR_EXPIRED'});
    await revokePartnerWebhook(opened.db, clock, actor, own.id);
    await revokePartnerWebhook(opened.db, clock, actor, second.id);
  });

  it('rotates once through encrypted idempotency and denies cached secret replay after revocation', async () => {
    const own = await subscription();
    const path = '/v1/partner/webhooks/' + own.id + '/rotate-secret';
    const first = await request(app).post(path).set(headers()).set('Idempotency-Key', 'rotation').send({});
    expect(first.status, first.text).toBe(200);
    expect(first.body.id).toBe(own.id);
    expect(first.body.secret).toMatch(/^whsec_/);
    expect(first.body.secret).not.toBe(own.secret);
    const replay = await request(app).post(path).set(headers()).set('Idempotency-Key', 'rotation').send({});
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const cache = await opened.db.query<{response: unknown}>("SELECT response FROM api_idempotency WHERE operation LIKE '%rotate-secret'");
    expect(JSON.stringify(cache.rows)).not.toContain(first.body.secret);
    expect(JSON.stringify(cache.rows)).toContain('encrypted');
    const forged = await request(app).post(path).set(headers()).set('Idempotency-Key', 'bad-rotation').send({secret: 'chosen-by-client'});
    expect(forged.status).toBe(400);
    await seedDelivery(own.id, 'pending');
    let captured: {body: string; headers: Record<string, string>} | undefined;
    await dispatchWebhooks(opened.db, clock, config, async (_url, body, h) => {
      captured = {body, headers: h};
      return 200;
    }, 1);
    expect(captured).toBeDefined();
    expect(verifyWebhook(first.body.secret, captured!.headers['PackProof-Signature'], captured!.body, Math.floor(now / 1000))).toBe(true);
    expect(verifyWebhook(own.secret, captured!.headers['PackProof-Signature'], captured!.body, Math.floor(now / 1000))).toBe(false);
    await revokePartnerWebhook(opened.db, clock, actor, own.id);
    const denied = await request(app).post(path).set(headers()).set('Idempotency-Key', 'rotation').send({});
    expect(denied.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain(first.body.secret);
  });

  it('replays exhausted delivery with the same event, fresh signature and distinct send-attempt IDs', async () => {
    const own = await subscription(), delivery = await seedDelivery(own.id);
    const before = await readPartnerWebhookDelivery(opened.db, clock, actor, own.id, delivery.id);
    const retried = await request(app).post('/v1/partner/webhooks/' + own.id + '/deliveries/' + encodeURIComponent(delivery.id) + '/retry')
      .set(headers()).set('Idempotency-Key', 'delivery-replay').send({});
    expect(retried.status, retried.text).toBe(200);
    expect(retried.body).toEqual({id: delivery.id, state: 'pending'});
    const sent: {body: string; headers: Record<string, string>}[] = [];
    await dispatchWebhooks(opened.db, clock, config, async (_url, body, h) => {sent.push({body, headers: h}); return 503;}, 1);
    const due = (await opened.db.query<{next_attempt_at: Date | string}>('SELECT next_attempt_at FROM api_webhook_deliveries WHERE id=$1', [delivery.id])).rows[0];
    now = new Date(due.next_attempt_at).getTime() + 1;
    await dispatchWebhooks(opened.db, clock, config, async (_url, body, h) => {sent.push({body, headers: h}); return 200;}, 1);
    expect(sent).toHaveLength(2);
    for (const attempt of sent) {
      expect(attempt.headers['PackProof-Event-Id']).toBe(delivery.eventId);
      expect(attempt.headers['PackProof-Delivery-Id']).toBe(delivery.id);
      expect(verifyWebhook(own.secret, attempt.headers['PackProof-Signature'], attempt.body, Math.floor(now / 1000))).toBe(true);
    }
    expect(sent[0].headers['PackProof-Attempt-Id']).not.toBe(sent[1].headers['PackProof-Attempt-Id']);
    expect(sent[0].headers['PackProof-Signature']).not.toBe(sent[1].headers['PackProof-Signature']);
    expect(sent[0].body).toBe(sent[1].body);
    const after = await readPartnerWebhookDelivery(opened.db, clock, actor, own.id, delivery.id);
    expect(after.delivery).toMatchObject({eventId: before.delivery.eventId, state: 'delivered', retryable: false, attempts: 2});
    expect((await opened.db.query('SELECT 1 FROM api_webhook_deliveries WHERE webhook_id=$1 AND event_id=$2', [own.id, delivery.eventId])).rows).toHaveLength(1);
    await expect(retryPartnerWebhookDelivery(opened.db, clock, actor, own.id, delivery.id, {})).rejects.toMatchObject({code: 'DELIVERY_NOT_RETRYABLE'});
    await revokePartnerWebhook(opened.db, clock, actor, own.id);
  });

  it('retains the ten-attempt cap and recovers a simulated 24-hour outage by explicit durable replay', async () => {
    const own = await subscription(), delivery = await seedDelivery(own.id, 'pending');
    for (let attempt = 0; attempt < 10; attempt++) {
      await dispatchWebhooks(opened.db, clock, config, async () => 503, 1);
      const due = (await opened.db.query<{next_attempt_at: Date | string}>('SELECT next_attempt_at FROM api_webhook_deliveries WHERE id=$1', [delivery.id])).rows[0];
      now = new Date(due.next_attempt_at).getTime() + 1;
    }
    const failed = await readPartnerWebhookDelivery(opened.db, clock, actor, own.id, delivery.id);
    expect(failed.delivery).toMatchObject({state: 'dead', attempts: 10});
    now += 86400000;
    await retryPartnerWebhookDelivery(opened.db, clock, actor, own.id, delivery.id, {});
    await dispatchWebhooks(opened.db, clock, config, async () => 200, 1);
    expect((await readPartnerWebhookDelivery(opened.db, clock, actor, own.id, delivery.id)).delivery).toMatchObject({state: 'delivered', eventId: delivery.eventId});
    await revokePartnerWebhook(opened.db, clock, actor, own.id);
  });

  it('rejects modified/stale signatures and immediately stops new operations and queued delivery after grant revocation', async () => {
    const own = await subscription(), delivery = await seedDelivery(own.id, 'pending');
    const body = '{"synthetic":true}', timestamp = Math.floor(now / 1000), signed = signWebhook(own.secret, timestamp, body);
    expect(verifyWebhook(own.secret, signed, body, timestamp)).toBe(true);
    expect(verifyWebhook(own.secret, signed, body + ' ', timestamp)).toBe(false);
    expect(verifyWebhook(own.secret, signed, body, timestamp + 301)).toBe(false);
    await revokeDelegation(opened.db, clock, ownerA, merchantA, grantA, 'revoke');
    for (const call of [
      () => listPartnerWebhookDeliveries(opened.db, clock, actor, own.id, history),
      () => rotatePartnerWebhookSecret(opened.db, clock, actor, own.id, {}, config),
      () => retryPartnerWebhookDelivery(opened.db, clock, actor, own.id, delivery.id, {}),
    ]) await expect(call()).rejects.toMatchObject({code: 'INSUFFICIENT_SCOPE'});
    let sent = 0;
    await dispatchWebhooks(opened.db, clock, config, async () => {sent++; return 200;});
    expect(sent).toBe(0);
    expect((await opened.db.query('SELECT 1 FROM api_webhook_deliveries WHERE id=$1', [delivery.id])).rows).toHaveLength(1);
  });
});
