// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { bridgeFor, selected } from '../test-fixtures';
import type { ConnectStatus } from '../types';
import { WorkspaceApp } from '../WorkspaceApp';
import { Setup } from './Setup';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const digest = 'a'.repeat(64);
const fileName = 'Shipments.csv';
function status(expiresAt = new Date(Date.now() - 60000).toISOString()): ConnectStatus {
  return { ...selected, installationId: 'installation_test', workspace: { phase: 'draft', step: 'order', sources: [] }, setupAccess: {
    reason: 'facility_required', pendingFileReview: { proposalSha256: digest, fileName, expiresAt },
  } };
}
const actions = { onStatus: vi.fn(), onComplete: vi.fn(), onSample: vi.fn() };
function openSavedReport() {
  fireEvent.click(screen.getByText('Saved report'));
  expect(screen.getByText(fileName)).toBeVisible();
  expect(screen.getByText(/Choose this computer’s facility before starting a new source review/)).toBeVisible();
}
function expectFactsOnly(bridge: ReturnType<typeof bridgeFor>) {
  expect(screen.getByRole('heading', { name: 'Choose this computer’s facility.' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Choose a facility' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /file review|Review saved report separately|Recheck file and open review/i })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  for (const name of ['refreshPendingFileReview', 'beginEnrollment', 'recoverEnrollment', 'chooseFolder', 'analyzeLocal',
    'startSetup', 'previewLocal', 'proposeConfiguration', 'previewCloud', 'commitBatch', 'verifyImport', 'proposeActivation',
    'activate', 'chooseWorkspaceFolder', 'inspectWorkspaceSource', 'activateWorkspace', 'openApproval'] as const)
    expect(bridge[name], name).not.toHaveBeenCalled();
}

it.each([['expired', -60000], ['current', 60000]] as const)(
  'keeps a %s saved review as facts only even when cached status advertises interpretation support', async (_state, offset) => {
    const initial = status(new Date(Date.now() + offset).toISOString());
    initial.capabilities = { ...selected.capabilities!, interpretationVersions: ['packproof.shipment-interpretation/v1'] };
    const bridge = bridgeFor(initial, { refreshPendingFileReview: vi.fn() });
    render(<Setup status={initial} bridge={bridge} {...actions} />);
    expect(screen.getByText(fileName)).not.toBeVisible();
    openSavedReport();
    expect(screen.getByText(offset > 0 ? /Earlier review expires/ : /Earlier review expired/)).toBeVisible();
    expectFactsOnly(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a facility' }));
    await waitFor(() => expect(bridge.openWorkspaceApproval).toHaveBeenCalledExactlyOnceWith());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose a facility' })).toBeEnabled());
    expect(screen.getByText(/Finish the connection in your browser/)).toBeVisible();
    expectFactsOnly(bridge);
  },
);

it('updates retained facts through workspace refresh and restores the facility prerequisite after restart', async () => {
  let live = status();
  const bridge = bridgeFor(live, { getStatus: vi.fn(async () => live), getWorkspaceStatus: vi.fn(async () => live),
    refreshPendingFileReview: vi.fn() });
  const session = render(<WorkspaceApp bridge={bridge} />);
  await screen.findByRole('button', { name: 'Choose a facility' });
  openSavedReport();
  expect(screen.getByText(/Earlier review expired/)).toBeVisible();
  live = status(new Date(Date.now() + 30 * 60000).toISOString());
  live.setupAccess!.pendingFileReview!.proposalSha256 = 'b'.repeat(64);
  fireEvent.click(screen.getByRole('button', { name: 'Check connection again' }));
  expect(await screen.findByText(/Earlier review expires/)).toBeVisible();
  expect(bridge.getWorkspaceStatus).toHaveBeenCalled();
  expectFactsOnly(bridge);
  expect(bridge.openWorkspaceApproval).not.toHaveBeenCalled();
  session.unmount();
  render(<WorkspaceApp bridge={bridge} />);
  await screen.findByRole('button', { name: 'Choose a facility' });
  expect(screen.getByText(fileName)).not.toBeVisible();
  openSavedReport();
  expectFactsOnly(bridge);
});

it('lets a current review expire without enabling a report action or reading its file', () => {
  vi.useFakeTimers();
  const initial = status(new Date(Date.now() + 1000).toISOString());
  const bridge = bridgeFor(initial, { refreshPendingFileReview: vi.fn() });
  render(<Setup status={initial} bridge={bridge} {...actions} />);
  openSavedReport();
  expect(screen.getByText(/Earlier review expires/)).toBeVisible();
  act(() => { vi.advanceTimersByTime(1100); });
  expect(screen.getByText(/Earlier review expired/)).toBeVisible();
  expectFactsOnly(bridge);
  expect(bridge.openWorkspaceApproval).not.toHaveBeenCalled();
});

it('keeps the real facility action available after its browser handoff fails', async () => {
  const initial = status();
  const open = vi.fn().mockRejectedValueOnce(new Error('The facility sign-in window could not open.')).mockResolvedValue(undefined);
  const bridge = bridgeFor(initial, { refreshPendingFileReview: vi.fn(), openWorkspaceApproval: open });
  render(<Setup status={initial} bridge={bridge} {...actions} />);
  openSavedReport();
  fireEvent.click(screen.getByRole('button', { name: 'Choose a facility' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The facility sign-in window could not open.');
  expect(screen.getByRole('button', { name: 'Choose a facility' })).toBeEnabled();
  expectFactsOnly(bridge);
  fireEvent.click(screen.getByRole('button', { name: 'Choose a facility' }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expectFactsOnly(bridge);
});
