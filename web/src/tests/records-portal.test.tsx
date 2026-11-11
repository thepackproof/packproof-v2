import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackProofApi } from '../api/client';
import type { WebSession } from '../auth/session';
import type { RecordSummary } from '../records/types';
import RecordsPortal from '../records/RecordsPortal';
import { ImportWizard } from '../records/ImportWizard';
import { TeamSettings } from '../records/TeamSettings';
import { RequirementWaiverControl } from '../records/ReviewControls';
import { canonicalWorkspacePath } from '../proof-list-state';
const theme = vi.hoisted(() => ({ scheme: 'light' as const, setPreference: vi.fn() }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => theme }));
const session: WebSession = { userId: 'operator', token: 'test', apiBaseUrl: 'https://api.example', authMode: 'cognito', subject: 'subject', username: 'operator', displayName: 'Warehouse operator', refreshToken: null, accessExpiresAt: null };
const organizations = [{ id: 'org-a', name: 'Warehouse A', environment: 'live', enabled: true, role: 'OWNER', locations: [{ id: 'site-a', name: 'Site A' }] }, { id: 'org-b', name: 'Warehouse B', environment: 'sandbox', enabled: true, role: 'REVIEWER', locations: [] }];
const context = { schema: 'packproof.records/v1', organizations, selectedOrganizationId: 'org-a', environment: 'live', capabilities: { records: true, import: true, review: true, manage: true } };
const record = { id: 'proof-a', proofId: 'proof-a', organizationId: 'org-a', environment: 'live', reference: '000123', title: 'Warehouse fittings', trackingNumber: '0012345', carrier: 'Carrier', createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T11:00:00Z', revision: 2, lifecycle: 'open', sample: false, locationId: 'site-a', sourceName: 'Dispatch spreadsheet', coverage: { satisfied: 1, total: 2, waived: 0, missing: 1, notYetDue: 0 }, integrity: 'not_sealed', review: 'needs_attention', issueCount: 1 };
const list = { records: [record], nextCursor: null, counts: { total: 1, open: 1, needsAttention: 1, closed: 0, policyComplete: 0 }, updatedAt: '2026-11-04T11:00:00Z' };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, '', '/app/records'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function portal(api: PackProofApi, href = '/app/records?organizationId=org-a&environment=live') { return <RecordsPortal api={api} session={session} href={href} onGo={vi.fn()} onSignOut={vi.fn()}/>; }
it('opens the Connect approval locator and retains it while choosing the workspace', async () => {
  const enrollment = { id: 'enroll-a', comparisonCode: 'ABC-123', deviceName: 'Collection PC', version: '0.1.0', state: 'pending', expiresAt: '2026-11-06T14:00:00Z', choices: { integrationAccounts: [], operators: [], locations: [] } };
  const request = vi.fn(async (path: string) => path.startsWith('/context') ? context : path.startsWith('/agent-enrollments/enroll-a?') ? enrollment : Promise.reject(new Error(`Unexpected record request: ${path}`)));
  const onGo = vi.fn(), user = userEvent.setup();
  render(<RecordsPortal api={{ recordsRequest: request } as unknown as PackProofApi} session={session} href="/app/records/connect?enrollmentId=enroll-a" onGo={onGo} onSignOut={vi.fn()}/>);
  expect(await screen.findByRole('heading', { name: 'Review this collection computer' })).toBeVisible();
  expect(await screen.findByText('Collection PC')).toBeVisible();
  expect(screen.queryByLabelText('Location')).not.toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Organization workspace' }), 'org-b:sandbox');
  const destination = new URL(onGo.mock.calls[0][0], 'https://packproof.local');
  expect(destination.pathname).toBe('/app/records/connect/approve');
  expect(destination.searchParams.get('enrollmentId')).toBe('enroll-a');
  expect(destination.searchParams.get('organizationId')).toBe('org-b');
  expect(destination.searchParams.get('environment')).toBe('sandbox');
  expect(request.mock.calls.some(([path]) => path.startsWith('/connect?'))).toBe(false);
});
it('shows a failed scoped request as a failure, without claiming the account is empty', async () => {
  const request = vi.fn(async (path: string) => { if (path.startsWith('/context')) return context; throw new Error('Records service unavailable'); });
  render(portal({ recordsRequest: request } as unknown as PackProofApi));
  expect(await screen.findByRole('alert')).toHaveTextContent('Records service unavailable');
  expect(screen.queryByText('Ready for your first shipping record')).not.toBeInTheDocument();
  expect(request.mock.calls[1][0]).toContain('organizationId=org-a&environment=live');
});
it('keeps pending activation separate from sample exploration and does not load records', async () => {
  const request = vi.fn(async () => ({ ...context, organizations: [{ ...organizations[0], enabled: false }], capabilities: { records: false, import: false, review: false, manage: true } }));
  render(portal({ recordsRequest: request } as unknown as PackProofApi));
  expect(await screen.findByRole('heading', { name: 'Waiting for workspace activation' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Explore a labeled sample' })).toHaveAttribute('href', '/sample-proof');
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('link', { name: 'Developers' })).not.toBeInTheDocument();
});
it('removes the previous workspace immediately when scope changes and ignores its late response', async () => {
  let finishA: (value: unknown) => void = () => undefined;
  const pendingA = new Promise(resolve => { finishA = resolve; });
  const request = vi.fn(async (path: string) => path.startsWith('/context') ? context : path.includes('org-a') ? pendingA : { ...list, records: [{ ...record, id: 'proof-b', reference: 'B-77', organizationId: 'org-b', environment: 'sandbox' }] });
  const api = { recordsRequest: request } as unknown as PackProofApi;
  const { rerender } = render(portal(api));
  await waitFor(() => expect(request).toHaveBeenCalledWith('?organizationId=org-a&environment=live'));
  rerender(portal(api, '/app/records?organizationId=org-b&environment=sandbox'));
  expect(screen.queryByText('000123')).not.toBeInTheDocument();
  expect(await screen.findByText('B-77')).toBeVisible();
  finishA(list);
  await waitFor(() => expect(screen.queryByText('000123')).not.toBeInTheDocument());
  expect(screen.getByText('Sandbox — excluded from production totals')).toBeVisible();
});
it('keeps later issue pages reachable even when a page has no explicit issues', async () => {
  const request = vi.fn(async (path: string) => path.startsWith('/context') ? context : { issues: [], nextCursor: 'next-page' });
  const onGo = vi.fn(), user = userEvent.setup();
  render(<RecordsPortal api={{ recordsRequest: request } as unknown as PackProofApi} session={session} href="/app/needs-attention?organizationId=org-a&environment=live&locationId=site-a&cursor=current-page" onGo={onGo} onSignOut={vi.fn()}/>);
  expect(await screen.findByRole('heading', { name: 'No matching issues' })).toBeVisible();
  expect(request.mock.calls[1][0]).toContain('locationId=site-a&cursor=current-page');
  await user.click(screen.getByRole('button', { name: 'Next page' }));
  expect(onGo).toHaveBeenCalledWith('/app/needs-attention?organizationId=org-a&environment=live&locationId=site-a&cursor=next-page');
});
it('labels bounded evidence counts and applies the selected entity to requirement coverage', async () => {
  const detail = { record, timeline: [], evidence: [{ id: 'evidence-a', type: 'PHOTO', contentType: 'image/jpeg', state: 'available', subjectIds: ['package-a'] }], evidenceNextCursor: 'more-evidence', timelineNextCursor: null, requirements: [{ id: 'requirement-a', title: 'Packing photo', subjectId: 'package-a', status: 'missing' }, { id: 'requirement-b', title: 'Handoff receipt', subjectId: 'proof-a', status: 'satisfied' }], issues: [], relationships: [{ id: 'package-a', kind: 'package', externalReference: 'BOX-01' }], sourceHealth: { state: 'not_applicable' }, capabilities: {} };
  const request = vi.fn(async (path: string) => path.startsWith('/context') ? context : detail), user = userEvent.setup();
  render(portal({ recordsRequest: request } as unknown as PackProofApi, '/app/records/proof-a?organizationId=org-a&environment=live'));
  await user.click(await screen.findByRole('button', { name: 'Package - BOX-01' }));
  expect(screen.getByText('0 of 1 met')).toBeVisible();
  expect(screen.getByText('1 loaded')).toBeVisible();
  expect(screen.queryByText('1 of 2 met')).not.toBeInTheDocument();
});
it('retains the authoritative unresolved count when 500 newer resolved issues fill the detail response', async () => {
  const issues = Array.from({ length: 500 }, (_, index) => ({ id: `resolved-${index}`, state: 'resolved', title: `Resolved issue ${index}` }));
  const detail = { record: { ...record, issueCount: 1 }, timeline: [], evidence: [], requirements: [], issues, relationships: [], sourceHealth: { state: 'unknown' }, capabilities: {} };
  const request = vi.fn(async (path: string) => path.startsWith('/context') ? context : detail),user=userEvent.setup();
  render(portal({ recordsRequest: request } as unknown as PackProofApi, '/app/records/proof-a?organizationId=org-a&environment=live'));
  expect(await screen.findByText('1 issue(s) need review')).toBeVisible();
  expect(screen.queryByText('Resolved issue 0')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Review issues' }));
  expect(screen.getByText('Resolved issue 24')).toBeVisible();
  expect(screen.queryByText('Resolved issue 25')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next issue page' }));
  expect(screen.getByText('Resolved issue 25')).toBeVisible();
  expect(screen.queryByText('Resolved issue 0')).not.toBeInTheDocument();
});
it('explains an assembled source event with its original receipt, interpretation and separate record commit time', async () => {
  const sourceObservation = { receiptId: 'source-receipt-a', sourceEventId: '000099', sourceKind: 'Customer dispatch', sourceSchemaVersion: '2026.1', mappingVersion: 'dispatch/v1', ruleVersion: 'packproof.source-reference/v1', reference: { type: 'SHIPMENT', externalId: '000123' }, receivedAt: '2026-11-04T10:00:00Z', payloadSha256: 'a'.repeat(64) };
  const detail = { record, timeline: [{ id: 'event-a', type: 'SOURCE_UPDATE', source: 'organization:opaque', reportedAt: '2026-11-04T09:00:00Z', receivedAt: '2026-11-04T11:00:00Z', data: { sourceObservation } }], evidence: [], requirements: [], issues: [], relationships: [], sourceHealth: { state: 'unknown' }, capabilities: {} };
  const request = vi.fn(async (path: string) => path.startsWith('/context') ? context : detail), user = userEvent.setup();
  render(portal({ recordsRequest: request } as unknown as PackProofApi, '/app/records/proof-a?organizationId=org-a&environment=live'));
  await user.click(await screen.findByRole('button', { name: 'Timeline' }));
  expect(screen.getByText('Customer dispatch', { selector: 'p' })).toBeVisible();
  expect(screen.getByText(/Committed to record/)).toBeVisible();
  await user.click(screen.getByText('Source details'));
  expect(screen.getByText('Original source receipt received')).toBeVisible();
  expect(screen.getByText('source-receipt-a')).toBeVisible();
  expect(screen.getByText('dispatch/v1')).toBeVisible();
  expect(screen.getByText('packproof.source-reference/v1')).toBeVisible();
  expect(screen.getByText(/Organization-submitted source assertion/)).toHaveTextContent('outside the inventory of earlier signed snapshots');
});
it('preserves records filters and scope while retaining old owned capture and proof boundaries', () => {
  expect(canonicalWorkspacePath('/app/records/proof-a?organizationId=org-a&environment=live&q=000123#token')).toBe('/app/records/proof-a?organizationId=org-a&environment=live&q=000123');
  expect(canonicalWorkspacePath('/app/connections?organizationId=org-a')).toBe('/app/connections?organizationId=org-a');
  expect(canonicalWorkspacePath('/app/proofs/proof-a?token=secret')).toBe('/proofs/proof-a');
  expect(canonicalWorkspacePath('/app/capture/task-a?token=secret')).toBe('/app/capture/task-a');
  expect(canonicalWorkspacePath('/app/records/../../admin')).toBe('/admin');
});
it('requires deliberate acceptance of valid rows, preserves leading zeros and never stores uploaded source bytes', async () => {
  const csv = 'Shipment reference,Item description\n000123,Warehouse fittings\n,Missing reference\n';
  const preview = { id: 'import-a', previewVersion: 'digest', state: 'previewed', organizationId: 'org-a', environment: 'live', sourceName: 'Shipment spreadsheet', timeZone: 'UTC', mapping: { shipmentReference: 'Shipment reference', itemTitle: 'Item description' }, headers: ['Shipment reference', 'Item description'], delimiter: ',', encoding: 'UTF-8', receivedAt: '2026-11-04T12:00:00Z', original: { sha256: 'digest', byteSize: csv.length }, counts: { valid: 1, invalid: 1, duplicate: 0, ambiguous: 0, imported: 0, failed: 0 }, rows: [{ rowNumber: 2, status: 'valid', values: { 'Shipment reference': '000123' }, normalized: { shipmentReference: '000123' }, errors: [] }, { rowNumber: 3, status: 'invalid', values: {}, errors: ['Row 3 is missing a shipment reference.'] }], correctionsCsv: '', recordIds: [] };
  const request = vi.fn(async (path: string) => path === '/imports/preview' ? preview : { ...preview, state: 'partially_succeeded', counts: { ...preview.counts, valid: 0, imported: 1 }, recordIds: ['proof-a'] });
  const user = userEvent.setup();
  const { container } = render(<ImportWizard api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="live" storageScope="test" onViewRecords={vi.fn()} onOpenRecord={vi.fn()}/>);
  const file = new File([csv], 'dispatch.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(csv).buffer });
  await user.upload(container.querySelector<HTMLInputElement>('input[type=file]')!, file);
  await user.click(screen.getByRole('button', { name: 'Review file' }));
  expect(await screen.findByText('000123')).toBeVisible();
  const commit = screen.getByRole('button', { name: 'Import 1 valid rows' });
  expect(commit).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'Import valid rows and leave the highlighted rows unresolved.' }));
  await user.click(commit);
  expect(await screen.findByText('Import complete — some rows need attention')).toBeVisible();
  expect(request.mock.calls[0][0]).toBe('/imports/preview');
  const bodies = request.mock.calls as unknown as Array<[string, string, Record<string, unknown>]>;
  expect(bodies[0][2].csv).toBe(csv);
  expect(bodies[1][2]).toEqual({ previewVersion: 'digest', importValidRows: true });
  expect(localStorage.getItem('packproof.records.import.test.org-a.live')).not.toContain('Warehouse fittings');
});
it('requires a reviewed account selection before granting workspace access and refreshes permissions after revocation', async () => {
  const membership = { id: 'member-a', userId: 'operator', role: 'ADMIN', revokedAt: null, username: 'operator' };
  const request = vi.fn(async (_organizationId: string, path: string) => path === '/administration' ? { memberships: [membership] } : {});
  const searchUsers = vi.fn(async () => ({ users: [{ userId: 'reviewer', username: 'reviewer', displayName: 'Shipment reviewer' }] }));
  const changed = vi.fn(), user = userEvent.setup();
  render(<TeamSettings api={{ organizationRequest: request, searchUsers } as unknown as PackProofApi} organizationId="org-a" currentUserId="operator" onChanged={changed}/>);
  expect(await screen.findByText('Your account')).toBeVisible();
  await user.type(screen.getByRole('textbox', { name: 'Find a teammate' }), 'reviewer');
  await user.click(screen.getByRole('button', { name: 'Search accounts' }));
  expect(await screen.findByRole('button', { name: 'Shipment reviewer @reviewer' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Grant workspace access' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Shipment reviewer @reviewer' }));
  await user.click(screen.getByRole('button', { name: 'Grant workspace access' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  const calls = request.mock.calls as unknown as Array<[string, string, string, Record<string, unknown>, Record<string, string>]>;
  const grant = calls.find(value => value[1] === '/memberships')!;
  expect(grant.slice(0, 4)).toEqual(['org-a', '/memberships', 'POST', { userId: 'reviewer', role: 'REVIEWER' }]);
  expect(grant[4]['Idempotency-Key']).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Revoke access' }));
  expect(request.mock.calls.some(value => value[1].endsWith('/revoke'))).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Confirm revocation' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
});
it('binds a reasoned waiver to the displayed revision and reuses its command key after a network failure', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('The response was interrupted.')).mockResolvedValue({ id: 'waiver-a' }), updated = vi.fn(), user = userEvent.setup();
  render(<RequirementWaiverControl api={{ recordsRequest: request } as unknown as PackProofApi} record={record as RecordSummary} query="organizationId=org-a&environment=live" requirementId="requirement-a" onUpdated={updated}/>);
  await user.click(screen.getByText('Record an administrator waiver'));
  expect(screen.getByRole('button', { name: 'Record waiver' })).toBeDisabled();
  await user.type(screen.getByRole('textbox', { name: 'Waiver reason' }), 'Packing photo unavailable; handoff evidence reviewed.');
  await user.click(screen.getByRole('button', { name: 'Record waiver' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('response was interrupted');
  expect(updated).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Record waiver' }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(request.mock.calls[0][0]).toBe('/proof-a/requirements/requirement-a/waiver?organizationId=org-a&environment=live');
  expect(request.mock.calls[0][3]['If-Match']).toBe('"2"');
  expect(request.mock.calls[0][3]['Idempotency-Key']).toBe(request.mock.calls[1][3]['Idempotency-Key']);
});


it('shows Connect-specific workspace recovery without losing the approval locator when no organization exists', async () => {
  const request = vi.fn(async (path: string) => {
    if (path.startsWith('/context')) return { ...context, organizations: [], selectedOrganizationId: null };
    throw new Error('No authorized organization routes should run');
  });
  const href = '/app/records/connect/approve?enrollmentId=enroll-a';
  render(portal({ recordsRequest: request } as unknown as PackProofApi, href));
  expect(await screen.findByRole('heading', { name: 'Finish connecting this computer' })).toBeVisible();
  expect(screen.getByText(/no active business workspace/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Check workspace access again' })).toBeEnabled();
  expect(screen.getByRole('heading', { name: 'Set up your business' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Your workspace is not ready yet' })).not.toBeInTheDocument();
  expect(request.mock.calls.every(([path]) => path.startsWith('/context'))).toBe(true);
});

it('does not offer computer approval for a disabled records workspace', async () => {
  const request = vi.fn(async (path: string) => {
    if (path.startsWith('/context')) return { ...context, organizations: [{ ...organizations[0], enabled: false }], capabilities: { records: false, import: false, review: false, manage: true } };
    throw new Error('Enrollment API must not run before activation');
  });
  render(portal({ recordsRequest: request } as unknown as PackProofApi, '/app/records/connect/approve?enrollmentId=enroll-a&organizationId=org-a&environment=live'));
  expect(await screen.findByRole('heading', { name: 'This workspace cannot approve computers yet' })).toBeVisible();
  expect(screen.getByText(/The setup request has not been authorized/)).toBeVisible();
  expect(request.mock.calls.every(([path]) => path.startsWith('/context'))).toBe(true);
});
