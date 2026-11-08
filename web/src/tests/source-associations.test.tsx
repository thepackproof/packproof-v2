import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PackProofApi } from '../api/client';
import { ApiError } from '../api/types';
import { SourceAssociations } from '../records/SourceAssociations';
import type { RecordOrganization, RecordSummary, SourceAssociation } from '../records/types';

afterEach(cleanup);
const organization: RecordOrganization = { id: 'org-a', name: 'Main warehouse', environment: 'sandbox', enabled: true, role: 'OWNER', locations: [{ id: 'site-a', name: 'Site A' }] };
const item: SourceAssociation = { id: 'association_first', connectionId: 'source-a', locationId: 'site-a', sourceEventId: '000099', reference: { type: 'SHIPMENT', externalId: '000123' }, sourceKind: 'Approved exporter', sourceSchemaVersion: '2026.1', mappingVersion: 'mapping/v1', state: 'pending', operationId: null, proofId: null, attempts: 1, errorCode: null, resolution: { outcome: 'unresolved_ambiguous', candidates: ['proof-a', 'proof-b'], ruleVersion: 'packproof.source-reference/v1', basis: 'unique_bound_child' }, reportedAt: '2026-11-05T15:00:00Z', receivedAt: '2026-11-05T15:10:00Z', updatedAt: '2026-11-05T15:11:00Z', sourceAssurance: 'organization_submitted' };
const target: RecordSummary = { id: 'proof-a', proofId: 'proof-a', organizationId: 'org-a', environment: 'sandbox', reference: 'SHIP-123', title: 'Fittings shipment', trackingNumber: null, carrier: null, createdAt: item.receivedAt, updatedAt: item.receivedAt, revision: 1, lifecycle: 'open', sample: false, locationId: 'site-a', coverage: { satisfied: 0, total: 0, waived: 0, missing: 0, notYetDue: 0 }, integrity: 'not_sealed', review: 'unreviewed', issueCount: 0 };
const asApi = (request: unknown) => ({ recordsRequest: request }) as unknown as PackProofApi;
const props = { organization, revision: 0, onUpdated: vi.fn() };
async function chooseTarget() {
  fireEvent.click(await screen.findByText('Approve an exact source mapping'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Find the target shipment' }), { target: { value: 'SHIP-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find authorized records' }));
  fireEvent.click(await screen.findByRole('radio', { name: /SHIP-123/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason for this mapping' }), { target: { value: 'Confirmed against the source dispatch record.' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /checked the source records/ }));
}
it('does not request unassigned source exceptions for operators', () => {
  const request = vi.fn();
  render(<SourceAssociations {...props} organization={{ ...organization, role: 'OPERATOR' }} api={asApi(request)}/>);
  expect(request).not.toHaveBeenCalled(); expect(screen.queryByRole('region')).not.toBeInTheDocument();
});
it('shows receipt lineage and separate clocks to a reviewer without granting mapping authority', async () => {
  const request = vi.fn(async () => ({ items: [item], nextCursor: null }));
  render(<SourceAssociations {...props} organization={{ ...organization, role: 'REVIEWER' }} api={asApi(request)}/>);
  expect(await screen.findByRole('heading', { name: '000123' })).toBeVisible();
  expect(screen.getByText('PackProof received')).toBeVisible(); expect(screen.getByText('Source-reported time')).toBeVisible();
  expect(screen.getByText(/outside the inventory of earlier signed snapshots/)).toBeVisible();
  expect(screen.getByText(/workspace administrator can approve/)).toBeVisible();
  expect(screen.queryByText('Approve an exact source mapping')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Queue source replay' })).not.toBeInTheDocument();
});
it('requires a deliberate authorized-record selection, exact location and source confirmation before mapping', async () => {
  const request = vi.fn(async (path: string, method?: string) => method === 'POST' ? { value: { proofId: 'proof-a' }, replayed: false } : path.startsWith('?') ? { records: [target, { ...target, id: 'wrong-site', proofId: 'wrong-site', locationId: 'site-b', reference: 'OTHER-SITE' }] } : { items: [item], nextCursor: null });
  render(<SourceAssociations {...props} api={asApi(request)}/>);
  const approve = await screen.findByRole('button', { name: 'Approve mapping and queue replay', hidden: true }); expect(approve).toBeDisabled();
  await chooseTarget(); expect(screen.queryByRole('radio', { name: /OTHER-SITE/ })).not.toBeInTheDocument();
  expect(approve).toBeEnabled(); fireEvent.click(approve);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/source-crosswalks?organizationId=org-a&environment=sandbox', 'POST', { organizationId: 'org-a', environment: 'sandbox', connectionId: 'source-a', locationId: 'site-a', reference: { type: 'SHIPMENT', externalId: '000123' }, proofId: 'proof-a', ruleVersion: 'packproof.source-reference/v1', reason: 'Confirmed against the source dispatch record.' }, expect.objectContaining({ 'Idempotency-Key': expect.any(String) })));
  expect(await screen.findByRole('status')).toHaveTextContent('queued for replay');
  const queryCall = request.mock.calls.find(([path]) => path.startsWith('?'))!; expect(queryCall[0]).toContain('locationId=site-a');
});
it('retains one command identity across a failed mapping response', async () => {
  let fail = true;
  const request = vi.fn(async (path: string, method?: string) => { if (method === 'POST') { if (fail) { fail = false; throw new Error('Response lost; retry this command.'); } return { value: {}, replayed: true }; } return path.startsWith('?') ? { records: [target] } : { items: [item], nextCursor: null }; });
  render(<SourceAssociations {...props} api={asApi(request)}/>); await chooseTarget();
  fireEvent.click(screen.getByRole('button', { name: 'Approve mapping and queue replay' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Response lost');
  fireEvent.click(screen.getByRole('button', { name: 'Approve mapping and queue replay' }));
  await screen.findByText(/Mapping approved/);
  const commands = request.mock.calls.filter(([, method]) => method === 'POST') as unknown as Array<[string, string, unknown, { 'Idempotency-Key': string }]>;
  expect(commands).toHaveLength(2); expect(commands[0][3]['Idempotency-Key']).toBe(commands[1][3]['Idempotency-Key']);
});
it('requires renewed confirmation after the mapping reason changes', async () => {
  const request = vi.fn(async (path: string) => path.startsWith('?') ? { records: [target] } : { items: [item], nextCursor: null });
  render(<SourceAssociations {...props} api={asApi(request)}/>); await chooseTarget();
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason for this mapping' }), { target: { value: 'A different reviewed source record.' } });
  expect(screen.getByRole('checkbox', { name: /checked the source records/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Approve mapping and queue replay' })).toBeDisabled();
});
it('retains the queued command result across the resulting refresh and removes it on workspace change', async () => {
  let mapped = false;
  const request = vi.fn(async (path: string, method?: string) => { if (method === 'POST') { mapped = true; return { value: {}, replayed: false }; } return path.startsWith('?') ? { records: [target] } : { items: mapped ? [] : [item], nextCursor: null }; });
  const api = asApi(request), { rerender } = render(<SourceAssociations {...props} api={api}/>); await chooseTarget();
  fireEvent.click(screen.getByRole('button', { name: 'Approve mapping and queue replay' }));
  expect(await screen.findByRole('status')).toHaveTextContent('queued for replay');
  rerender(<SourceAssociations {...props} revision={1} api={api}/>);
  expect(await screen.findByText(/No unlinked observations/)).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Mapping approved');
  rerender(<SourceAssociations {...props} organization={{ ...organization, id: 'org-b' }} revision={1} api={api}/>);
  await screen.findByText(/No unlinked observations/);
  expect(screen.queryByText(/Mapping approved/)).not.toBeInTheDocument();
});
it('keeps changed source identities separate and never offers conflict reassignment or replay', async () => {
  const request = vi.fn(async () => ({ items: [{ ...item, state: 'conflict', errorCode: 'SOURCE_EVENT_CONFLICT' }], nextCursor: null }));
  render(<SourceAssociations {...props} api={asApi(request)}/>);
  expect(await screen.findByText(/reused with changed details/)).toBeVisible();
  expect(screen.queryByText('Approve an exact source mapping')).not.toBeInTheDocument();
  expect(screen.queryByText('Replay after repairing this source')).not.toBeInTheDocument();
});
it('loads later source exceptions with the returned cursor while keeping the first receipt visible', async () => {
  const request = vi.fn(async (path: string) => path.includes('before=') ? { items: [item, { ...item, id: 'association_later', reference: { ...item.reference, externalId: '000124' } }], nextCursor: null } : { items: [item], nextCursor: 'association_first' });
  render(<SourceAssociations {...props} api={asApi(request)}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more source exceptions' }));
  expect(await screen.findByRole('heading', { name: '000124' })).toBeVisible(); expect(screen.getAllByRole('heading', { name: '000123' })).toHaveLength(1);
  expect(request).toHaveBeenLastCalledWith('/source-associations?organizationId=org-a&environment=sandbox&limit=50&before=association_first');
});
it('drops a late response from a previous workspace without displaying its source receipt', async () => {
  let finish: (value: unknown) => void = () => undefined; const stale = new Promise(resolve => { finish = resolve; });
  const request = vi.fn(async (path: string) => path.includes('org-a') ? stale : { items: [{ ...item, id: 'association_other', reference: { ...item.reference, externalId: 'OTHER-99' } }], nextCursor: null });
  const api = asApi(request), { rerender } = render(<SourceAssociations {...props} api={api}/>);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  rerender(<SourceAssociations {...props} organization={{ ...organization, id: 'org-b' }} api={api}/>);
  expect(await screen.findByRole('heading', { name: 'OTHER-99' })).toBeVisible(); finish({ items: [item], nextCursor: null });
  await waitFor(() => expect(screen.queryByRole('heading', { name: '000123' })).not.toBeInTheDocument());
});
it('reports unavailable authorization as an error without claiming an empty queue', async () => {
  const request = vi.fn(async () => { throw new ApiError('SOURCE_REVIEW_REQUIRED', 'Denied', 403); });
  render(<SourceAssociations {...props} api={asApi(request)}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('workspace access'); expect(screen.queryByText(/No unlinked observations/)).not.toBeInTheDocument();
});
it('queues administrator recovery with a reason without approving a new mapping', async () => {
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { state: 'pending' } : { items: [{ ...item, state: 'blocked_policy', errorCode: 'CONNECTION_PAUSED' }], nextCursor: null });
  render(<SourceAssociations {...props} api={asApi(request)}/>);
  fireEvent.click(await screen.findByText('Replay after repairing this source'));
  expect(screen.getByRole('button', { name: 'Queue source replay' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'What was repaired?' }), { target: { value: 'Source resumed after access review.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Queue source replay' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/source-associations/association_first/replay?organizationId=org-a&environment=sandbox', 'POST', { organizationId: 'org-a', environment: 'sandbox', reason: 'Source resumed after access review.' }, expect.objectContaining({ 'Idempotency-Key': expect.any(String) })));
  expect(await screen.findByRole('status')).toHaveTextContent('Replay queued');
});
