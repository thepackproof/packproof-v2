import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createUser, commitFulfillmentAndAttest, type TestHarness } from './helpers.js';
import { FakeShopifyClient } from './fixtures/connected-accounts.js';
import { createDefaultIntegrationRegistry } from '../src/integrations/registry.js';
import { createIntegrationConnection } from '../src/domain/integration-connections.js';
import { executeCommerceFulfillmentSync } from '../src/domain/commerce-fulfillment-sync.js';
import { assertSupportedParcelCapture, getParcelScope } from '../src/domain/parcel-scope.js';
import { admitIntakeProofContract, prepareExistingIntakeOrder, submitIntakeObservation } from '../src/intake/context.js';
import { createCaptureSession } from '../src/domain/capture-sessions.js';
import { bindCaptureShipping } from '../src/domain/capture-shipping.js';
import { finalizeProof } from '../src/domain/finalize.js';
import { getDisclosureProjection, DISCLOSURE_POLICY_VERSION, type DisclosureContext } from '../src/domain/disclosure.js';

let h: TestHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
async function setup(payment = 'paid', partial = true) {
  let now = Date.parse('2026-09-24T12:00:00Z');
  const clock = { now: () => new Date(now) };
  const client = new FakeShopifyClient();
  const order = client.orders[0];
  order.financialStatus = payment;
  order.fulfillmentStatus = partial ? 'partial' : null;
  order.updatedAt = clock.now().toISOString();
  order.lineItems[0].quantity = partial ? 3 : 1;
  order.lineItems[0].remainingQuantity = 1;
  order.fulfillments = partial ? [
    { id: 'previous-one', trackingNumber: '1Z999AA10123456784', lineItems: [{ id: 'li-1', quantity: 1 }] },
    { id: 'previous-two', trackingNumber: '1Z999AA10123456785', lineItems: [{ id: 'li-1', quantity: 1 }] },
  ] : [];
  order.trackingNumber = partial ? '1Z999AA10123456784' : null;
  const integrations = createDefaultIntegrationRegistry(clock, { shopifyClient: client });
  h = await createHarness(clock, { integrations });
  const harness = h;
  const seller = await createUser(harness);
  client.tokens.set('fixture-token', { shop: 'packproof-test.myshopify.com', name: 'Test store' });
  await harness.credentialStore.put({ adapterKey: 'shopify', credentialReference: 'memory:remaining', material: {
    accessToken: 'fixture-token', shop: 'packproof-test.myshopify.com', scope: 'read_orders,read_merchant_managed_fulfillment_orders,read_locations',
  } });
  const connection = await createIntegrationConnection(harness.db, clock, seller, { adapterKey: 'shopify', provider: 'shopify', externalAccountReference: 'packproof-test', credentialReference: 'memory:remaining' });
  const sync = async () => {
    now += 1000;
    order.updatedAt = clock.now().toISOString();
    return executeCommerceFulfillmentSync(harness.db, clock, seller, connection.connectionId, { integrations, credentials: harness.credentialStore });
  };
  expect((await sync()).createdProofCount).toBe(1);
  const proof = (await harness.db.query<{ id: string; transaction_id: string }>('SELECT id,transaction_id FROM proofs')).rows[0];
  return { harness, seller, proofId: proof.id, transactionId: proof.transaction_id, order, sync, clock };
}

