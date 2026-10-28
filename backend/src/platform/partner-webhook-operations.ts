import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { reauthorizePartner, strictBody, type PartnerActor } from './organizations.js';
import { textField } from './tenants.js';
import { revokeWebhook, rotateWebhookSecret, retryWebhookDelivery, type WebhookConfig } from './webhooks.js';

export interface WebhookHistoryConfig { signingKey: string }
interface HistoryCursor {
  v: 1; kind: 'subscriptions' | 'deliveries'; tenantId: string; merchantId: string;
  environment: string; principalId: string; credentialId: string; delegationId: string | null;
  webhookId: string | null; afterId: string; expiresAt: number;
}
const CURSOR_LIFETIME_MS = 86400000;
function signingKey(config: WebhookHistoryConfig) {
  const key = Buffer.from(config.signingKey, 'base64');
  if (key.length !== 32) throw new DomainError('WEBHOOK_HISTORY_UNAVAILABLE', 'Webhook history cursor signing is not configured', 503);
  return key;
}
function signature(payload: string, config: WebhookHistoryConfig) {
  return createHmac('sha256', signingKey(config)).update('packproof.webhook-history/v1.' + payload).digest();
}
function encode(cursor: HistoryCursor, config: WebhookHistoryConfig) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return payload + '.' + signature(payload, config).toString('base64url');
}
function invalidCursor(): never { throw new DomainError('INVALID_CURSOR', 'Use a cursor from this webhook history and credential', 400); }
function decode(value: unknown, clock: Clock, actor: PartnerActor, kind: HistoryCursor['kind'], webhookId: string | null, config: WebhookHistoryConfig) {
  if (typeof value !== 'string' || value.length > 2048) return invalidCursor();
  const parts = value.split('.');
  if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return invalidCursor();
  const actual = Buffer.from(parts[1], 'base64url'), expected = signature(parts[0], config);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalidCursor();
  let c: HistoryCursor;
  try { c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return invalidCursor(); }
  if (!c || c.v !== 1 || c.kind !== kind || c.tenantId !== actor.tenantId || c.merchantId !== actor.merchantId ||
      c.environment !== actor.environment || c.principalId !== actor.principalId || c.credentialId !== actor.credentialId ||
      c.delegationId !== actor.delegationGrantId || c.webhookId !== webhookId || typeof c.afterId !== 'string' ||
      c.afterId.length > 400 || /[\x00-\x1f]/.test(c.afterId) || !Number.isSafeInteger(c.expiresAt)) return invalidCursor();
  if (c.expiresAt <= clock.now().getTime()) throw new DomainError('WEBHOOK_HISTORY_CURSOR_EXPIRED', 'Restart webhook history pagination', 410);
  return c.afterId;
}
function pageInput(input: {after?: unknown; limit?: unknown}, clock: Clock, actor: PartnerActor,
  kind: HistoryCursor['kind'], webhookId: string | null, config: WebhookHistoryConfig) {
  signingKey(config);
  if (input.limit != null && !(typeof input.limit === 'number' || (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit))))
    throw new DomainError('INVALID_LIMIT', 'limit must be an integer from 1 to 100', 400);
  const limit = input.limit == null ? 50 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('INVALID_LIMIT', 'limit must be an integer from 1 to 100', 400);
  const after = input.after == null ? '' : decode(input.after, clock, actor, kind, webhookId, config);
  const cursor = (afterId: string) => encode({v: 1, kind, tenantId: actor.tenantId, merchantId: actor.merchantId,
    environment: actor.environment, principalId: actor.principalId, credentialId: actor.credentialId,
    delegationId: actor.delegationGrantId, webhookId, afterId, expiresAt: clock.now().getTime() + CURSOR_LIFETIME_MS}, config);
  return {limit, after, cursor};
}
function notFound(): never { throw new DomainError('WEBHOOK_NOT_FOUND', 'Webhook not found', 404); }

/** Original principal and delegation own a subscription. Tenant selection alone
 * never permits one partner to manage another partner's endpoint.
 * Check before cached results as well as inside the command transaction. */
