import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import { connectApprovalReturnPath } from '../auth/connect-approval-return';
import { AgentApproval } from '../records/AgentConnections';
import { OrderProofs } from '../records/OrderProofs';
import { canonicalWorkspacePath } from '../proof-list-state';

const params = new URLSearchParams({ installationId: 'pc', organizationId: 'org', environment: 'sandbox', workspaceSession: 'request1' });
const locator = '/app/records/connect/approve?' + params;
const pending = { id: 'request1', state: 'pending', scopeDigest: 'bound1', expiresAt: new Date(Date.now() + 600000).toISOString(), deviceName: 'Dispatch desk',
  scope: { history: 'existing_and_future', sources: [{ id: 'one', displayName: 'Orders', roles: ['order'] }], outputName: 'Saved records' } };
const org = { id: 'org', environment: 'sandbox', name: 'Demo', locations: [], role: 'ADMIN', enabled: true };

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
