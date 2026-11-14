import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PackProofApi } from '../api/client';
import { canonicalWorkspacePath } from '../proof-list-state';
import { AgentApproval, AgentConnections } from '../records/AgentConnections';
afterEach(cleanup);
const enrollment = { id: 'enroll-a', comparisonCode: 'ABC-123', deviceName: 'Warehouse PC', version: '0.1.0', state: 'pending', expiresAt: '2026-11-06T14:00:00Z', choices: { integrationAccounts: [{ id: 'source-a', name: 'Dispatch export' }], operators: [{ id: 'member-a', name: 'Collin', role: 'OWNER' }], locations: [{ id: 'site-a', name: 'Main warehouse' }] } };
const installation = { id: 'agent-a', state: 'ready', deviceName: 'Warehouse PC', version: '0.1.0', configRevision: 4, configSha256: 'digest-a', config: { sourceName: 'Dispatch', mapping: { shipmentReference: 'Reference', itemTitle: 'Description', quantity: 'Quantity' }, timeZone: 'UTC' }, testImportId: 'import-a', verifiedImportId: null, health: { serviceOnline: true } };
it('keeps setup enrollment limited and requires the matching local comparison code and named choices', async () => {
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { state: 'approved' } : enrollment);
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ enrollmentId: 'enroll-a' })} canManage/>);
  const approve = await screen.findByRole('button', { name: 'Approve setup only' });
  expect(approve).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Code shown in the application'), { target: { value: 'ABC-123' } });
  fireEvent.change(screen.getByLabelText('Authorized source'), { target: { value: 'source-a' } });
  fireEvent.change(screen.getByLabelText('Responsible teammate'), { target: { value: 'member-a' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /compared the code/ }));
  fireEvent.click(approve);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/agent-enrollments/enroll-a/decision?organizationId=org-a&environment=sandbox', 'POST', expect.objectContaining({ decision: 'approve', comparisonCode: 'ABC-123', integrationAccountId: 'source-a', operatorMembershipId: 'member-a', locationId: null }), expect.objectContaining({ 'Idempotency-Key': expect.any(String) })));
});
it('pins recurring approval to the exact displayed configuration revision and digest', async () => {
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { ...installation, state: 'active' } : installation);
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ installationId: 'agent-a' })} canManage/>);
  const activate = await screen.findByRole('button', { name: 'Approve automatic collection' });
  expect(activate).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /authorize recurring collection/ }));
  fireEvent.click(activate);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/agent-installations/agent-a/actions?organizationId=org-a&environment=sandbox', 'POST', { organizationId: 'org-a', environment: 'sandbox', action: 'activate', configRevision: 4, configSha256: 'digest-a' }, expect.any(Object)));
});
it('requires an administrator and never calls enrollment APIs for reviewers', () => {
  const request = vi.fn();
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ installationId: 'agent-a' })} canManage={false}/>);
  expect(screen.getByRole('alert')).toHaveTextContent('owner or administrator');
  expect(request).not.toHaveBeenCalled();
});
it('shows online service and unknown source freshness independently', async () => {
  const request = vi.fn(async () => ({ installations: [installation] }));
  render(<AgentConnections api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" canManage/>);
  expect(await screen.findByText('Online')).toBeVisible();
  expect(screen.getByText('Unknown — no source watermark')).toBeVisible();
  expect(screen.getByText('Last completed import')).toBeVisible();
  expect(screen.queryByText('All systems up to date')).not.toBeInTheDocument();
});
it('distinguishes computer acknowledgments from accepted server receipts and source timestamps', async () => {
  const health = { serviceOnline: true, sourceFreshness: 'current', sourceWatermarkAt: '2026-11-07T12:00:00Z', lastReceiptReconciledAt: '2026-11-07T12:04:00Z', lastCompletedImportAt: '2026-11-07T12:03:00Z', expectedIntervalSeconds: 600, queueCount: 2, sourceAccounting: { receivedExports: 7, acceptedRows: 42, duplicateRows: 3, rejectedRows: 1, pendingRows: 2, linkedProofs: 40 } };
  const request = vi.fn(async () => ({ installations: [{ ...installation, health }] }));
  render(<AgentConnections api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" canManage/>);
  expect(await screen.findByText('Within approved export cadence')).toBeVisible();
  expect(screen.getByText('Last receipt reconciled').closest('div')).toHaveTextContent('Computer acknowledgment');
  expect(screen.getByText('Last completed import').closest('div')).toHaveTextContent('PackProof server');
  expect(screen.getByText('Source-reported watermark').closest('div')).toHaveTextContent('From accepted server receipts');
  expect(screen.getByText('Queued on this computer').closest('div')).toHaveTextContent('2');
  fireEvent.click(screen.getByText('Source receipt reconciliation'));
  expect(screen.getByText('Received exports').closest('div')).toHaveTextContent('7');
  expect(screen.getByText('Accepted rows').closest('div')).toHaveTextContent('42');
  expect(screen.getByText(/Counts describe server receipts/)).toHaveTextContent('current source configuration');
});
it('keeps an online service separate from an overdue source and gives a recovery instruction', async () => {
  const request = vi.fn(async () => ({ installations: [{ ...installation, health: { serviceOnline: true, sourceFreshness: 'delayed', expectedIntervalSeconds: 600, lastErrorCode: 'NETWORK_UNAVAILABLE' } }] }));
  render(<AgentConnections api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" canManage/>);
  expect(await screen.findByText('Online')).toBeVisible();
  expect(screen.getByText('Delayed — expected source update overdue')).toBeVisible();
  expect(screen.getByText(/Check the scheduled exporter/)).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('NETWORK_UNAVAILABLE');
  expect(screen.getByRole('alert')).toHaveTextContent('Check the network connection on this computer');
});
it('shows server repair instructions and bounded condition history without repeating a reported error', async () => {
  const history = [{ observedAt: '2026-11-07T10:00:00Z', configRevision: 4, codes: ['NETWORK_UNAVAILABLE'] }, { observedAt: '2026-11-07T11:00:00Z', configRevision: 4, codes: [] }];
  const request = vi.fn(async () => ({ installations: [{ ...installation, health: { serviceOnline: true, lastErrorCode: 'NETWORK_UNAVAILABLE', conditions: [{ code: 'NETWORK_UNAVAILABLE', repair: 'Review the network on this named computer and preserve the spool.' }], history } }] }));
  render(<AgentConnections api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" canManage/>);
  expect(await screen.findByText('Source conditions requiring attention')).toBeVisible();
  expect(screen.getByText(/Review the network on this named computer/)).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Recent health changes'));
  const entries = screen.getByText('Recent health changes').parentElement!.querySelectorAll('li');
  expect(entries).toHaveLength(2); expect(entries[0]).toHaveTextContent('No current conditions reported');
  expect(entries[1]).toHaveTextContent('Network unavailable');
});
it('shows the exact exporter, cadence, columns and backfill contract during configuration review', async () => {
  const sourceContract = { schema: 'packproof.scheduled-csv/v1', exporterName: 'Customer Dispatch', exporterVersion: '5.2', expectedHeaders: ['Reference', 'ShippedAt', 'Item'], expectedIntervalSeconds: 600, backfillFrom: '2026-11-01T00:00:00Z' };
  const request = vi.fn(async () => ({ ...installation, config: { ...installation.config, sourceContract } }));
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ installationId: 'agent-a' })} canManage/>);
  expect(await screen.findByText('Approved export contract')).toBeVisible();
  expect(screen.getByText('Customer Dispatch · 5.2')).toBeVisible();
  expect(screen.getByText('packproof.scheduled-csv/v1')).toBeVisible();
  expect(screen.getByText('Reference, ShippedAt, Item')).toBeVisible();
  expect(screen.getByText('Every 600 seconds')).toBeVisible();
  expect(screen.getByText(/Customer compatibility and source qualification require separate acceptance evidence/)).toBeVisible();
});

