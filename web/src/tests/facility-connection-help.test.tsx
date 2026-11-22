import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PackProofApi } from '../api/client';
import { AgentApproval } from '../records/AgentConnections';

afterEach(cleanup);

function openInstallation(state: string, locationId: string | null | undefined, importId?: string) {
  const request = vi.fn(async (_path: string, _method?: string) => ({
    id: 'agent-a', deviceName: 'Test warehouse PC', version: '0.7.0', state,
    locationId, configRevision: 1,
    testCandidate: importId ? { id: importId, state: 'previewed', counts: {}, rows: [] } : undefined,
  }));
  const params = new URLSearchParams({ installationId: 'agent-a' });
  if (importId) params.set('importId', importId);
  render(<AgentApproval api={{ recordsRequest: request } as unknown as PackProofApi}
    organizationId="org-a" environment="sandbox" params={params} facilityLocations={[{ id: 'site-a', name: 'Warehouse A' }]} canManage />);
  return request;
}

it('opens the existing service-access review and leaves revocation for a separate explicit decision', async () => {
  const request = openInstallation('setup', null);
  const review = await screen.findByRole('button', { name: 'Review service access' });
  const summary = screen.getByText('Revoke this installation', { selector: 'summary' });
  expect(summary.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(review);
  expect(summary.closest('details')).toHaveAttribute('open');
  expect(summary).toHaveFocus();
  expect(screen.getByRole('checkbox', { name: /revoke only this installation/i })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Revoke installation' })).toBeDisabled();
  expect(request.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
});

it('directs a revoked facility-less installation back to preservation and enrollment on Windows', async () => {
  openInstallation('revoked', null);
  const steps = await screen.findByRole('region', { name: 'Reconnect this computer to a facility' });
  expect(steps).toHaveTextContent('Preserve work and reconnect');
  expect(steps).toHaveTextContent('Approved location');
  expect(screen.queryByRole('button', { name: 'Review service access' })).not.toBeInTheDocument();
});

it.each([
  { state: 'setup', locationId: 'site-a' },
  { state: 'setup', locationId: undefined },
  { state: 'active', locationId: null },
  { state: 'setup', locationId: null, importId: 'import-a' },
])('preserves other installation reviews ($state, $locationId, $importId)', async ({ state, locationId, importId }) => {
  openInstallation(state, locationId, importId);
  await screen.findByText('Revoke this installation', { selector: 'summary' });
  expect(screen.queryByRole('heading', { name: 'This computer has no assigned facility' })).not.toBeInTheDocument();
});
