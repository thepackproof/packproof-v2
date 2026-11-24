import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import { AgentApproval } from '../records/AgentConnections';

afterEach(cleanup);

const legacy = 'installationId=agent-a&organizationId=org-a&environment=sandbox';
const proposal = { sourceName: 'CSV export', sourceContract: {
  schema: 'packproof.scheduled-csv/v2', expectedHeaders: ['Order'],
  historyPolicy: { initialFileName: 'orders.csv', observedAt: '2020-01-01T00:00:00Z' },
} };
const installed = { id: 'agent-a', deviceName: 'Warehouse PC', version: '0.7.0', state: 'setup',
  locationId: null, configRevision: 0, pendingProposal: proposal, pendingProposalSha256: 'a'.repeat(64) };

function open(query: string, recordsRequest: (path: string, method?: string) => Promise<unknown>, canManage = true,
  locations: Array<{ id: string; name: string }> | null = [{ id: 'site-a', name: 'Warehouse A' }]) {
  render(<AgentApproval organizationId="org-a" environment="sandbox" params={new URLSearchParams(query)}
    canManage={canManage} api={{ recordsRequest } as unknown as PackProofApi} facilityLocations={locations ?? undefined}/>);
}

it('opens the installed client’s stale CSV link on facility recovery and keeps the file decision accessible separately', async () => {
  const request = vi.fn(async () => installed);
  open(legacy, request);
  await screen.findByRole('heading', { name: 'Reconnect this computer to a facility' });
  expect(screen.queryByRole('button', { name: 'Approve configuration' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Disconnect and continue' })).toBeDisabled();
  expect(screen.getByRole('list', { name: 'Available facilities' })).toHaveTextContent('Warehouse A');
  fireEvent.click(screen.getByRole('button', { name: /view the separate file/i }));
  expect(screen.getByRole('button', { name: 'Approve configuration' })).toBeDisabled();
  expect(screen.getByText(/review expired after 30 minutes/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Return to facility connection' }));
  expect(screen.getByRole('button', { name: 'Disconnect and continue' })).toBeDisabled();
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([[], null] as const)('keeps current service access when available destinations cannot be established (%s)', async locations => {
  const request = vi.fn(async () => installed);
  open(legacy, request, true, locations ? [...locations] : null);
  expect(await screen.findByRole('heading', { name: 'Make your facility available' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Renew your export file review' })).toBeVisible();
  expect(screen.getByText(/request a fresh file review from the source computer/i)).toBeVisible();
  expect(screen.getByText(/your current connection is still in place/i)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Disconnect and continue' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /view the separate file/i }));
  expect(screen.getByRole('button', { name: 'Approve configuration' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /revoke installation/i })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});

it('uses the existing scoped revoke only after consent and confirms service access has stopped after acknowledgement', async () => {
  let revoked = false;
  const request = vi.fn(async (_path: string, method?: string) => {
    if (method === 'POST') revoked = true;
    return revoked ? { ...installed, state: 'revoked', pendingProposal: null } : installed;
  });
  open(legacy, request);
  const button = await screen.findByRole('button', { name: 'Disconnect and continue' });
  fireEvent.click(screen.getByRole('checkbox', { name: /disconnect the current service access for warehouse pc/i }));
  fireEvent.click(button);
  await screen.findByRole('heading', { name: 'Service access revoked' });
  expect(screen.getByText(/preserve pending work on the source computer/i)).toBeVisible();
  expect(request).toHaveBeenCalledWith('/agent-installations/agent-a/actions?organizationId=org-a&environment=sandbox', 'POST',
    { organizationId: 'org-a', environment: 'sandbox', action: 'revoke' }, { 'Idempotency-Key': expect.any(String) });
});

it('leaves a current unmarked file review in place and routes a marked installation directly to its facility', async () => {
  const request = vi.fn(async () => ({ ...installed, pendingProposal: { ...proposal, sourceContract: {
    ...proposal.sourceContract, historyPolicy: { ...proposal.sourceContract.historyPolicy, observedAt: new Date().toISOString() },
  } } }));
  open(legacy, request);
  expect(await screen.findByRole('button', { name: 'Approve configuration' })).toBeVisible();
  cleanup();
  open(legacy + '&intent=facility', request);
  expect(await screen.findByRole('heading', { name: 'Reconnect this computer to a facility' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Approve configuration' })).not.toBeInTheDocument();
});

it('requires an authorized facility for new facility enrollment and never selects one automatically', async () => {
  const request = vi.fn(async () => ({ id: 'enroll-a', deviceName: 'Warehouse PC', version: '0.7.0', state: 'pending',
    expiresAt: new Date(Date.now() + 600000).toISOString(), comparisonCode: 'ABC-123',
    choices: { operators: [{ id: 'member-a', name: 'Operator', role: 'ADMIN' }], integrationAccounts: [{ id: 'source-a', name: 'File source' }], locations: [{ id: 'site-a', name: 'Warehouse A' }] } }));
  open('enrollmentId=enroll-a&intent=facility', request);
  const button = await screen.findByRole('button', { name: 'Approve facility connection' });
  expect(screen.getByLabelText('Approved location')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Code shown in the application'), { target: { value: 'ABC-123' } });
  fireEvent.change(screen.getByLabelText('Authorized source'), { target: { value: 'source-a' } });
  fireEvent.change(screen.getByLabelText('Responsible teammate'), { target: { value: 'member-a' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Approved location'), { target: { value: 'site-a' } });
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/agent-enrollments/enroll-a/decision?organizationId=org-a&environment=sandbox',
    'POST', expect.objectContaining({ decision: 'approve', comparisonCode: 'ABC-123', locationId: 'site-a' }), expect.any(Object)));
});

it.each([[legacy, false], ['installationId=agent-a&organizationId=other&environment=sandbox&intent=facility', true]] as const)(
  'preserves the authorization boundary for %s', async (query, authorized) => {
    const request = vi.fn(async () => installed);
    open(query, request, authorized);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Disconnect and continue' })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
