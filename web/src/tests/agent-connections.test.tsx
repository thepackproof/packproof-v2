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

it('retains exact browser approval locators without accepting arbitrary nested record paths', () => {
  expect(canonicalWorkspacePath('/app/records/connect/approve?enrollmentId=enroll-a&organizationId=org-a#secret')).toBe('/app/records/connect/approve?enrollmentId=enroll-a&organizationId=org-a');
  expect(canonicalWorkspacePath('/app/records/connect/remote-command?token=secret')).toBe('/proofs');
});
