import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import { connectApprovalReturnPath } from '../auth/connect-approval-return';
import { AgentApproval } from '../records/AgentConnections';
import { OrderProofs } from '../records/OrderProofs';
import { OrderSourceHealth } from '../records/OrderSourceHealth';
import { OrderReferenceReview } from '../records/OrderReferenceReview';
import { canonicalWorkspacePath } from '../proof-list-state';

const params = new URLSearchParams({ installationId: 'pc', organizationId: 'org', environment: 'sandbox', workspaceSession: 'request1' });
const locator = '/app/records/connect/approve?' + params;
const pending = { id: 'request1', state: 'pending', scopeDigest: 'bound1', expiresAt: new Date(Date.now() + 600000).toISOString(), deviceName: 'Dispatch desk',
  scope: { history: 'existing_and_future', sources: [{ id: 'one', displayName: 'Orders', roles: ['order'] }], outputName: 'Saved records' } };
const org = { id: 'org', environment: 'sandbox', name: 'Demo', locations: [], role: 'ADMIN', enabled: true };
afterEach(cleanup);

it('looks up a carton and links the exact subject and namespace on its authorized proof', async () => {
  const matched = {proofId:'proof1',orderReference:'SO-10482',updatedAt:pending.expiresAt,revision:5,
    locationId:'dock',matchedSubjects:[{type:'package',namespace:'pack',id:'CTN-02'}]};
  const recordsRequest = vi.fn(async (path:string) => ({orders:path.includes('q=') ? [matched] : [],cursor:5}));
  render(<OrderProofs api={{recordsRequest} as unknown as PackProofApi} organization={org} id={null} locationId="dock" revision={0}/>);
  fireEvent.change(screen.getByLabelText('Reference type'),{target:{value:'package'}});
  fireEvent.change(screen.getByLabelText('Exact reference'),{target:{value:'CTN-02'}});
  fireEvent.click(screen.getByRole('button',{name:'Find order'}));
  const link = await screen.findByRole('link',{name:'Carton CTN-02'});
  expect(new URL(link.getAttribute('href')!,'https://test').searchParams.get('namespace')).toBe('pack');
  expect(recordsRequest.mock.calls.some(([path])=>path.includes('q=CTN-02') && path.includes('referenceType=package') && path.includes('locationId=dock'))).toBe(true);
});

it('opens the selected carton at a pinned revision and rechecks original access', async () => {
  const subject = {id:'CTN-02',namespace:'pack',type:'package'};
  const event = {kind:'label',eventKey:'label2',entity:subject,references:[],sourceId:'dispatch',fields:{},
    occurredAt:'2026-11-19T13:42:00Z',observedAt:'2026-11-19T13:44:00Z'};
  const recordsRequest = vi.fn(async (path:string) => {
    if (path.includes('/sources/')) throw Error('Original access denied for this account.');
    if (path.startsWith('/order-proofs?')) return {orders:[],cursor:6};
    if (!path.startsWith('/order-proofs/p/revisions/5?')) throw Error('Unexpected mutable revision lookup');
    return {proofId:'p',orderReference:'SO-10482',revision:5,events:[event],evidence:[],lines:[],
      cartons:[{...subject,lastEventKind:'label',lastEventKey:'label2',occurredAt:event.occurredAt,deliveryStatus:'awaiting_evidence'}]};
  });
  render(<OrderProofs api={{recordsRequest} as unknown as PackProofApi} organization={org} id="p" locationId="dock" revision={0}
    routeParams={new URLSearchParams({revision:'5',subject:'CTN-02',subjectType:'package',namespace:'pack'})}/>);
  expect(await screen.findByText('Awaiting delivery evidence')).toBeVisible();
  expect(screen.getByText(/Received by PackProof/)).toBeVisible();
  expect(screen.getByRole('button',{name:'Download revision 5'})).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Inspect source record'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Original access denied');
  expect(recordsRequest.mock.calls.at(-1)![0]).toContain('/revisions/5/sources/label2?organizationId=org&environment=sandbox&locationId=dock');
});

it('groups a missed dispatch check once and keeps healthy-feed evidence deadlines separate', async () => {
  let recovered = false;
  const recordsRequest = vi.fn(async () => ({incidents:recovered ? [] : [{installationId:'PC',sourceId:'dispatch',generation:1,displayName:'Dispatch',
    state:'delayed',lastVerifiedReadAt:'2026-11-19T19:18:00Z',nextCheckAt:'2026-11-19T19:23:00Z',
    affectedOrders:[{proofId:'p',orderReference:'SO-10482'},{proofId:'q',orderReference:'SO-22'}]}],
    overdue:[{proofId:'q',orderReference:'SO-22',id:'CTN-03',namespace:'pack',deadline:'2026-11-19T19:20:00Z'}],limited:false}));
  render(<OrderSourceHealth api={{recordsRequest} as unknown as PackProofApi} scope="organizationId=org&environment=sandbox"/>);
  expect(await screen.findByRole('heading',{name:'Dispatch · Source check overdue'})).toBeVisible();
  expect(screen.getByText('Orders linked to this source (2)')).toBeVisible();
  recovered=true;
  fireEvent.click(screen.getByRole('button',{name:'Refresh feed checks'}));
  await waitFor(()=>expect(screen.queryByText('Dispatch · Source check overdue')).toBeNull());
  expect(screen.getByText('Delivery evidence overdue · CTN-03')).toBeVisible();
});

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
