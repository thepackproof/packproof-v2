import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardConnections } from '../screens/DashboardConnections';
import type { CommerceConnectionView } from '../api/types';
import type { ConnectionHealthView } from '../api/connection-health';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const connection = (id: string): CommerceConnectionView => ({
  connectionId: id, adapterKey: 'shopify', provider: 'shopify', providerDisplay: 'Shopify',
  externalAccountReference: id, status: 'ACTIVE', lastSyncAt: null, lastErrorCode: null, retryable: null, readyOrderCount: 0,
});
const health = (id: string): ConnectionHealthView => ({
  schema: 'packproof.connection-health/v1', connectionId: id, provider: 'shopify', observedAt: '2026-10-28T12:00:00Z', status: 'ACTIVE',
  capabilities: { stableAccountId: id, automationAvailable: true, automationUnavailableReason: null, exactOrderReadSupported: true, incrementalListSupported: true, orderReadVerified: true, lastOrderReadAt: '2026-10-28T11:00:00Z', webhookSubscriptionsVerified: false, webhookDeliveryVerified: false, lastWebhookReceivedAt: null },
  automation: { optedIn: true, paused: false },
  sync: { runStatus: 'FAILED', sourceWatermarkAt: '2026-10-28T11:00:00Z', sourceAgeSeconds: 3600, stale: true, pageResumePending: true, expiredLease: false, pendingProviderEvents: 2, oldestPendingProviderEventAt: null },
  coverage: { basis: 'DISCOVERED_SOURCE_RECORDS', discovered: 8, eligible: 7, excluded: 1, eligibleWithoutProof: 1, awaitingCapture: 2, inProgress: 1, finalized: 3, otherEligible: 0, oldestAwaitingCaptureAt: null, reviewOrderCount: 1, reviewReasons: [{ code: 'PARTIAL_SHIPMENT_REVIEW_REQUIRED', count: 1 }] },
  nextAction: 'RETRY_SYNC',
});

describe('dashboard connection overview', () => {
  it('loads only an explicitly opened connection and reports coverage without claiming finalized means Ready', async () => {
    const getCommerceConnectionHealth = vi.fn().mockResolvedValue(health('store-a'));
    const onOpenConnections = vi.fn();
    render(<DashboardConnections api={{ getCommerceConnectionHealth }} connections={[connection('store-a'), connection('store-b')]} onOpenConnections={onOpenConnections} />);
    expect(getCommerceConnectionHealth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show connection health' }));
    expect(await screen.findByText('Discovered order coverage')).toBeInTheDocument();
    expect(getCommerceConnectionHealth).toHaveBeenCalledExactlyOnceWith('store-a');
    const coverage = screen.getByRole('heading', { name: 'Discovered order coverage' }).parentElement!;
    expect(within(coverage).getByText('8')).toBeInTheDocument();
    expect(within(coverage).getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/Finalized does not confirm preservation readiness/)).toBeInTheDocument();
    expect(screen.getByText(/Check is overdue/)).toBeInTheDocument();
    expect(screen.getByText(/1 excluded order needs shipment review/)).toBeInTheDocument();
    expect(screen.getByText(/Open Integrations to retry it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Integrations' }));
    expect(onOpenConnections).toHaveBeenCalledOnce();
  });

  it('discards a late prior selection and never fetches a newly selected connection until opened', async () => {
    let finishFirst!: (value: ConnectionHealthView) => void;
    const getCommerceConnectionHealth = vi.fn().mockImplementationOnce(() => new Promise<ConnectionHealthView>(resolve => { finishFirst = resolve; })).mockResolvedValue(health('store-b'));
    render(<DashboardConnections api={{ getCommerceConnectionHealth }} connections={[connection('store-a'), connection('store-b')]} onOpenConnections={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show connection health' }));
    fireEvent.change(screen.getByRole('combobox', { name: /Connection/ }), { target: { value: 'store-b' } });
    await act(async () => { finishFirst(health('store-a')); });
    expect(screen.queryByText('Discovered order coverage')).not.toBeInTheDocument();
    expect(getCommerceConnectionHealth).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show connection health' }));
    expect(await screen.findByText('Discovered order coverage')).toBeInTheDocument();
    expect(getCommerceConnectionHealth).toHaveBeenLastCalledWith('store-b');
  });

  it('offers a bounded retry, rejects a mismatched response, and removes a previous report during refresh', async () => {
    const getCommerceConnectionHealth = vi.fn().mockResolvedValueOnce(health('wrong-store')).mockResolvedValueOnce(health('store-a')).mockRejectedValueOnce(new Error('private provider error'));
    render(<DashboardConnections api={{ getCommerceConnectionHealth }} connections={[connection('store-a')]} onOpenConnections={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show connection health' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not check this connection');
    expect(screen.queryByText('Discovered order coverage')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry health check' }));
    expect(await screen.findByText('Discovered order coverage')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh health' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not check this connection');
    expect(screen.queryByText('Discovered order coverage')).not.toBeInTheDocument();
    expect(screen.queryByText(/private provider/)).not.toBeInTheDocument();
    expect(getCommerceConnectionHealth).toHaveBeenCalledTimes(3);
  });

  it('keeps list errors separate from empty accounts and directs fixes to the existing integrations screen', () => {
    const getCommerceConnectionHealth = vi.fn(), onRetry = vi.fn(), onOpenConnections = vi.fn();
    const { rerender } = render(<DashboardConnections api={{ getCommerceConnectionHealth }} connections={[]} error="private list error" onRetry={onRetry} onOpenConnections={onOpenConnections} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Your Proof search is still available');
    expect(screen.queryByRole('button', { name: 'Connect a store' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry connections' }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<DashboardConnections api={{ getCommerceConnectionHealth }} connections={[]} onOpenConnections={onOpenConnections} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect a store' }));
    expect(onOpenConnections).toHaveBeenCalledOnce();
    expect(getCommerceConnectionHealth).not.toHaveBeenCalled();
  });

  it('does not retain a previous API identity report when the signed-in API changes', async () => {
    const firstApi = { getCommerceConnectionHealth: vi.fn().mockResolvedValue(health('store-a')) };
    const secondApi = { getCommerceConnectionHealth: vi.fn().mockRejectedValue(new Error('Access denied')) };
    const { rerender } = render(<DashboardConnections api={firstApi} connections={[connection('store-a')]} onOpenConnections={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show connection health' }));
    expect(await screen.findByText('Discovered order coverage')).toBeInTheDocument();
    rerender(<DashboardConnections api={secondApi} connections={[connection('store-a')]} onOpenConnections={vi.fn()} />);
    expect(screen.queryByText('Discovered order coverage')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not check this connection'));
  });
});
