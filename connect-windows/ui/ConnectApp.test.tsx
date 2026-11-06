// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConnectApp } from './ConnectApp';
import type { ConnectBridge, ConnectStatus } from './types';
afterEach(cleanup);
const config = { sourceName: 'Dispatch', folderDigest: 'f'.repeat(64), integrationAccountId: 'source-a', operatorMembershipId: 'member-a', locationId: null, timeZone: 'UTC', importValidRows: false, offlineWindowHours: 24, mapping: { shipmentReference: 'Reference', itemTitle: 'Description', quantity: 'Quantity' } };
const initial: ConnectStatus = { state: 'ready', environment: 'sandbox', installationId: 'install-a', config, configRevision: 1, source: { folder: 'approved folder', folderDigest: config.folderDigest, accessible: true, selectedFileName: 'shipment.csv', fileSha256: 'digest', headers: ['Reference', 'Description', 'Quantity'], samples: [{ Reference: '000123', Description: '=SUM(1)', Quantity: '1' }] }, health: { serviceOnline: true, queueCount: 0 } };
it('fails closed when the installed bridge is absent', async () => {
  render(<ConnectApp/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('secure connection');
  expect(screen.getByRole('button', { name: 'Connect a local export folder' })).toBeDisabled();
});
it('requires mapping confirmation and explicit whole-original upload consent', async () => {
  const previewCloud = vi.fn(async () => initial), bridge = { getStatus: vi.fn(async () => initial), previewCloud } as unknown as ConnectBridge;
  render(<ConnectApp bridge={bridge}/>);
  await screen.findByRole('heading', { name: 'Field mapping' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled());
  const upload = screen.getByRole('button', { name: 'Create secure preview' });
  expect(upload).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /confirmed the identifiers/ }));
  expect(upload).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /including columns that are not mapped/ }));
  expect(upload).toBeEnabled();
  expect(screen.getByText('000123')).toBeVisible();
  expect(screen.getByText('=SUM(1)')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Source time zone'), { target: { value: 'America/New_York' } });
  expect(upload).toBeDisabled();
  expect(previewCloud).not.toHaveBeenCalled();
});
it('a queued response never unlocks automatic collection', async () => {
  const current: ConnectStatus = { ...initial, preview: { id: 'import-a', previewVersion: 'v', state: 'queued', original: { sha256: 'digest', byteSize: 40 }, counts: { valid: 1, invalid: 0 }, rows: [], recordIds: [] } };
  render(<ConnectApp bridge={{ getStatus: vi.fn(async () => current) } as unknown as ConnectBridge}/>);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'First import' })).toBeVisible());
  expect(screen.getByRole('button', { name: 'Review automatic collection' })).toBeDisabled();
  expect(screen.getByText(/Verification is incomplete/)).toBeVisible();
});

it('requires informed preservation consent before expired-installation recovery', async () => {
  const recoverEnrollment = vi.fn(async () => ({ state: 'needs_approval', environment: 'sandbox', enrollment: { id: 'enroll-new', comparisonCode: 'ABCD-EFGH', expiresAt: '2026-11-07T10:00:00Z', state: 'pending' }, health: { serviceOnline: true, queueCount: 0, preservedQueueCount: 2 } }));
  const current: ConnectStatus = { ...initial, state: 'revoked', recoveryAvailable: true };
  render(<ConnectApp bridge={{ getStatus: vi.fn(async () => current), recoverEnrollment } as unknown as ConnectBridge}/>);
  await screen.findByRole('heading', { name: 'Recover this installation with new approval.' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled());
  const recover = screen.getByRole('button', { name: 'Begin approved recovery' });
  expect(recover).toBeDisabled();
  expect(recoverEnrollment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /old receipts will not transfer/ }));
  fireEvent.click(recover);
  await waitFor(() => expect(recoverEnrollment).toHaveBeenCalledWith({ preservePendingWorkApproved: true }));
  expect(await screen.findByRole('heading', { name: 'Workspace' })).toBeVisible();
});
