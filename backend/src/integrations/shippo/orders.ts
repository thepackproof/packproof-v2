import { createHash } from 'node:crypto';
import type { IntegrationCredentialStore } from '../credentials.js';
import type { IntakeObservationInput, IntakeScope } from '../../intake/context.js';

/** Deliberately separate from shippo-tracker and its platform tracking credential. */
export const SHIPPO_ORDERS_ADAPTER_KEY = 'shippo-orders';
export const SHIPPO_ORDERS_ADAPTER_VERSION = '1';
const ORIGIN = 'https://api.goshippo.com';
const MAX_BYTES = 2_000_000;
const id = (value: unknown): string | null => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown, limit = 1000): string | null => typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : null;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export class ShippoOrdersError extends Error {
  constructor(readonly code: 'MERCHANT_AUTHORIZATION_REQUIRED' | 'PROVIDER_AUTH_FAILED' | 'PROVIDER_RESPONSE_INVALID' | 'PROVIDER_RETRY_REQUIRED' | 'CURSOR_SCOPE_MISMATCH', readonly retryAfterMs: number | null = null) {
    super(code); this.name = 'ShippoOrdersError';
  }
}
export interface ShippoOrdersCursor {
  version: 1;
  scope: string;
  phase: 'LIST' | 'RECONCILE';
  next: string | null;
  /** Frozen queue: callers persist this cursor after observations commit. */
  knownOrderIds: string[];
  knownIndex: number;
}
export interface ShippoOrderIdentity { scope: IntakeScope; externalOrderId: string; paid?: boolean | null; physicalFulfillment?: boolean | null }
export interface ShippoOrderObservation {
  input: IntakeObservationInput;
  scope: IntakeScope;
  shippoOrderId: string;
  sourceDigest: string;
  labelCreated: boolean;
  /** Shippo order status never produces carrier progress or Proof completion. */
  providerStatus: string | null;
  labelTransactionIds: string[];
}
export interface ShippoOrdersBatchInput {
  credentialStore: IntegrationCredentialStore;
  tenantId: string;
  connectionId: string;
  merchantAccountId: string;
  /** A merchant authorization record; never the default tracking reference. */
  credentialReference: string;
  scope: IntakeScope;
  cursor?: ShippoOrdersCursor | null;
  /** Known open/unrecorded Shippo object IDs, independent of placement dates. */
  knownOrderIds: string[];
  /** Discovery filter ONLY, not a last-updated cursor. */
  placedAfter?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Preserve exact response bytes privately before accepting observations. */
  retainSource: (input: { bytes: Buffer; sha256: string; connectionId: string }) => Promise<string>;
  /** Lookup an established object-ID alias. Never resolve by order_number. */
  resolveIdentity?: (shippoOrderId: string) => Promise<ShippoOrderIdentity | null>;
}

