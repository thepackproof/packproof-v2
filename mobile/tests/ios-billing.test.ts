import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBillingOffer, readBillingStatus, readInvoices, readUsage, requireExternalCheckout, safeBillingDestination } from '../src/billing/model';

test('mobile billing reads the existing monthly offer and rejects incomplete monetary or consent details', () => {
  const offer = { enabled: true, offer: { version: 'offer-test', sha256: 'a'.repeat(64), priceMinor: 1200, currency: 'USD', interval: 'monthly', includedFinalizedProofs: 25, maxRecordingSeconds: 300, maxRecordingBytes: 250000000 } };
  assert.deepEqual(readBillingOffer(offer), offer);
  for (const change of [{ priceMinor: -1 }, { priceMinor: '1200' }, { sha256: null }, { interval: 'usage' }, { currency: 'unknown' }]) assert.throws(() => readBillingOffer({ ...offer, offer: { ...offer.offer, ...change } }));
  assert.deepEqual(readBillingOffer({ enabled: false, offer: null }), { enabled: false, offer: null });
});

test('plan status preserves cancellation and estimated-charge state without creating charges', () => {
  const status = { enabled: true, subscriptions: [{ subscriptionReference: 'sub_fixture', status: 'active', currentPeriodEnd: '2026-10-01T00:00:00Z', trialEnd: null, cancelAtPeriodEnd: true, cancelAt: null, canceledAt: null, endedAt: null, nextCharge: null }], pendingCheckout: null };
  assert.deepEqual(readBillingStatus(status), status);
  assert.equal(readBillingStatus(status).subscriptions[0].cancelAtPeriodEnd, true);
  assert.throws(() => readBillingStatus({ ...status, subscriptions: [{ ...status.subscriptions[0], nextCharge: { expectedAt: 'soon', baseAmountMinor: 100, currency: 'USD' } }] }));
});

test('invoice and usage views reject malformed provider amounts, pagination, and allowances', () => {
  const invoices = { enabled: true, environment: 'live', hasMore: false, invoices: [{ invoiceReference: 'in_fixture', status: 'paid', currency: 'USD', amountDueMinor: 1200, amountPaidMinor: 1200, createdAt: '2026-09-14T00:00:00Z' }] };
  assert.deepEqual(readInvoices(invoices), invoices);
  assert.throws(() => readInvoices({ ...invoices, hasMore: true }));
  assert.throws(() => readInvoices({ ...invoices, invoices: [{ ...invoices.invoices[0], amountDueMinor: -100 }] }));
  const usage = { window: { start: '2026-09-01', end: '2026-10-01' }, finalizedWithDurabilityReceipt: 2, finalizedWithoutConfirmedDurability: 1, recordedUsageUnits: 3, message: 'Current month', currentOffer: { version: 'offer-test', remaining: 22, includedFinalizedProofs: 25, period: { end: '2026-10-01' } } };
  assert.deepEqual(readUsage(usage), usage);
  assert.throws(() => readUsage({ ...usage, currentOffer: { ...usage.currentOffer, remaining: -1 } }));
});

test('billing destinations cannot send the browser to another host or embed account credentials', () => {
  assert.equal(safeBillingDestination('https://checkout.stripe.com/c/pay/example', 'checkout.stripe.com'), 'https://checkout.stripe.com/c/pay/example');
  for (const value of ['http://checkout.stripe.com/c/pay', 'https://checkout.stripe.com.attacker.test/', 'https://user:password@checkout.stripe.com/', 'https://billing.stripe.com:8443/', 'javascript:alert(1)']) assert.throws(() => safeBillingDestination(value, 'checkout.stripe.com'));
});

test('external billing rechecks actual storefront on every action and fails closed if unavailable or changed', async () => {
  let calls = 0, allowed = true;
  const storefront = async () => { calls += 1; return allowed; };
  await requireExternalCheckout(storefront);
  allowed = false; await assert.rejects(requireExternalCheckout(storefront), /unavailable/);
  assert.equal(calls, 2);
  await assert.rejects(requireExternalCheckout(async () => { throw new Error('native unavailable'); }), /unavailable/);
});
