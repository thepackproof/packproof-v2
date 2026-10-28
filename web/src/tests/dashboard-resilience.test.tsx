import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientProofDashboard } from '../screens/ClientProofDashboard';
import type { PackProofApi } from '../api/client';
import { ApiError } from '../api/types';
import type { ProofSearchItem, ProofSearchResult } from '../../../packages/evidence-contracts/api-dashboard';

// The tour has its own modal and persistence tests. Keep these tests focused on
// actual dashboard data lifetimes, cursor ownership and network recovery.
vi.mock('../screens/dashboard-tour', () => ({ DashboardTour: () => null }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function row(id: string): ProofSearchItem {
  return { proofId: id, transactionId: 'transaction-' + id, status: 'FINALIZED', createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-28T12:00:00Z', finalizedAt: '2026-10-28T12:00:00Z', externalId: 'ORDER-' + id, itemTitle: 'Synthetic shipment', itemCount: 1, trackingNumber: null, connectionId: null, provider: null, recordedBy: 'operator-' + id, serverReceivedAt: '2026-10-28T12:00:00Z', readiness: { state: 'READY', reason: null, preserved: true } };
}
function page(ids: string[], nextCursor: string | null = null): ProofSearchResult {
  return { apiVersion: 'v1', schema: 'packproof.proof-search/v1', proofs: ids.map(row), nextCursor, hasMore: nextCursor !== null, refreshedAt: '2026-10-28T12:00:00Z', cursorExpiresAt: '2026-10-28T13:00:00Z' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function source() {
  const searchProofs = vi.fn();
  const listCommerceConnections = vi.fn().mockResolvedValue({ connections: [] });
  const value = { searchProofs, listCommerceConnections } as unknown as PackProofApi;
  return { searchProofs, listCommerceConnections, value };
}
function dashboard(api: PackProofApi, accountKey = 'merchant-a') {
  return <ClientProofDashboard api={api} accountKey={accountKey} onOpenProof={vi.fn()} onCreate={vi.fn()} />;
}

describe('dashboard data resilience', () => {
  it('keeps previously loaded rows visible after a background failure and marks them unconfirmed', async () => {
    const api = source();
    api.searchProofs.mockResolvedValueOnce(page(['saved'])).mockRejectedValueOnce(new Error('Private upstream failure'));
    render(dashboard(api.value));
    await screen.findByRole('button', { name: 'ORDER-saved' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Proofs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Previously loaded results are shown below');
    expect(screen.getByRole('button', { name: 'ORDER-saved' })).toBeInTheDocument();
    expect(screen.getByText(/Current status unconfirmed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export loaded results' })).toBeDisabled();
    expect(screen.queryByText(/Private upstream/)).not.toBeInTheDocument();
  });

  it.each([401, 403])('clears previously loaded rows on a %s refresh denial', async status => {
    const api = source();
    api.searchProofs.mockResolvedValueOnce(page(['restricted'])).mockRejectedValueOnce(new ApiError('ACCESS_DENIED', 'private auth detail', status));
    render(dashboard(api.value));
    await screen.findByRole('button', { name: 'ORDER-restricted' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Proofs' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'ORDER-restricted' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export loaded results' })).toBeDisabled();
    expect(screen.queryByText(/private auth detail/)).not.toBeInTheDocument();
  });

  it('ignores a late cursor page after the user changes the search filters', async () => {
    const latePage = deferred<ProofSearchResult>(), api = source();
    api.searchProofs.mockResolvedValueOnce(page(['old'], 'cursor-old')).mockReturnValueOnce(latePage.promise).mockResolvedValueOnce(page(['matching']));
    render(dashboard(api.value));
    await screen.findByRole('button', { name: 'ORDER-old' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more Proofs' }));
    fireEvent.change(screen.getByLabelText('Order, tracking or Proof reference'), { target: { value: 'matching' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: 'ORDER-matching' });
    await act(async () => { latePage.resolve(page(['leaked-old-page'])); });
    expect(screen.queryByRole('button', { name: 'ORDER-old' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ORDER-leaked-old-page' })).not.toBeInTheDocument();
    expect(api.searchProofs).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: 'cursor-old' }));
    expect(api.searchProofs).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'matching', after: undefined }));
  });

  it('isolates late requests across account changes even when the API object is reused', async () => {
    const previousAccount = deferred<ProofSearchResult>(), api = source();
    api.searchProofs.mockReturnValueOnce(previousAccount.promise).mockResolvedValueOnce(page(['account-b']));
    const { rerender } = render(dashboard(api.value, 'account-a'));
    rerender(dashboard(api.value, 'account-b'));
    await screen.findByRole('button', { name: 'ORDER-account-b' });
    await act(async () => { previousAccount.resolve(page(['account-a'])); });
    expect(screen.queryByRole('button', { name: 'ORDER-account-a' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ORDER-account-b' })).toBeInTheDocument();
  });

  it('clears an expanded result set after a denied cursor page', async () => {
    const api = source();
    api.searchProofs.mockResolvedValueOnce(page(['restricted'], 'old-cursor')).mockRejectedValueOnce(new ApiError('FORBIDDEN', 'Access revoked', 403));
    render(dashboard(api.value));
    await screen.findByRole('button', { name: 'ORDER-restricted' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more Proofs' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more Proofs' })).not.toBeInTheDocument();
  });

  it('preserves expanded pages during visible polling until an explicit refresh starts a new first page', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const api = source();
    api.searchProofs.mockResolvedValueOnce(page(['first'], 'cursor-next')).mockResolvedValueOnce(page(['second'])).mockResolvedValueOnce(page(['fresh']));
    await act(async () => { render(dashboard(api.value)); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load more Proofs' })); });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
    expect(api.searchProofs).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Updates may be available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ORDER-second' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh Proofs' })); });
    expect(screen.getByRole('button', { name: 'ORDER-fresh' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ORDER-second' })).not.toBeInTheDocument();
    expect(api.searchProofs).toHaveBeenCalledTimes(3);
  });

  it('honors the auto-refresh pause and waits while the document is hidden', async () => {
    vi.useFakeTimers();
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const api = source();
    api.searchProofs.mockResolvedValue(page(['loaded']));
    await act(async () => { render(dashboard(api.value)); });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-refresh' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.searchProofs).toHaveBeenCalledTimes(1);
    visible.mockReturnValue('hidden');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-refresh' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.searchProofs).toHaveBeenCalledTimes(1);
    visible.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(api.searchProofs).toHaveBeenCalledTimes(2);
  });

  it('retains visibly stale rows while offline, prevents cursor/export actions, and refreshes on reconnection', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const api = source();
    api.searchProofs.mockResolvedValueOnce(page(['loaded'], 'next')).mockResolvedValueOnce(page(['reconnected']));
    await act(async () => { render(dashboard(api.value)); });
    online.mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByRole('button', { name: 'ORDER-loaded' })).toBeInTheDocument();
    expect(screen.getByText('You are offline.')).toBeInTheDocument();
    expect(screen.getByText(/Current status unconfirmed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more Proofs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export loaded results' })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.searchProofs).toHaveBeenCalledTimes(1);
    online.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(screen.getByRole('button', { name: 'ORDER-reconnected' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ORDER-loaded' })).not.toBeInTheDocument();
    expect(api.searchProofs).toHaveBeenCalledTimes(2);
  });
});
