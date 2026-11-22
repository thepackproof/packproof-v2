// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { bridgeFor, selected } from '../test-fixtures';
import type { ConnectStatus } from '../types';
import { WorkspaceApp } from '../WorkspaceApp';
import { Setup } from './Setup';

afterEach(cleanup);

const digest = 'a'.repeat(64);
const replacement = 'b'.repeat(64);
const fileName = 'Shipments.csv';
function status(proposalSha256: string, expiresAt = new Date(Date.now() - 60000).toISOString()): ConnectStatus {
  return { ...selected, installationId: 'installation_test', workspace: { phase: 'draft', step: 'order', sources: [] }, setupAccess: {
    reason: 'facility_required', pendingFileReview: { proposalSha256, fileName, expiresAt },
  } };
}
const actions = { onStatus: vi.fn(), onComplete: vi.fn(), onSample: vi.fn() };

it('retains the browser-open receipt through the real post-command workspace poll only for the current verified replacement', async () => {
  const future = new Date(Date.now() + 30 * 60000).toISOString();
  let live = status(digest);
  const refresh = vi.fn(async () => {
    live = status(replacement, future);
    return {proposalSha256: replacement};
  });
  const bridge = bridgeFor(live, { getStatus: vi.fn(async () => live), getWorkspaceStatus: vi.fn(async () => live), refreshPendingFileReview: refresh });
  const screenSession = render(<WorkspaceApp bridge={bridge} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Request a fresh file review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Recheck file and open review' }));
  expect(await screen.findByRole('button', { name: 'Open current file review' })).toBeEnabled();
  expect(screen.getByRole('heading', { name: 'Continue in your browser.' })).toBeVisible();
  expect(bridge.getWorkspaceStatus).toHaveBeenCalled();
  live = status('c'.repeat(64), future);
  fireEvent.click(screen.getByRole('button', { name: 'Check connection again' }));
  expect(await screen.findByRole('heading', { name: 'Your export file review is ready.' })).toBeVisible();
  live = status(replacement, future);
  screenSession.unmount();
  render(<WorkspaceApp bridge={bridge} />);
  expect(await screen.findByRole('heading', { name: 'Your export file review is ready.' })).toBeVisible();
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('requires fresh confirmation for the named file and opens one review through the guarded bridge', async () => {
  let finish!: (receipt: {proposalSha256: string}) => void;
  const refresh = vi.fn(() => new Promise<{proposalSha256: string}>(resolve => { finish = resolve; }));
  const s = status(digest);
  const bridge = bridgeFor(s, { refreshPendingFileReview: refresh });
  const {rerender} = render(<Setup status={s} bridge={bridge} {...actions} />);
  expect(screen.getByText(/Your current connection stays in place/)).toBeVisible();
  expect(screen.queryByText(/revoke/i)).not.toBeInTheDocument();
  const request = screen.getByRole('button', { name: 'Request a fresh file review' });
  fireEvent.click(request);
  expect(screen.getByRole('dialog')).toHaveTextContent(fileName);
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(request);
  fireEvent.click(screen.getByRole('button', { name: 'Recheck file and open review' }));
  expect(refresh).toHaveBeenCalledExactlyOnceWith({ expectedProposalSha256: digest, wholeFileUploadApproved: true });
  expect(request).toBeDisabled();
  expect(bridge.openWorkspaceApproval).not.toHaveBeenCalled();
  await act(async () => { finish({proposalSha256: replacement}); });
  expect(screen.getByRole('heading', {name: 'Checking your updated review.'})).toBeVisible();
  rerender(<Setup status={status(replacement, new Date(Date.now() + 60000).toISOString())} bridge={bridge} {...actions} />);
  expect(screen.getByRole('heading', { name: 'Continue in your browser.' })).toBeVisible();
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('opens a current review in one click with no consent to renew it', async () => {
  const refresh = vi.fn(async () => ({proposalSha256: digest}));
  const s = status(digest, new Date(Date.now() + 60000).toISOString());
  const bridge = bridgeFor(s, { refreshPendingFileReview: refresh });
  render(<Setup status={s} bridge={bridge} {...actions} />);
  expect(screen.queryByRole('button', { name: 'Request a fresh file review' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open current file review' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledExactlyOnceWith({ expectedProposalSha256: digest, wholeFileUploadApproved: false }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('clears success and requires fresh confirmation when a previously opened review expires', async () => {
  vi.useFakeTimers();
  try {
    const refresh = vi.fn(async () => ({proposalSha256: digest}));
    const s = status(digest, new Date(Date.now() + 1000).toISOString());
    render(<Setup status={s} bridge={bridgeFor(s, { refreshPendingFileReview: refresh })} {...actions} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open current file review' })); });
    expect(screen.getByRole('heading', { name: 'Continue in your browser.' })).toBeVisible();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.getByRole('button', { name: 'Request a fresh file review' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Open current file review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Continue in your browser.' })).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledExactlyOnceWith({wholeFileUploadApproved: false, expectedProposalSha256: digest});
  } finally {
    vi.useRealTimers();
  }
});

it('discards an open confirmation when the pending proposal changes', () => {
  const refresh = vi.fn(async () => ({proposalSha256: replacement}));
  const s = status(digest);
  const bridge = bridgeFor(s, { refreshPendingFileReview: refresh });
  const { rerender } = render(<Setup status={s} bridge={bridge} {...actions} />);
  fireEvent.click(screen.getByRole('button', { name: 'Request a fresh file review' }));
  rerender(<Setup status={status('b'.repeat(64))} bridge={bridge} {...actions} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Request a fresh file review' })).toBeEnabled();
  expect(refresh).not.toHaveBeenCalled();
});

it('shows a failed renewal and requires another deliberate confirmation before retrying', async () => {
  const refresh = vi.fn(async () => { throw new Error('The saved report changed.'); });
  const s = status(digest);
  const bridge = bridgeFor(s, { refreshPendingFileReview: refresh });
  render(<Setup status={s} bridge={bridge} {...actions} />);
  fireEvent.click(screen.getByRole('button', { name: 'Request a fresh file review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Recheck file and open review' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The saved report changed.');
  expect(screen.queryByRole('button', { name: 'Open current file review' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Request a fresh file review' }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(bridge.openWorkspaceApproval).not.toHaveBeenCalled();
});