it('retains exact browser approval locators without accepting arbitrary nested record paths', () => {
  expect(canonicalWorkspacePath('/app/records/connect/approve?enrollmentId=enroll-a&organizationId=org-a#secret')).toBe('/app/records/connect/approve?enrollmentId=enroll-a&organizationId=org-a');
  expect(canonicalWorkspacePath('/app/records/connect/remote-command?token=secret')).toBe('/proofs');
});
it('invalidates whole-batch consent when the displayed original changes', async () => {
  const batch = (id: string) => ({ ...installation, testImportId:undefined, testCandidate: { id, state: 'previewed', counts: { valid: 1 }, original: { sha256: id, byteSize: 100 } } });
  const request = vi.fn(async (path: string) => batch(path.includes('import-b') ? 'import-b' : 'import-a'));
  const api = { recordsRequest: request } as unknown as PackProofApi;
  const renderApproval = (importId: string) => <AgentApproval api={api} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ installationId: 'agent-a', importId })} canManage/>;
  const { rerender } = render(renderApproval('import-a'));
  await screen.findByText('Original SHA-256: import-a');
  fireEvent.click(screen.getByRole('checkbox', { name: /approve this exact whole-batch/ }));
  expect(screen.getByRole('button', { name: 'Authorize this batch' })).toBeEnabled();
  rerender(renderApproval('import-b'));
  await screen.findByText('Original SHA-256: import-b');
  expect(screen.getByRole('checkbox', { name: /approve this exact whole-batch/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Authorize this batch' })).toBeDisabled();
});

it('enables separately approved source setup without a legacy CSV configuration or verification import', async () => {
  let current = { id: 'source-agent', deviceName: 'Source setup PC', version: '0.3.0', state: 'setup', configRevision: 1, configSha256: 'setup-digest', capabilities: { sourceSetupApproval: true, typedSourceSubscriptions: true }, health: { serviceOnline: true } };
  const request = vi.fn(async (_path: string, method?: string) => { if (method === 'POST') current = { ...current, state: 'ready', capabilities: { sourceSetupApproval: false, typedSourceSubscriptions: true } }; return current; });
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ installationId: 'source-agent' })} canManage/>);
  const enable = await screen.findByRole('button', { name: 'Enable source setup' });
  expect(enable).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Approve automatic collection' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve source setup on Source setup PC/ }));
  fireEvent.click(enable);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/agent-installations/source-agent/actions?organizationId=org-a&environment=sandbox', 'POST', { organizationId: 'org-a', environment: 'sandbox', action: 'approve_source_setup', configRevision: 1, configSha256: 'setup-digest' }, expect.objectContaining({ 'Idempotency-Key': expect.any(String) })));
  expect(await screen.findByText(/Source setup is enabled. Return to PackProof Connect/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Enable source setup' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve automatic collection' })).not.toBeInTheDocument();
});