export async function requirePartnerWebhook(db: Database, clock: Clock, actor: PartnerActor, webhookId: string,
  options: {active?: boolean; write?: boolean} = {}) {
  await reauthorizePartner(db, clock, actor, 'webhooks:manage');
  const id = textField(webhookId, 'webhookId');
  const found = await db.query<{id: string; revoked_at: Date | string | null}>(`
    SELECT w.id,w.revoked_at FROM api_webhooks w
    JOIN platform_webhook_authorizations a ON a.webhook_id=w.id
    JOIN platform_credentials c ON c.id=a.credential_id
    WHERE w.id=$1 AND w.tenant_id=$2 AND a.merchant_id=$3 AND c.principal_id=$4
      AND a.delegation_id IS NOT DISTINCT FROM $5::text ${options.write ? 'FOR UPDATE OF w FOR SHARE OF a,c' : 'FOR SHARE OF w,a,c'}`,
    [id, actor.tenantId, actor.merchantId, actor.principalId, actor.delegationGrantId]);
  const row = found.rows[0];
  if (!row || (options.active && row.revoked_at)) return notFound();
  return row;
}
export async function requirePartnerWebhookDelivery(db: Database, clock: Clock, actor: PartnerActor, webhookId: string, deliveryId: string) {
  await requirePartnerWebhook(db, clock, actor, webhookId);
  const id = textField(deliveryId, 'deliveryId', 400);
  const found = await db.query<{id: string}>('SELECT id FROM api_webhook_deliveries WHERE id=$1 AND webhook_id=$2', [id, webhookId]);
  if (!found.rows[0]) throw new DomainError('DELIVERY_NOT_FOUND', 'Webhook delivery not found', 404);
  return found.rows[0];
}
export async function listPartnerWebhooks(db: Database, clock: Clock, actor: PartnerActor, config: WebhookHistoryConfig,
  input: {after?: unknown; limit?: unknown} = {}) {
  await reauthorizePartner(db, clock, actor, 'webhooks:manage');
  const page = pageInput(input, clock, actor, 'subscriptions', null, config);
  const found = await db.query<{id: string; url: string; eventTypes: string[]; createdAt: Date | string; revokedAt: Date | string | null}>(`
    SELECT w.id,w.url,w.event_types AS "eventTypes",w.created_at AS "createdAt",w.revoked_at AS "revokedAt"
    FROM api_webhooks w JOIN platform_webhook_authorizations a ON a.webhook_id=w.id
    JOIN platform_credentials c ON c.id=a.credential_id
    WHERE w.tenant_id=$1 AND a.merchant_id=$2 AND c.principal_id=$3
      AND a.delegation_id IS NOT DISTINCT FROM $4::text AND w.id>$5 ORDER BY w.id LIMIT $6`,
    [actor.tenantId, actor.merchantId, actor.principalId, actor.delegationGrantId, page.after, page.limit + 1]);
  const rows = found.rows.slice(0, page.limit);
  await reauthorizePartner(db, clock, actor, 'webhooks:manage');
  return {schemaVersion: 'packproof.webhook-subscriptions/v1', webhooks: rows.map(r => ({...r,
    createdAt: new Date(r.createdAt).toISOString(), revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null})),
    nextCursor: rows.length ? page.cursor(rows[rows.length - 1].id) : null, hasMore: found.rows.length > page.limit};
}
interface DeliveryRow {
  id: string; eventId: string; eventType: string; proofId: string; eventCreatedAt: Date | string;
  state: 'pending' | 'sending' | 'delivered' | 'dead'; attempts: number; lastStatus: number | null;
  nextAttemptAt: Date | string; deliveredAt: Date | string | null;
}
function deliveryDto(row: DeliveryRow, active = true) {
  return {...row, eventCreatedAt: new Date(row.eventCreatedAt).toISOString(),
    nextAttemptAt: row.state === 'pending' || row.state === 'sending' ? new Date(row.nextAttemptAt).toISOString() : null,
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt).toISOString() : null,
    retryable: active && row.state === 'dead'};
}
const DELIVERY_COLUMNS = `d.id,d.event_id AS "eventId",o.event_type AS "eventType",o.proof_id AS "proofId",
  o.created_at AS "eventCreatedAt",d.state,d.attempts,d.last_status AS "lastStatus",
  d.next_attempt_at AS "nextAttemptAt",d.delivered_at AS "deliveredAt"`;
export async function listPartnerWebhookDeliveries(db: Database, clock: Clock, actor: PartnerActor, webhookId: string,
  config: WebhookHistoryConfig, input: {after?: unknown; limit?: unknown} = {}) {
  await requirePartnerWebhook(db, clock, actor, webhookId);
  const page = pageInput(input, clock, actor, 'deliveries', webhookId, config);
  const found = await db.query<DeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM api_webhook_deliveries d
    JOIN proof_outbox o ON o.id=d.event_id WHERE d.webhook_id=$1 AND d.id>$2 ORDER BY d.id LIMIT $3`,
    [webhookId, page.after, page.limit + 1]);
  const rows = found.rows.slice(0, page.limit);
  const subscription = await requirePartnerWebhook(db, clock, actor, webhookId);
  return {schemaVersion: 'packproof.webhook-deliveries/v1', webhookId, deliveries: rows.map(r => deliveryDto(r, !subscription.revoked_at)),
    nextCursor: rows.length ? page.cursor(rows[rows.length - 1].id) : null, hasMore: found.rows.length > page.limit};
}
export async function readPartnerWebhookDelivery(db: Database, clock: Clock, actor: PartnerActor, webhookId: string, deliveryId: string) {
  await requirePartnerWebhookDelivery(db, clock, actor, webhookId, deliveryId);
  const found = await db.query<DeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM api_webhook_deliveries d
    JOIN proof_outbox o ON o.id=d.event_id WHERE d.webhook_id=$1 AND d.id=$2`, [webhookId, deliveryId]);
  const subscription = await requirePartnerWebhook(db, clock, actor, webhookId);
  if (!found.rows[0]) throw new DomainError('DELIVERY_NOT_FOUND', 'Webhook delivery not found', 404);
  return {schemaVersion: 'packproof.webhook-delivery/v1', webhookId, delivery: deliveryDto(found.rows[0], !subscription.revoked_at)};
}
export async function rotatePartnerWebhookSecret(db: Database, clock: Clock, actor: PartnerActor, webhookId: string, input: unknown, config: WebhookConfig) {
  strictBody(input ?? {}, []);
  await requirePartnerWebhook(db, clock, actor, webhookId, {active: true, write: true});
  return rotateWebhookSecret(db, actor.tenantId, webhookId, config);
}
export async function retryPartnerWebhookDelivery(db: Database, clock: Clock, actor: PartnerActor, webhookId: string, deliveryId: string, input: unknown) {
  strictBody(input ?? {}, []);
  await requirePartnerWebhook(db, clock, actor, webhookId, {active: true, write: true});
  await requirePartnerWebhookDelivery(db, clock, actor, webhookId, deliveryId);
  return retryWebhookDelivery(db, clock, actor.tenantId, deliveryId);
}
export async function revokePartnerWebhook(db: Database, clock: Clock, actor: PartnerActor, webhookId: string) {
  await requirePartnerWebhook(db, clock, actor, webhookId, {write: true});
  return revokeWebhook(db, clock, actor.tenantId, webhookId);
}