function assertCursorPath(value: string): URL {
  let url: URL;
  try { url = new URL(value, ORIGIN); } catch { throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID'); }
  if (url.origin !== ORIGIN || !/^\/orders\/?$/.test(url.pathname) || url.username || url.password || url.hash || url.href.length > 2048) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  for (const key of url.searchParams.keys()) if (!['page', 'results', 'start_date'].includes(key)) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  return url;
}
function retryDelay(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return 30_000;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.min(900_000, Math.max(1000, milliseconds)) : 30_000;
}
async function boundedBody(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  const reader = response.body?.getReader();
  if (!reader) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { await reader.cancel(); throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** One bounded worker batch; GET only. A retry never advances the durable cursor. */
export async function readShippoOrderBatch(input: ShippoOrdersBatchInput): Promise<{ observations: ShippoOrderObservation[]; nextCursor: ShippoOrdersCursor | null; reconciledOrderIds: string[]; health: 'AUTHORIZED_READ_SUCCEEDED' }> {
  if (!id(input.tenantId) || !id(input.connectionId) || !id(input.merchantAccountId) || !input.credentialReference || input.scope.provider !== 'shippo' || !input.scope.verified || input.scope.connectionId !== input.connectionId || input.scope.externalAccountReference !== input.merchantAccountId) throw new ShippoOrdersError('MERCHANT_AUTHORIZATION_REQUIRED');
  const credentials = await input.credentialStore.getCredentials({ adapterKey: SHIPPO_ORDERS_ADAPTER_KEY, credentialReference: input.credentialReference, connectionId: input.connectionId });
  const material = credentials?.material;
  // Provisioned at the authenticated server boundary after merchant consent.
  if (!material || credentials?.adapterKey !== SHIPPO_ORDERS_ADAPTER_KEY || material.tenantId !== input.tenantId || material.merchantAccountId !== input.merchantAccountId || material.connectionId !== input.connectionId || material.ordersAuthorized !== 'true') throw new ShippoOrdersError('MERCHANT_AUTHORIZATION_REQUIRED');
  const token = material.accessToken || material.apiKey;
  if (!token || /[\r\n]/.test(token) || token.length > 4096) throw new ShippoOrdersError('MERCHANT_AUTHORIZATION_REQUIRED');
  const scopeDigest = digest(JSON.stringify([input.tenantId, input.connectionId, input.merchantAccountId, input.credentialReference]));
  const known = [...new Set(input.knownOrderIds)].sort();
  if (known.length > 1000 || known.some(value => !id(value))) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  const initial = new URL('/orders/?results=50', ORIGIN);
  if (input.placedAfter) {
    const stamp = new Date(input.placedAfter);
    if (!Number.isFinite(stamp.getTime())) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    initial.searchParams.set('start_date', stamp.toISOString());
  }
  const cursor: ShippoOrdersCursor = input.cursor ? structuredClone(input.cursor) : { version: 1, scope: scopeDigest, phase: 'LIST', next: initial.href, knownOrderIds: known, knownIndex: 0 };
  if (cursor.version !== 1 || cursor.scope !== scopeDigest || !['LIST', 'RECONCILE'].includes(cursor.phase) || !Array.isArray(cursor.knownOrderIds) || cursor.knownOrderIds.length > 1000 || cursor.knownOrderIds.some(value => !id(value)) || !Number.isInteger(cursor.knownIndex) || cursor.knownIndex < 0 || cursor.knownIndex > cursor.knownOrderIds.length || (cursor.phase === 'LIST' && !cursor.next)) throw new ShippoOrdersError('CURSOR_SCOPE_MISMATCH');
  const observations: ShippoOrderObservation[] = [], reconciledOrderIds: string[] = [];
  const fetcher = input.fetchImpl ?? fetch;
  async function read(url: URL): Promise<{ value: Record<string, unknown>; rawRef: string; sha256: string }> {
    let response: Response;
    try { response = await fetcher(url, { method: 'GET', headers: { Authorization: `${material!.accessToken ? 'Bearer' : 'ShippoToken'} ${token}`, Accept: 'application/json', 'SHIPPO-API-VERSION': '2018-02-08' }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new ShippoOrdersError('PROVIDER_RETRY_REQUIRED', 30_000); }
    if ([401, 403].includes(response.status)) throw new ShippoOrdersError('PROVIDER_AUTH_FAILED');
    if (response.status === 429 || response.status === 408 || response.status >= 500) throw new ShippoOrdersError('PROVIDER_RETRY_REQUIRED', retryDelay(response));
    if (!response.ok) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    const bytes = await boundedBody(response), sha256 = digest(bytes);
    const rawRef = await input.retainSource({ bytes, sha256, connectionId: input.connectionId });
    if (!string(rawRef, 2048)) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    let parsed: unknown; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID'); }
    const value = object(parsed); if (!value) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    return { value, rawRef, sha256 };
  }
  async function append(order: Record<string, unknown>, rawRef: string, sha256: string): Promise<void> {
    const objectId = id(order.object_id); if (!objectId) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    const alias = await input.resolveIdentity?.(objectId) ?? null;
    if (alias && (!alias.scope.verified || alias.scope.connectionId !== input.connectionId || !id(alias.externalOrderId))) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    observations.push(normalizeShippoOrder(order, { scope: input.scope, identity: alias, rawSourceRef: rawRef, sourceDigest: sha256, receivedAt: (input.now?.() ?? new Date()).toISOString() }));
  }
  // At most two discovery pages and ten known-order reconciliation reads per run.
  let pages = 0;
  while (cursor.phase === 'LIST' && pages++ < 2) {
    const url = assertCursorPath(cursor.next!);
    const { value, rawRef, sha256 } = await read(url);
    if (!Array.isArray(value.results) || value.results.length > 100 || (value.next !== null && value.next !== undefined && typeof value.next !== 'string')) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    for (const candidate of value.results) { const order = object(candidate); if (!order) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID'); await append(order, rawRef, sha256); }
    const next = value.next ? assertCursorPath(String(value.next)).href : null;
    if (next) {
      const nextUrl = new URL(next), currentPage = Number(url.searchParams.get('page') ?? '1'), nextPage = Number(nextUrl.searchParams.get('page'));
      if (!Number.isInteger(nextPage) || nextPage <= currentPage || nextPage > 10000 || nextUrl.searchParams.get('start_date') !== url.searchParams.get('start_date')) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    }
    cursor.next = next;
    if (!next) cursor.phase = 'RECONCILE';
  }
  let reads = 0;
  while (cursor.knownIndex < cursor.knownOrderIds.length && reads++ < 10) {
    const objectId = cursor.knownOrderIds[cursor.knownIndex];
    const { value, rawRef, sha256 } = await read(new URL(`/orders/${encodeURIComponent(objectId)}`, ORIGIN));
    if (value.object_id !== objectId) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    await append(value, rawRef, sha256); reconciledOrderIds.push(objectId); cursor.knownIndex++;
  }
  return { observations, nextCursor: cursor.phase === 'RECONCILE' && cursor.knownIndex === cursor.knownOrderIds.length ? null : cursor, reconciledOrderIds, health: 'AUTHORIZED_READ_SUCCEEDED' };
}

export function normalizeShippoOrder(order: Record<string, unknown>, context: { scope: IntakeScope; identity?: ShippoOrderIdentity | null; rawSourceRef: string; sourceDigest: string; receivedAt: string }): ShippoOrderObservation {
  const objectId = id(order.object_id); if (!objectId || !context.scope.verified) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  if (order.line_items !== undefined && !Array.isArray(order.line_items)) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  const lines = (order.line_items ?? []) as unknown[];
  if (lines.length > 100) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  const items = lines.map(value => {
    const item = object(value); if (!item) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
    return { title: string(item.title), quantity: typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 100000 ? item.quantity : null, description: string(item.description, 4000), variant: string(item.variant_title), sku: string(item.sku, 200), externalItemId: id(item.object_id) };
  });
  if (order.transactions !== undefined && !Array.isArray(order.transactions)) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  const status = string(order.order_status, 64), txs = Array.isArray(order.transactions) ? order.transactions : [];
  if (txs.length > 100) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  const transactionIds = txs.map(value => id(typeof value === 'string' ? value : object(value)?.object_id)).filter((value): value is string => value !== null);
  if (transactionIds.length !== txs.length) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
  const providerUpdated = string(order.object_updated, 64);
  const validUpdated = providerUpdated && Number.isFinite(Date.parse(providerUpdated)) ? new Date(providerUpdated).toISOString() : null;
  const identity = context.identity;
  const ownOrderDigest = digest(JSON.stringify(order));
  return {
    shippoOrderId: objectId, sourceDigest: context.sourceDigest, providerStatus: status, labelCreated: status === 'SHIPPED' || transactionIds.length > 0, labelTransactionIds: transactionIds,
    scope: identity?.scope ?? context.scope,
    input: {
      receiptId: `shippo-order:${objectId}:${ownOrderDigest}`, sourceKind: 'API_OBSERVED', adapterKey: SHIPPO_ORDERS_ADAPTER_KEY, adapterVersion: SHIPPO_ORDERS_ADAPTER_VERSION,
      externalOrderId: identity?.externalOrderId ?? objectId, orderReference: string(order.order_number, 200), items,
      // An address alone does not prove that every purchased item needs shipping.
      physicalFulfillment: identity?.physicalFulfillment ?? null,
      paid: identity?.paid ?? (status === 'PAID' ? true : ['AWAITPAY', 'REFUNDED'].includes(status ?? '') ? false : null),
      cancelled: status === 'CANCELLED' || status === 'REFUNDED',
      fulfillmentScope: status === 'PARTIALLY_FULFILLED' ? 'PARTIAL' : transactionIds.length > 1 ? 'MULTI_PARCEL' : ['PAID', 'SHIPPED', 'AWAITPAY', 'CANCELLED', 'REFUNDED'].includes(status ?? '') ? 'FULL_ORDER' : 'UNKNOWN',
      // Receipt time is not a provider update and cannot outrank one.
      sourceRevision: validUpdated, sourceOccurredAt: validUpdated, rawSourceRef: context.rawSourceRef, shipmentReferences: [],
    },
  };
}