describe('Shopify remaining-shipment capture boundary', () => {
  it.each([{payment:'paid',partial:true},{payment:'pending',partial:true},{payment:'pending',partial:false}])('records only the remaining shipment with actual $payment payment (partial=$partial) and freezes its exact scope', async ({payment,partial}) => {
    const { harness, seller, proofId, transactionId, order, sync, clock } = await setup(payment,partial);
    await expect(assertSupportedParcelCapture(harness.db, transactionId)).resolves.toBeUndefined();
    const parcel = await getParcelScope(harness.db, seller, proofId);
    expect(parcel.fulfillmentScope).toBe('REMAINING_SHIPMENT');
    expect(parcel.orderItems).toEqual([{ itemId: expect.any(String), quantity: 1 }]);
    expect(parcel.limitations).toContain('Previously fulfilled items are not included');
    expect((await harness.db.query('SELECT tracking_number FROM transaction_shipping WHERE transaction_id=$1', [transactionId])).rows).toHaveLength(0);
    await admitIntakeProofContract(harness.db, clock, seller, proofId);
    const prepared = await prepareExistingIntakeOrder(harness.db, clock, seller, transactionId);
    expect(prepared).toMatchObject({ readiness: 'READY', snapshot: { fulfillmentScope: 'REMAINING_SHIPMENT', items: [{ quantity: 1 }] } });
    expect((await harness.db.query<{ context: { paid: boolean } }>('SELECT context FROM intake_order_snapshots WHERE id=$1', [prepared.snapshot!.id])).rows[0].context.paid).toBe(payment === 'paid');
    await commitFulfillmentAndAttest(harness, seller, proofId);
    // Shopify may mark it shipped while the original packing recording is being finalized.
    order.fulfillmentStatus = 'fulfilled';
    order.lineItems[0].remainingQuantity = 0;
    order.fulfillmentOrders![0].status = 'CLOSED';
    order.fulfillmentOrders![0].lineItems[0].remainingQuantity = 0;
    await sync();
    const finalized = await finalizeProof(harness.db, clock, seller, proofId);
    const manifest = finalized.manifest.manifest as any;
    expect(manifest.transaction.quantity).toBe(1);
    expect(manifest.transaction.items).toMatchObject([{ externalItemId: 'li-1', quantity: 1 }]);
    expect(manifest.transaction.metadata.import.providerIdentifiers).toMatchObject({ fulfillmentScope: 'REMAINING_SHIPMENT', fulfillmentOrderId: 'fo-1' });
    expect(manifest.orderContext).toMatchObject({ fulfillmentScope: 'REMAINING_SHIPMENT', items: [{ quantity: 1 }] });
    const disclosure: DisclosureContext = {proofId,grantId:'fixture-view',policyVersion:DISCLOSURE_POLICY_VERSION,scopeVersion:1,purpose:'CLAIMS_REVIEW',fields:['status','order'],media:[]};
    expect(await getDisclosureProjection(harness.db,disclosure)).toMatchObject({fulfillmentScope:'REMAINING_SHIPMENT'});
    expect(await getDisclosureProjection(harness.db,{...disclosure,fields:['status']})).not.toHaveProperty('fulfillmentScope');
    await sync();
    expect((await finalizeProof(harness.db, clock, seller, proofId)).manifest.canonicalJson).toBe(finalized.manifest.canonicalJson);
    expect((await harness.db.query('SELECT id FROM proofs')).rows).toHaveLength(1);
  });

  it('never associates a prior shipment label with the remaining items', async () => {
    const { harness, seller, proofId } = await setup();
    const capture = await createCaptureSession(harness.db, harness.clock, seller, proofId, { client: 'NATIVE_CAMERA', idempotencyKey: 'remaining-label' });
    await expect(bindCaptureShipping(harness.db, harness.clock, seller, proofId, capture.id, {
      rawValue: '1Z999AA10123456784', format: 'CODE_128', detectedAtMs: 20, idempotencyKey: 'historic', confirmed: true,
    })).rejects.toMatchObject({ code: 'PARCEL_SCOPE_UNSUPPORTED' });
    expect((await harness.db.query('SELECT id FROM capture_shipping_labels')).rows).toHaveLength(0);
  });

  it('does not relabel an existing recording when remaining item quantities change', async () => {
    const { harness, seller, proofId, transactionId, order, sync } = await setup();
    await createCaptureSession(harness.db, harness.clock, seller, proofId, { client: 'NATIVE_CAMERA', idempotencyKey: 'original' });
    order.lineItems[0].remainingQuantity = 2;
    order.fulfillmentOrders![0].lineItems[0].remainingQuantity = 2;
    await sync();
    expect((await harness.db.query<{ quantity: number }>('SELECT quantity FROM transaction_items WHERE transaction_id=$1', [transactionId])).rows[0].quantity).toBe(1);
    await expect(assertSupportedParcelCapture(harness.db, transactionId)).rejects.toMatchObject({ code: 'PARCEL_SCOPE_UNSUPPORTED' });
    expect((await harness.db.query('SELECT id FROM proofs')).rows).toHaveLength(1);
  });

  it('requires authoritative Shopify scope and refuses seller-declared remaining shipments', async () => {
    const { harness, seller } = await setup();
    const result = await submitIntakeObservation(harness.db, harness.clock, seller, {
      receiptId: 'forged-scope', sourceKind: 'SELLER_DECLARED', adapterKey: 'manual', adapterVersion: '1', externalOrderId: 'another-order',
      items: [{ title: 'Unverified item', quantity: 1 }], physicalFulfillment: true, paid: false, cancelled: false, fulfillmentScope: 'REMAINING_SHIPMENT',
    }, { provider: 'shopify', externalAccountReference: 'packproof-test', namespaceSource: 'STOREFRONT_API', connectionId: 'manual', verified: true });
    expect(result).toMatchObject({ readiness: 'NEEDS_INFORMATION', transactionId: null, proofId: null });
    expect((await harness.db.query('SELECT id FROM proofs')).rows).toHaveLength(1);
  });
});
