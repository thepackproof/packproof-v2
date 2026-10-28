import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import type { ProofSearchItem, ProofSearchResult } from '../../../packages/evidence-contracts/api-dashboard';
import { ClientProofDashboard } from '../screens/ClientProofDashboard';
import { dashboardCsv } from '../screens/dashboard-presentation';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function row(id: string, state: ProofSearchItem['readiness']['state'] = 'READY'): ProofSearchItem {
  return { proofId: id, transactionId: `tx-${id}`, status: state === 'READY' ? 'FINALIZED' : 'IN_PROGRESS', createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-28T12:00:00Z', finalizedAt: null,
    externalId: `ORDER-${id}`, itemTitle: 'Example order', itemCount: 2, trackingNumber: '001234', connectionId: null, provider: 'Example store', recordedBy: null, serverReceivedAt: null,
    readiness: { state, reason: state === 'AWAITING_CAPTURE' ? 'CAPTURE_REQUIRED' : state === 'NEEDS_ATTENTION' ? 'PRESERVATION_FAILED' : null, preserved: state === 'READY' } };
}
function source(rows: ProofSearchItem[], hasMore = false) {
  const page: ProofSearchResult = { apiVersion: 'v1', schema: 'packproof.proof-search/v1', proofs: rows, hasMore, nextCursor: hasMore ? 'cursor' : null, refreshedAt: '2026-10-28T12:00:00Z', cursorExpiresAt: '2026-10-28T13:00:00Z' };
  const searchProofs = vi.fn().mockResolvedValue(page);
  return { api: { searchProofs, listCommerceConnections: vi.fn().mockResolvedValue({ connections: [] }) } as unknown as PackProofApi, searchProofs };
}
it('shows scoped counts, prioritizes actionable loaded records and preserves intake and workspace shortcuts', async () => {
  const input = source([row('ready'), row('awaiting', 'AWAITING_CAPTURE'), row('attention', 'NEEDS_ATTENTION')], true);
  const onOpenProof = vi.fn(), onOpenOrders = vi.fn(), onOpenUploads = vi.fn(), onOpenActivity = vi.fn();
  render(<ClientProofDashboard api={input.api} accountKey="workspace-counts" onCreate={vi.fn()} onOpenProof={onOpenProof} onOpenOrders={onOpenOrders} onOpenUploads={onOpenUploads} onOpenActivity={onOpenActivity} readyOrders={<p>Eligible intake placeholder</p>} />);
  const overview = await screen.findByRole('region', { name: 'At a glance' });
  await screen.findByRole('button', { name: 'ORDER-ready' });
  expect(within(overview).getByText(/Counts describe loaded results, not account totals/)).toBeInTheDocument();
  expect(within(overview).getByRole('button', { name: /Needs attention 1/ })).toBeInTheDocument();
  const next = screen.getByRole('region', { name: 'Next up in this view' });
  expect(within(next).getAllByRole('listitem')[0]).toHaveTextContent('ORDER-attention');
  fireEvent.click(within(next).getByRole('button', { name: 'Review Proof ORDER-attention' }));
  expect(onOpenProof).toHaveBeenCalledWith('attention');
  expect(screen.getByText('Eligible intake placeholder')).toBeInTheDocument();
  const shortcuts = screen.getByRole('navigation', { name: 'Workspace shortcuts' });
  fireEvent.click(within(shortcuts).getByRole('button', { name: /Order queue/ }));
  fireEvent.click(within(shortcuts).getByRole('button', { name: /Saved recordings/ }));
  fireEvent.click(within(shortcuts).getByRole('button', { name: /Invitations/ }));
  expect(onOpenOrders).toHaveBeenCalledOnce(); expect(onOpenUploads).toHaveBeenCalledOnce(); expect(onOpenActivity).toHaveBeenCalledOnce();
});
it('differentiates first-use and filtered empty states, and status cards request a complete new server query', async () => {
  const input = source([]), onCreate = vi.fn();
  render(<ClientProofDashboard api={input.api} accountKey="workspace-empty" onCreate={onCreate} onOpenProof={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create your first Proof' })); expect(onCreate).toHaveBeenCalledOnce();
  fireEvent.click(within(screen.getByRole('region', { name: 'At a glance' })).getByRole('button', { name: /Awaiting capture/ }));
  expect(await screen.findByText('No matching shipments')).toBeInTheDocument();
  expect(input.searchProofs).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'AWAITING_CAPTURE', after: undefined, limit: 50 }));
  fireEvent.click(screen.getByRole('button', { name: 'Show all Proofs' }));
  await screen.findByText('Your first Proof starts here');
});
it('rejects an inverted date range before a server request and resets that guidance with filters', async () => {
  const input = source([]);
  render(<ClientProofDashboard api={input.api} accountKey="workspace-dates" initialFilters={{ from: '2026-10-01', through: '2026-10-10' }} onCreate={vi.fn()} onOpenProof={vi.fn()} />);
  await screen.findByText('No matching shipments'); const calls = input.searchProofs.mock.calls.length;
  fireEvent.change(screen.getByLabelText('Created from (UTC)'), { target: { value: '2026-10-20' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('start date on or before');
  expect(input.searchProofs).toHaveBeenCalledTimes(calls);
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});
it('exports only loaded summaries, neutralizes spreadsheet formulas, and escapes quotes/newlines', () => {
  const record = { ...row('one'), externalId: ' =HYPERLINK("https://example.invalid")', itemTitle: 'A "quoted", item\nsecond line', recordedBy: '\t+SUM(1,2)' };
  const csv = dashboardCsv([record]);
  expect(csv.startsWith('\uFEFF"Proof ID","Order reference"')).toBe(true);
  expect(csv).toContain('"\' =HYPERLINK(""https://example.invalid"")"');
  expect(csv).toContain('"A ""quoted"", item\nsecond line"');
  expect(csv).toContain('"\'\t+SUM(1,2)"');
  expect(csv).toContain('"001234"');
  expect(csv).not.toContain('manifestSha256');
});
it('downloads a CSV for exactly the loaded rows and keeps evidence-package export on the Proof detail', async () => {
  const input = source([row('loaded')], true);
  const create = vi.fn().mockReturnValue('blob:loaded-results');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  render(<ClientProofDashboard api={input.api} accountKey="workspace-export" onCreate={vi.fn()} onOpenProof={vi.fn()} />);
  await screen.findByRole('button', { name: 'ORDER-loaded' });
  fireEvent.click(screen.getByRole('button', { name: 'Export loaded results' }));
  expect(create).toHaveBeenCalledWith(expect.any(Blob)); expect(click).toHaveBeenCalledOnce();
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('packproof-loaded-results.csv');
  expect(input.searchProofs).toHaveBeenCalledOnce();
});