it.each([{ state: 'setup', sourceSetupApproval: false }, { state: 'paused', sourceSetupApproval: true }, { state: 'ready', sourceSetupApproval: true }])('does not show source setup approval for $state with capability $sourceSetupApproval', async ({ state, sourceSetupApproval }) => {
  const request = vi.fn(async () => ({ id: 'source-agent', deviceName: 'Source setup PC', version: '0.3.0', state, configRevision: 1, configSha256: 'setup-digest', capabilities: { sourceSetupApproval } }));
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ installationId: 'source-agent' })} canManage/>);
  expect(await screen.findByRole('heading', { name: 'Source setup PC' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Enable source setup' })).not.toBeInTheDocument();
});

it('offers source setup approval from the current administrator computer card', async () => {
  const current = { id: 'source-agent', deviceName: 'Source setup PC', version: '0.3.0', state: 'setup', configRevision: 1, configSha256: 'setup-digest', capabilities: { sourceSetupApproval: true }, health: { serviceOnline: true } };
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { ...current, state: 'ready' } : { installations: [current] });
  render(<AgentConnections api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" canManage/>);
  const enable = await screen.findByRole('button', { name: 'Enable source setup' });
  expect(enable).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I approve source setup on Source setup PC/ }));
  fireEvent.click(enable);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/agent-installations/source-agent/actions?organizationId=org-a&environment=sandbox', 'POST', expect.objectContaining({ action: 'approve_source_setup', configRevision: 1, configSha256: 'setup-digest' }), expect.any(Object)));
});

it('explicitly creates the first local file connection during eligible enrollment with no existing source accounts', async () => {
  const eligible = { ...enrollment, version: '0.3.0', capabilities: { createLocalSource: true }, choices: { ...enrollment.choices, integrationAccounts: [] } };
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? { state: 'approved' } : eligible);
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ enrollmentId: 'enroll-a' })} canManage/>);
  const approve = await screen.findByRole('button', { name: 'Approve setup only' });
  expect(screen.queryByText(/A source account and responsible teammate must be prepared/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Code shown in the application'), { target: { value: 'ABC-123' } });
  fireEvent.change(screen.getByLabelText('Responsible teammate'), { target: { value: 'member-a' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /compared the code/ }));
  expect(approve).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Authorized source'), { target: { value: '__new_file_connection__' } });
  expect(screen.getByText(/This creates a file connection for approved export sources/)).toBeVisible();
  expect(approve).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /compared the code/ }));
  fireEvent.click(approve);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/agent-enrollments/enroll-a/decision?organizationId=org-a&environment=sandbox', 'POST', { organizationId: 'org-a', environment: 'sandbox', decision: 'approve', comparisonCode: 'ABC-123', integrationAccountId: null, createLocalSource: true, operatorMembershipId: 'member-a', locationId: null, sourceName: 'File exports from this computer' }, expect.objectContaining({ 'Idempotency-Key': expect.any(String) })));
});

it('keeps the original source choice contract when local connection creation is not advertised', async () => {
  render(<AgentApproval api={{ recordsRequest: vi.fn(async () => enrollment) } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" params={new URLSearchParams({ enrollmentId: 'enroll-a' })} canManage/>);
  await screen.findByRole('button', { name: 'Approve setup only' });
  expect(screen.queryByRole('option', { name: 'New file connection for this computer' })).not.toBeInTheDocument();
});
