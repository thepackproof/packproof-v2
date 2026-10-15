import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationPresentation } from '../src/experience/integration-presentation';
import type { SalesChannel } from '../src/copy/sales-channels';

const channel = (overrides: Partial<SalesChannel> = {}): SalesChannel => ({
  provider: 'shopify', providerDisplay: 'Shopify', accounts: [],
  catalog: { enabled: true, multipleAccounts: true, capabilities: { transactions: true, fulfillment: true } } as SalesChannel['catalog'], ...overrides,
});

test('only a supported enabled provider offers a new connection', () => {
  assert.equal(integrationPresentation(channel()).action, 'Connect');
  for (const catalog of [null, { enabled: false, capabilities: { transactions: true } }, { enabled: true, capabilities: {} }]) {
    assert.deepEqual(integrationPresentation(channel({ catalog: catalog as SalesChannel['catalog'] })), { canConnect: false, status: 'Unavailable', action: null });
  }
});
test('existing accounts remain openable when new connections are disabled', () => {
  const value = channel({ catalog: { enabled: false, capabilities: { transactions: true } } as SalesChannel['catalog'], accounts: [{ account: { status: 'CONNECTED' } as any, connection: null }] });
  assert.deepEqual(integrationPresentation(value), { canConnect: false, status: 'Connected', action: 'Open' });
});
test('reauthorization and connection errors remain visible even when intake is unavailable', () => {
  const value = channel({ catalog: null, accounts: [{ account: { status: 'CONNECTED' } as any, connection: { status: 'NEEDS_REAUTH' } as any }] });
  assert.equal(integrationPresentation(value).status, 'Needs attention');
  assert.equal(integrationPresentation(value).action, 'Open');
});
test('the existing multiple-account restriction remains authoritative', () => {
  const value = channel({ catalog: { enabled: true, multipleAccounts: false, capabilities: { transactions: true } } as SalesChannel['catalog'], accounts: [{ account: { status: 'CONNECTED' } as any, connection: null }] });
  assert.equal(integrationPresentation(value).canConnect, false);
  assert.equal(integrationPresentation(value).action, 'Open');
});
