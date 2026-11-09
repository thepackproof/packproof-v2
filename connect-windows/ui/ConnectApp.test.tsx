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
  expect(screen.getByRole('button', { name: /Get started/ })).toBeDisabled();
});
it('requires mapping confirmation and explicit whole-original upload consent', async () => {
  const previewCloud = vi.fn(async () => initial), bridge = { getStatus: vi.fn(async () => initial), previewCloud } as unknown as ConnectBridge;
  render(<ConnectApp bridge={bridge}/>);
  await screen.findByRole('heading', { name: 'Get ready' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled());
  const upload = screen.getByRole('button', { name: /Continue to secure preview/ });
  expect(upload).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /shipment number, quantities, dates/ }));
  expect(upload).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /including columns that are not mapped/ }));
  expect(upload).toBeEnabled();
  expect(screen.getByText('000123')).toBeVisible();
  expect(screen.getByText('=SUM(1)')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Time zone used in shipment reports'), { target: { value: 'America/New_York' } });
  expect(upload).toBeDisabled();
  expect(previewCloud).not.toHaveBeenCalled();
});
it('a queued response never unlocks automatic collection', async () => {
  const current: ConnectStatus = { ...initial, preview: { id: 'import-a', previewVersion: 'v', state: 'queued', original: { sha256: 'digest', byteSize: 40 }, counts: { valid: 1, invalid: 0 }, rows: [], recordIds: [] } };
  render(<ConnectApp bridge={{ getStatus: vi.fn(async () => current) } as unknown as ConnectBridge}/>);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Start collecting' })).toBeVisible());
  expect(screen.getByRole('button', { name: /Continue to automatic collection/ })).toBeDisabled();
  expect(screen.getByText(/waiting for confirmation/)).toBeVisible();
});

it('requires the named exporter, cadence and timestamp cutoff before requesting a new source approval',async()=>{
  const current:ConnectStatus={...initial,config:undefined,configRevision:0,binding:{sourceName:config.sourceName,integrationAccountId:config.integrationAccountId,operatorMembershipId:config.operatorMembershipId,locationId:null},source:{...initial.source!,headers:['Shipment reference','Description','Quantity','Shipment date']}};
  const proposeConfiguration=vi.fn(async()=>current);render(<ConnectApp bridge={{getStatus:vi.fn(async()=>current),proposeConfiguration} as unknown as ConnectBridge}/>);
  await screen.findByRole('heading',{name:'Get ready'});await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh status'})).toBeEnabled());
  fireEvent.click(screen.getByRole('checkbox',{name:/shipment number, quantities, dates/}));const approve=screen.getByRole('button',{name:'Request configuration approval'});expect(approve).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Name of your shipping software'),{target:{value:'Synthetic exporter'}});fireEvent.change(screen.getByLabelText('Shipping software version'),{target:{value:'fixture-1'}});fireEvent.change(screen.getByLabelText('Start collecting shipments from'),{target:{value:'2026-11-01T00:00:00Z'}});fireEvent.change(screen.getByLabelText('Time zone used in shipment reports'),{target:{value:'UTC'}});
  fireEvent.click(screen.getByRole('checkbox',{name:/shipment number, quantities, dates/}));expect(approve).toBeEnabled();fireEvent.click(approve);
  await waitFor(()=>expect(proposeConfiguration).toHaveBeenCalledWith(expect.objectContaining({sourceContract:{schema:'packproof.scheduled-csv/v1',exporterName:'Synthetic exporter',exporterVersion:'fixture-1',expectedHeaders:['Shipment reference','Description','Quantity','Shipment date'],expectedIntervalSeconds:900,backfillFrom:'2026-11-01T00:00:00Z'}})));
  expect(screen.getByRole('button',{name:/Continue to secure preview/})).toBeDisabled();
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
  expect(await screen.findByRole('heading', { name: 'Find records' })).toBeVisible();
});

it('presents three operator stages without exposing seven internal steps',async()=>{
  render(<ConnectApp bridge={{getStatus:vi.fn(async()=>({...initial,preview:undefined,source:undefined,config:undefined,installationId:undefined}))} as unknown as ConnectBridge}/>);
  await screen.findByRole('heading',{name:'Find records'});
  expect(screen.getByRole('navigation',{name:'Setup progress'})).toHaveTextContent('Find records');
  expect(screen.getByRole('navigation',{name:'Setup progress'})).toHaveTextContent('Get ready');
  expect(screen.getByRole('navigation',{name:'Setup progress'})).toHaveTextContent('Start collecting');
  expect(screen.getByRole('navigation',{name:'Setup progress'})).not.toHaveTextContent('Field mapping');
  expect(screen.getByRole('button',{name:/Get started/})).toBeEnabled();
});

it('explains how to find reports without granting filesystem access', async()=>{
  const chooseFolder=vi.fn();
  render(<ConnectApp bridge={{getStatus:vi.fn(async()=>({...initial,source:undefined,config:undefined})),chooseFolder} as unknown as ConnectBridge}/>);
  await screen.findByRole('heading',{name:'Find records'});
  // A configured enrollment without a chosen folder resumes at the folder screen.
  fireEvent.click(screen.getByRole('button',{name:/not sure where the files are/}));
  expect(screen.getByRole('textbox',{name:'Message for your IT team'})).toHaveAttribute('readonly');
  expect(chooseFolder).not.toHaveBeenCalled();
});

it('shows recovery guidance when the trusted helper cannot be reached',async()=>{
  const getStatus=vi.fn().mockRejectedValue(new Error("PackProof's background helper is stopped."));
  render(<ConnectApp bridge={{getStatus} as unknown as ConnectBridge}/>);
  expect(await screen.findByRole('heading',{name:'PackProof needs one quick fix.'})).toBeVisible();
  expect(screen.getByRole('button',{name:'Check again'})).toBeEnabled();
  expect(screen.getByText('Show repair steps')).toBeVisible();
});
