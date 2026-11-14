import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackProofApi } from '../api/client';
import type { WebSession } from '../auth/session';
import RecordsPortal from '../records/RecordsPortal';
import { OperationalCases } from '../records/OperationalCases';
import type { OperationalCaseDetail } from '../records/operational-types';
import { canonicalWorkspacePath } from '../proof-list-state';
import { recordsPath, recordsRoute } from '../records/model';

vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ scheme: 'light', setPreference: vi.fn() }) }));
const organization = { id: 'org-a', name: 'Warehouse A', environment: 'live', enabled: true, role: 'OWNER', locations: [{ id: 'site-a', name: 'Site A' }] };
const params = new URLSearchParams({ organizationId: 'org-a', environment: 'live', locationId: 'site-a' });
const subject = { type: 'shipment_line', namespace: 'approved-wms', externalId: 'S-0021/004' };
const source = { connectionId: 'Loading export', receiptId: 'receipt-loading', row: 12, field: 'LoadedQty', mappingVersion: 'loading/3', revision: '2', reportedAt: null, sourceAsOf: '2026-11-12T19:00:00Z', receivedAt: '2026-11-12T19:03:00Z', timeQuality: 'snapshot_time_only', originalSha256: 'a'.repeat(64) };
const detail: OperationalCaseDetail = {
  schema: 'packproof.operational-case/v1', projectionVersion: 'projection-2', case: { id: 'case-a', reference: '0010482', type: 'order', locationId: 'site-a', state: 'reconstructed', updatedAt: source.receivedAt, shipmentCount: 1, issueCount: 1 },
  assertions: [{ id: 'loaded-8', subject, property: 'reportedLoadedQuantity', value: { amount: '8', unit: 'each' }, active: true, source }],
  comparisons: [{ id: 'quantity-1', subject, ruleVersion: 'quantity/1', outcome: 'different', title: 'Two-unit difference between allocated and reported loaded quantities', explanation: 'Shipment S-0021 has 10 each allocated and 8 each reported loaded. Delivery reports 8 each received.', inputAssertionIds: ['allocated-10', 'loaded-8'], absoluteDifference: { numerator: '2', denominator: '1' }, baseUnit: 'each', physicalCondition: 'not_established', inputs: [{ id: 'allocated-10', property: 'allocatedQuantity', value: { amount: '10', unit: 'each' }, source: { ...source, connectionId: 'Order export', receiptId: 'receipt-order', row: 4, field: 'AllocatedQty' } }, { id: 'loaded-8', property: 'reportedLoadedQuantity', value: { amount: '8', unit: 'each' }, source }] }],
  relationships: [{ id: 'relation-1', from: { type: 'order', namespace: 'erp', externalId: '0010482' }, to: { type: 'shipment', namespace: 'approved-wms', externalId: 'S-0021' }, type: 'fulfilled_by', quantity: { amount: '10', unit: 'each' }, sourceReceiptId: 'receipt-order', row: 4, restricted: false }],
  timeline: [{ id: 'timeline-1', observationKind: 'snapshot', reportedAt: null, sourceAsOf: source.sourceAsOf, receivedAt: source.receivedAt, timeQuality: 'snapshot_time_only', late: true, sourceConnectionId: 'Loading export', assertionIds: ['loaded-8'] }],
  sources: [{ connectionId: 'delivery', sourceNamespace: 'delivery-site-a', state: 'delayed', label: 'Source updates delayed', lastReceivedAt: null, sourceAsOf: null, lastCheckedAt: null, expectedIntervalSeconds: 3600, coverage: 'unknown', nextAction: 'Review the delayed delivery exporter.', accounting: { received: 3, acceptedLinked: 1, acceptedUnlinked: 1, duplicate: 0, conflict: 1, quarantined: 0, rejected: 0, processing: 0, reconciled: true } }],
  pagination: { section: 'comparisons', limit: 50, total: 1, returnedCount: 1, hasMore: false, nextCursor: null, projectionVersion: 'projection-2' },
  limitations: ['Additional shipments or order changes cannot be ruled out from the connected data.'],
};
const extract = { assertionId: 'loaded-8', original: { name: 'loading.csv', sha256: source.originalSha256 }, locator: { row: 12, field: 'LoadedQty' }, value: '8', source: { connectionId: 'Loading export', mappingVersion: 'loading/3', revision: '2' }, extraction: 'case_scoped', originalAvailable: true };
beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/app/cases'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function cases(api: PackProofApi, overrides: Partial<Parameters<typeof OperationalCases>[0]> = {}) { return <OperationalCases api={api} organization={organization} params={params} id="case-a" revision={0} onGo={vi.fn()} onRefresh={vi.fn()} enabled {...overrides}/>; }

