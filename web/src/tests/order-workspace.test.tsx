import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import { connectApprovalReturnPath } from '../auth/connect-approval-return';
import { AgentApproval } from '../records/AgentConnections';
import { OrderProofs } from '../records/OrderProofs';
import { OrderReferenceReview } from '../records/OrderReferenceReview';
import { canonicalWorkspacePath } from '../proof-list-state';

const params = new URLSearchParams({ installationId: 'pc', organizationId: 'org', environment: 'sandbox', workspaceSession: 'request1' });
const locator = '/app/records/connect/approve?' + params;
const pending = { id: 'request1', state: 'pending', scopeDigest: 'bound1', expiresAt: new Date(Date.now() + 600000).toISOString(), deviceName: 'Dispatch desk',
  scope: { history: 'existing_and_future', sources: [{ id: 'one', displayName: 'Orders', roles: ['order'] }], outputName: 'Saved records' } };
const org = { id: 'org', environment: 'sandbox', name: 'Demo', locations: [], role: 'ADMIN', enabled: true };
afterEach(cleanup);

it('restores the exact workspace approval after sign-in and rejects mixed or incomplete requests', () => {
  expect(connectApprovalReturnPath(locator + '&private=value')).toBe(locator);
  for (const extra of ['&action=resume', '&workspaceSession=other', '&subscriptionId=other', '&importId=batch']) {
    expect(connectApprovalReturnPath(locator + extra)).toBeNull();
  }
  expect(connectApprovalReturnPath(locator.replace('&organizationId=org', ''))).toBeNull();
});

it('records the choice for the displayed scope and shows its outcome', async () => {
  let state = 'pending';
  const recordsRequest = vi.fn(async (_path: string, method?: string) => {
    if (method === 'POST') state = 'active';
    return { ...pending, state };
  });
  render(<AgentApproval api={{ recordsRequest } as unknown as PackProofApi} organizationId="org" environment="sandbox" params={params} canManage/>);
  const button = await screen.findByRole('button', { name: 'Approve collection' });
  expect(screen.getByText('Saved records')).toBeVisible();
  fireEvent.click(button);
  await waitFor(() => expect(recordsRequest).toHaveBeenCalledWith('/agent-installations/pc/order-workspace/request1/decision?organizationId=org&environment=sandbox', 'POST',
    { organizationId: 'org', environment: 'sandbox', scopeDigest: 'bound1', decision: 'approve' }, { 'Idempotency-Key': expect.any(String) }));
  expect(await screen.findByText(/Access approved/)).toBeVisible();
});

it('does not read a request in a different workspace', () => {
  const recordsRequest = vi.fn();
  render(<AgentApproval api={{ recordsRequest } as unknown as PackProofApi} organizationId="other" environment="sandbox" params={params} canManage/>);
  expect(screen.getByRole('alert')).toHaveTextContent('Reopen');
  expect(recordsRequest).not.toHaveBeenCalled();
});

it('shows the approved upstream system, historical coverage and local output before consent', async () => {
  const source = { id: 'remote', displayName: 'Wholesale orders', roles: ['order'], transport: 'api', sourceNamespace: 'warehouse-east' };
  const recordsRequest = vi.fn(async () => ({ ...pending, scope: { ...pending.scope, sources: [...pending.scope.sources, source] } }));
  render(<AgentApproval api={{ recordsRequest } as unknown as PackProofApi} organizationId="org" environment="sandbox" params={params} canManage/>);
  expect(await screen.findByText('Wholesale orders')).toBeVisible();
  expect(screen.getByText(/warehouse-east.*saved summary/)).toBeVisible();
  expect(screen.getByText(/retain the originals online/)).toBeVisible();
  expect(screen.getByText('Existing records and future changes')).toBeVisible();
  expect(screen.getByText('Saved records')).toBeVisible();
  expect(recordsRequest.mock.calls.every(call => call.length < 2)).toBe(true);
});

it('displays the committed order and a new revision with the selection intact', async () => {
  let revision = 1;
  const recordsRequest = vi.fn(async (path: string) => {
    if (path.startsWith('/order-changes?')) {
      revision = 2;
      return { changes: [{ sequence: 100, revision: 2, proofId: 'proof1' }], nextCursor: 100, hasMore: false };
    }
    const summary = { proofId: 'proof1', orderReference: 'SO10482', revision, updatedAt: pending.expiresAt };
    if (path.startsWith('/order-proofs?')) return { orders: [summary], cursor: revision === 1 ? 23 : 100 };
    return { ...summary, lines: [{ lineId: '20', sku: 'A100', orderedQuantity: String(revision + 1) }], events: [], evidence: [] };
  });
  render(<OrderProofs api={{ recordsRequest } as unknown as PackProofApi} organization={org} id="proof1" locationId="dock" revision={0}/>);
  expect(await screen.findByRole('heading', { name: 'SO10482' })).toBeVisible();
  expect(screen.getByText('2', { selector: 'dd' })).toBeVisible();
  await waitFor(() => expect(screen.getByText('3', { selector: 'dd' })).toBeVisible(), { timeout: 3500 });
  expect(recordsRequest.mock.calls.every(([path]) => path.includes('locationId=dock'))).toBe(true);
  expect(canonicalWorkspacePath('/app/order-proofs/proof1?organizationId=org')).toBe('/app/order-proofs/proof1?organizationId=org');
});

it('requires a selected match and a reason and leaves a stale revision available for review', async () => {
  const scope = 'organizationId=org&environment=sandbox&locationId=dock';
  const item = { eventKey: 'event1', sourceId: 'operator', fileName: 'delivery.csv', locator: 'row 2', kind: 'delivery',
    entity: { namespace: 'erp', type: 'package', id: 'P2' }, references: [], reason: 'Select the order shown on the delivery receipt.' };
  const recordsRequest = vi.fn(async (path: string, method?: string) => {
    if (method === 'POST') throw new Error('This order changed. Review its current revision.');
    if (path.startsWith('/order-attention?')) return { items: [item], hasMore: false };
    return { orders: [{ proofId: 'receipt', orderReference: 'SO10482', revision: 8, updatedAt: pending.expiresAt }] };
  });
  render(<OrderReferenceReview api={{ recordsRequest } as unknown as PackProofApi} scope={scope} canManage/>);
  fireEvent.click(await screen.findByText('Choose the matching order'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Order number' }), { target: { value: 'SO10482' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find matching orders' }));
  fireEvent.click(await screen.findByRole('radio', { name: /SO10482/ }));
  const submit = screen.getByRole('button', { name: 'Link this report' });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Reason for this change'), { target: { value: 'Confirmed on delivery receipt' } });
  fireEvent.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('This order changed');
  expect(recordsRequest).toHaveBeenCalledWith('/order-proofs/receipt/associations?' + scope, 'POST', {
    organizationId: 'org', environment: 'sandbox', eventKey: 'event1', action: 'link', expectedRevision: 8, reason: 'Confirmed on delivery receipt',
  }, { 'Idempotency-Key': expect.any(String) });
  expect(screen.queryByText('The link was recorded.')).toBeNull();
});
