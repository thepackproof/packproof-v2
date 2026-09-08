import { describe, expect, it } from 'vitest';
import { normalizeShippoOrder, readShippoOrderBatch, type ShippoOrdersBatchInput } from '../src/integrations/shippo/orders.js';

// Hand-authored API-shape fixture. This is not evidence of a merchant-authorized live read.
const scope = { provider: 'shippo', externalAccountReference: 'merchant_1', connectionId: 'connection_1', namespaceSource: 'SHIPPING_PROVIDER_API' as const, store: 'Fixture store', verified: true as const };
const order = (patch: Record<string, unknown> = {}) => ({ object_id: 'object_1', order_number: '#1068', order_status: 'PAID', to_address: { country: 'US' }, line_items: [{ title: 'Trading card', quantity: 2, variant_title: 'Foil', sku: 'card-1' }, { title: 'Sleeve', quantity: 1 }], transactions: [], ...patch });
const context = { scope, rawSourceRef: 'private://fixture/raw', sourceDigest: 'a'.repeat(64), receivedAt: '2026-09-08T12:00:00Z' };
const authMaterial = { tenantId: 'tenant_1', connectionId: 'connection_1', merchantAccountId: 'merchant_1', ordersAuthorized: 'true', apiKey: 'shippo_live_synthetic_test' };
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const base = (fetcher: typeof fetch): ShippoOrdersBatchInput => ({ tenantId: 'tenant_1', connectionId: 'connection_1', merchantAccountId: 'merchant_1', credentialReference: 'memory:merchant-specific', scope, knownOrderIds: [], credentialStore: { async getCredentials(input) { expect(input.adapterKey).toBe('shippo-orders'); return { ...input, material: authMaterial }; } }, fetchImpl: fetcher, retainSource: async source => { expect(source.sha256).toMatch(/^[a-f0-9]{64}$/); return 'private://fixture/retained'; } });

describe('Shippo read-only order intake', () => {
  it('preserves complete multi-item quantities and keeps display reference out of exact identity', () => {
    const result = normalizeShippoOrder(order(), context);
    expect(result.input).toMatchObject({ externalOrderId: 'object_1', orderReference: '#1068', paid: true, sourceKind: 'API_OBSERVED', fulfillmentScope: 'FULL_ORDER', sourceOccurredAt: null });
    expect(result.input.physicalFulfillment).toBeNull();
    expect(result.input.items).toHaveLength(2);
    expect(result.input.items[0]).toMatchObject({ quantity: 2, variant: 'Foil' });
    expect(normalizeShippoOrder(order({ line_items: [{ title: 'Card' }] }), context).input.items[0].quantity).toBeNull();
    expect(normalizeShippoOrder(order({ line_items: [] }), context).input.items).toEqual([]);
  });
  it('separates label state, payment, partial and multi-parcel scope from carrier progress', () => {
    const shipped = normalizeShippoOrder(order({ order_status: 'SHIPPED', transactions: [{ object_id: 'label_1' }] }), context);
    expect(shipped.labelCreated).toBe(true); expect(shipped.input.paid).toBeNull(); expect(shipped.input.shipmentReferences).toEqual([]);
    expect(normalizeShippoOrder(order({ order_status: 'PARTIALLY_FULFILLED' }), context).input.fulfillmentScope).toBe('PARTIAL');
    expect(normalizeShippoOrder(order({ transactions: ['one', 'two'] }), context).input.fulfillmentScope).toBe('MULTI_PARCEL');
    expect(normalizeShippoOrder(order({ order_status: 'CANCELLED' }), context).input.cancelled).toBe(true);
    expect(() => normalizeShippoOrder(order({ transactions: [null] }), context)).toThrow();
  });
  it('uses the documented Bearer header for OAuth merchant credentials', async () => {
    let header: string | null = null;
    const input = base(async (_url, init) => { header = new Headers(init?.headers).get('authorization'); return response({ results: [], next: null }); });
    input.credentialStore = { async getCredentials(query) { return { ...query, material: { ...authMaterial, accessToken: 'oauth.synthetic', apiKey: '' } }; } };
    await readShippoOrderBatch(input); expect(header).toBe('Bearer oauth.synthetic');
  });
  it('refuses platform tracking credentials and foreign tenant material before making a request', async () => {
    let requests = 0; const input = base(async () => { requests++; return response({}); });
    for (const material of [{ apiKey: 'platform_tracking_key' }, { ...authMaterial, tenantId: 'tenant_other' }]) {
      input.credentialStore = { async getCredentials(query) { return { ...query, material }; } };
      await expect(readShippoOrderBatch(input)).rejects.toMatchObject({ code: 'MERCHANT_AUTHORIZATION_REQUIRED' });
    }
    expect(requests).toBe(0);
  });
  it('retains raw bytes, paginates read-only, revisits older known orders and checkpoints after bounded work', async () => {
    const seen: string[] = []; let retained = 0;
    const input = base(async (url, init) => {
      expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined(); seen.push(String(url));
      if (String(url).includes('/orders/known_old')) return response(order({ object_id: 'known_old', order_status: 'CANCELLED', placed_at: '2020-01-01' }));
      const current = new URL(String(url)); const page = Number(current.searchParams.get('page') || 1);
      current.searchParams.set('page', String(page + 1));
      return response({ next: page < 3 ? current.href : null, results: [order({ object_id: `listed_${page}` })] });
    });
    input.knownOrderIds = ['known_old']; input.placedAfter = '2026-09-01';
    input.retainSource = async () => { retained++; return 'private://raw'; };
    const first = await readShippoOrderBatch(input);
    expect(first.observations).toHaveLength(3); expect(first.reconciledOrderIds).toEqual(['known_old']);
    expect(first.nextCursor?.next).toContain('page=3'); expect(first.nextCursor?.knownIndex).toBe(1); expect(retained).toBe(3);
    const second = await readShippoOrderBatch({ ...input, cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull(); expect(second.observations).toHaveLength(1);
    expect(seen[2]).toBe('https://api.goshippo.com/orders/known_old');
  });
  it('honors rate backoff without consuming a cursor or exposing provider response bodies', async () => {
    await expect(readShippoOrderBatch(base(async () => response({ secret: 'do-not-log' }, 429, { 'retry-after': '90' })))).rejects.toMatchObject({ code: 'PROVIDER_RETRY_REQUIRED', retryAfterMs: 90000 });
    await expect(readShippoOrderBatch(base(async () => response({}, 401)))).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED', retryAfterMs: null });
  });
  it('rejects pagination exfiltration, foreign scope cursors, and falsely matched retrieval responses', async () => {
    for (const next of ['https://attacker.example/orders/?page=2', 'https://api.goshippo.com/tracks/?page=2', 'https://api.goshippo.com/orders/?page=1']) {
      await expect(readShippoOrderBatch(base(async () => response({ results: [], next })))).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
    }
    const input = base(async () => response({ results: [], next: null }));
    await expect(readShippoOrderBatch({ ...input, cursor: { version: 1, scope: 'other', phase: 'LIST', next: '/orders/', knownOrderIds: [], knownIndex: 0 } })).rejects.toMatchObject({ code: 'CURSOR_SCOPE_MISMATCH' });
    const foreign = base(async url => String(url).includes('/orders/expected') ? response(order()) : response({ results: [], next: null }));
    await expect(readShippoOrderBatch({ ...foreign, knownOrderIds: ['expected'] })).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });
});