it('shows source-attributed values and opens only the authorized supporting extract with focus recovery', async () => {
  const request = vi.fn(async (path: string) => path.includes('/assertions/') ? extract : detail), user = userEvent.setup();
  render(cases({ recordsRequest: request } as unknown as PackProofApi));
  expect(await screen.findByRole('heading', { name: 'Order 0010482' })).toBeVisible();
  expect(screen.getByText('10 each')).toBeVisible();
  expect(screen.getByText('8 each')).toBeVisible();
  expect(screen.getByText(/Delivery reports 8 each/)).toBeVisible();
  const button = screen.getByRole('button', { name: 'Open reported loaded source' });
  await user.click(button);
  expect(await screen.findByText('loading.csv')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Supporting source row' })).toHaveFocus();
  expect(request).toHaveBeenLastCalledWith('/cases/case-a/assertions/loaded-8/source?organizationId=org-a&environment=live&locationId=site-a');
  expect(screen.queryByRole('link', { name: /original/i })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Close source row' }));
  expect(button).toHaveFocus();
});

it('preserves the distinction between delayed information and a delivery outcome', async () => {
  render(cases({ recordsRequest: vi.fn(async () => detail) } as unknown as PackProofApi));
  expect(await screen.findByRole('heading', { name: 'Source health and coverage' })).toBeVisible();
  expect(screen.getByText('Source updates delayed')).toBeVisible();
  expect(screen.getByText(/Coverage unknown/)).toBeVisible();
  await userEvent.setup().click(screen.getByText('Known gaps and scope'));
  expect(screen.getByText(/Additional shipments or order changes cannot be ruled out/)).toBeVisible();
  expect(screen.queryByText(/not delivered|lost goods|stolen/i)).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByText('Input accounting'));
  expect(screen.getByText('Accepted, awaiting a link')).toBeVisible();
  expect(screen.getByText('Accounting reconciled')).toBeVisible();
});

it('keeps large collection totals and server pagination reachable with scoped filters', async () => {
  const onGo = vi.fn(), paged = { ...detail, pagination: { ...detail.pagination, total: 601, returnedCount: 50, hasMore: true, nextCursor: 'next-50' } };
  render(cases({ recordsRequest: vi.fn(async () => paged) } as unknown as PackProofApi, { onGo }));
  expect(await screen.findByText('50 shown of 601 permitted comparisons')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next comparisons page' }));
  expect(onGo).toHaveBeenCalledWith('/app/cases/case-a?organizationId=org-a&environment=live&locationId=site-a&cursor=next-50');
});

it('uses server-ordered timeline pages and leaves a missing event time unknown', async () => {
  const timelineParams = new URLSearchParams(params); timelineParams.set('section', 'timeline');
  const onGo = vi.fn(), request = vi.fn(async () => ({ ...detail, pagination: { ...detail.pagination, section: 'timeline' } }));
  render(cases({ recordsRequest: request } as unknown as PackProofApi, { params: timelineParams, onGo }));
  expect(await screen.findByRole('heading', { name: 'Operational timeline' })).toBeVisible();
  expect(screen.getByText('Late arrival')).toBeVisible();
  expect(screen.getByText('Reported event time').nextElementSibling).toHaveTextContent('Not reported');
  await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Timeline order' }), 'received');
  expect(onGo).toHaveBeenCalledWith('/app/cases/case-a?organizationId=org-a&environment=live&locationId=site-a&section=timeline&timelineOrder=received');
  expect(request).toHaveBeenCalledWith('/cases/case-a?organizationId=org-a&environment=live&locationId=site-a&section=timeline&limit=50');
});

it('does not fetch or advertise case access when reconstruction capability is disabled', async () => {
  const request = vi.fn(async () => detail);
  render(cases({ recordsRequest: request } as unknown as PackProofApi, { enabled: false }));
  expect(screen.getByRole('heading', { name: 'Operational cases are not enabled' })).toBeVisible();
  expect(request).not.toHaveBeenCalled();
});

it('drops a previous case response immediately on scope change and ignores late results', async () => {
  let finish: (value: unknown) => void = () => undefined;
  const pending = new Promise(resolve => { finish = resolve; });
  const request = vi.fn(async (path: string) => path.includes('org-a') ? pending : { ...detail, case: { ...detail.case, id: 'case-b', reference: 'B-77' } });
  const api = { recordsRequest: request } as unknown as PackProofApi;
  const { rerender } = render(cases(api));
  await waitFor(() => expect(request).toHaveBeenCalled());
  rerender(cases(api, { organization: { ...organization, id: 'org-b' }, params: new URLSearchParams({ organizationId: 'org-b', environment: 'live' }), id: 'case-b' }));
  expect(await screen.findByRole('heading', { name: 'Order B-77' })).toBeVisible();
  finish(detail);
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Order 0010482' })).not.toBeInTheDocument());
});

it('shows an authorized empty list separately from a failed request and preserves leading-zero references', async () => {
  const onGo = vi.fn(), query = new URLSearchParams(params); query.set('q', '0010482');
  render(cases({ recordsRequest: vi.fn(async () => ({ resourceType: 'operational_case', cases: [detail.case], total: 1, nextCursor: 'page-two', hasMore: true })) } as unknown as PackProofApi, { id: null, params: query, onGo }));
  expect(await screen.findByRole('link', { name: 'Order 0010482' })).toHaveAttribute('href', '/app/cases/case-a?organizationId=org-a&environment=live&locationId=site-a&q=0010482');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Next case page' }));
  expect(onGo).toHaveBeenCalledWith('/app/cases?organizationId=org-a&environment=live&locationId=site-a&q=0010482&cursor=page-two');
});

it('retains exact case route filters and only shows case navigation after capability discovery', async () => {
  expect(recordsRoute('/app/cases/case-a?organizationId=org-a').section).toBe('cases');
  expect(recordsRoute('/app/cases/case-a').id).toBe('case-a');
  expect(recordsPath('cases', params, {}, 'case-a')).toBe('/app/cases/case-a?organizationId=org-a&environment=live&locationId=site-a');
  expect(canonicalWorkspacePath('/app/cases/case-a?organizationId=org-a&q=0010482#ignored')).toBe('/app/cases/case-a?organizationId=org-a&q=0010482');
  const session = { userId: 'operator', token: 'test', apiBaseUrl: 'https://api.example', authMode: 'cognito', subject: 'subject', username: 'operator', refreshToken: null, accessExpiresAt: null } as WebSession;
  const context = { schema: 'packproof.records/v1', organizations: [organization], selectedOrganizationId: 'org-a', environment: 'live', capabilities: { records: true, import: true, manage: true, review: true, reconstruction: true } };
  const request = vi.fn(async (path: string) => path.startsWith('/context') ? context : { cases: [], total: 0, nextCursor: null });
  render(<RecordsPortal api={{ recordsRequest: request } as unknown as PackProofApi} session={session} href="/app/cases?organizationId=org-a&environment=live" onGo={vi.fn()} onSignOut={vi.fn()}/>);
  expect(await screen.findByRole('link', { name: 'Operational cases' })).toHaveAttribute('aria-current', 'page');
  expect(await screen.findByRole('heading', { name: 'No operational cases yet' })).toBeVisible();
});

it('marks retained source assertions when the original is no longer available', async () => {
  const request = vi.fn(async (path: string) => path.includes('/assertions/') ? { ...extract, originalAvailable: false } : detail);
  render(cases({ recordsRequest: request } as unknown as PackProofApi));
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Open reported loaded source' }));
  expect(await screen.findByText(/original file is unavailable under the current retention policy/)).toBeVisible();
  expect(screen.getByText('Source value').nextElementSibling).toHaveTextContent('8');
});
