import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PackProofApi } from '../api/client';
import { CanonicalExports, CanonicalExportHistory } from '../records/CanonicalExports';

const scope = { proofId: 'proof-a', organizationId: 'org-a', environment: 'sandbox', storageScope: 'user-a.api', enabled: true };
const selection = { proofId: 'proof-a', kind: 'CORE', snapshotId: 'manifest-a', sha256: 'frozen-digest', scope: 'FROZEN_CORE_ONLY' };
const snapshots = { snapshots: [selection], operationalSnapshot: false, omissionPolicy: 'REQUIRE_COMPLETE_ORIGINALS', sharing: false };
function job(overrides: Record<string, unknown> = {}) {
  return { id: 'export-a', operationId: 'export-a', kind: 'canonical_package', proofId: 'proof-a', selection, selectionSha256: 'selection-digest', state: 'ready', receivedAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:01:00Z', expiresAt: new Date(Date.now() + 3600000).toISOString(), readyAt: '2026-11-04T10:01:00Z', downloadAvailable: true, artifact: { sha256: 'package-digest', byteSize: 1234, contentType: 'application/zip', versionBound: true }, lastErrorCode: null, ...overrides };
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('queues only the selected immutable snapshot with explicit download expiry and current workspace scope', async () => {
  const request = vi.fn(async (path: string, method = 'GET', _body?: unknown, _headers?: Record<string, string>) => method === 'POST' || path.startsWith('/canonical-exports/') ? job({ state: 'queued', artifact: null, downloadAvailable: false }) : snapshots);
  const user = userEvent.setup();
  render(<CanonicalExports {...scope} api={{ recordsRequest: request } as unknown as PackProofApi}/>);
  const submit = await screen.findByRole('button', { name: 'Queue complete-original package' });
  expect(submit).toBeDisabled();
  expect(screen.getByText(/requires every original in that snapshot/)).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Snapshot to export' }), 'CORE:manifest-a');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Stored download availability' }), '72');
  expect(screen.getByText(/Later operational notes, relationships, requirements and review actions are excluded/)).toBeVisible();
  await user.click(submit);
  await waitFor(() => expect(request.mock.calls.some(([, method]) => method === 'POST')).toBe(true));
  const [path, method, body, headers] = request.mock.calls.find(([, method]) => method === 'POST')!;
  expect(path).toBe('/proof-a/canonical-exports?organizationId=org-a&environment=sandbox');
  expect(method).toBe('POST');
  expect(body).toMatchObject({ kind: 'CORE', snapshotId: 'manifest-a' });
  expect(Object.keys(body as object).sort()).toEqual(['expiresAt', 'kind', 'snapshotId']);
  expect(Date.parse((body as { expiresAt: string }).expiresAt) - Date.now()).toBeGreaterThan(71 * 3600000);
  expect(headers?.['Idempotency-Key']).toBeTruthy();
  expect(headers).not.toHaveProperty('If-Match');
  expect(request.mock.calls[0][0]).toBe('/proof-a/canonical-snapshots?organizationId=org-a&environment=sandbox');
  expect(await screen.findByText('The job is queued. A durable request is separate from a ready package.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Download stored canonical package' })).not.toBeInTheDocument();
});

it('restores the exact selection, expiry and command key after a lost creation response and reload', async () => {
  let posts = 0;
  const request = vi.fn(async (path: string, method = 'GET', _body?: unknown, _headers?: Record<string, string>) => {
    if (method === 'POST') { if (++posts === 1) throw new Error('The export response was interrupted.'); return job({ state: 'queued', artifact: null, downloadAvailable: false }); }
    return path.startsWith('/canonical-exports/') ? job({ state: 'queued', artifact: null, downloadAvailable: false }) : snapshots;
  });
  const api = { recordsRequest: request } as unknown as PackProofApi, user = userEvent.setup();
  const first = render(<CanonicalExports {...scope} api={api}/>);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Snapshot to export' }), 'CORE:manifest-a');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Stored download availability' }), '168');
  await user.click(screen.getByRole('button', { name: 'Queue complete-original package' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('export response was interrupted');
  const original = request.mock.calls.find(([, method]) => method === 'POST')!;
  first.unmount();
  render(<CanonicalExports {...scope} api={api}/>);
  expect(await screen.findByRole('combobox', { name: 'Snapshot to export' })).toHaveValue('CORE:manifest-a');
  expect(screen.getByRole('combobox', { name: 'Stored download availability' })).toHaveValue('168');
  await user.click(screen.getByRole('button', { name: 'Queue complete-original package' }));
  await waitFor(() => expect(posts).toBe(2));
  const replay = request.mock.calls.filter(([, method]) => method === 'POST')[1];
  expect(replay[0]).toBe(original[0]);
  expect(replay[2]).toEqual(original[2]);
  expect(replay[3]?.['Idempotency-Key']).toBe(original[3]?.['Idempotency-Key']);
  expect(await screen.findByText('export-a')).toBeVisible();
});

it('keeps a fast double-click within one durable export command', async () => {
  const request = vi.fn(async (path: string, method = 'GET', _body?: unknown, _headers?: Record<string, string>) => method === 'POST' || path.startsWith('/canonical-exports/') ? job({ state: 'queued', artifact: null, downloadAvailable: false }) : snapshots), user = userEvent.setup();
  render(<CanonicalExports {...scope} api={{ recordsRequest: request } as unknown as PackProofApi}/>);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Snapshot to export' }), 'CORE:manifest-a');
  await user.dblClick(screen.getByRole('button', { name: 'Queue complete-original package' }));
  await waitFor(() => expect(screen.getByText('export-a')).toBeVisible());
  const commands = request.mock.calls.filter(([, method]) => method === 'POST');
  expect(commands.length).toBeGreaterThan(0);
  expect(new Set(commands.map(([, , , headers]) => headers?.['Idempotency-Key'])).size).toBe(1);
  expect(new Set(commands.map(([, , body]) => JSON.stringify(body))).size).toBe(1);
});

it.each([
  { label: 'ready with exact preserved bytes', overrides: {}, available: true },
  { label: 'still queued', overrides: { state: 'queued', downloadAvailable: false, artifact: null }, available: false },
  { label: 'action needed despite a stale availability flag', overrides: { state: 'action_needed', lastErrorCode: 'ORIGINAL_UNAVAILABLE' }, available: false },
  { label: 'expired server state', overrides: { state: 'expired' }, available: false },
  { label: 'elapsed download deadline', overrides: { expiresAt: '2000-01-01T00:00:00Z' }, available: false },
  { label: 'missing preserved artifact', overrides: { artifact: null }, available: false },
  { label: 'unconfirmed exact version', overrides: { artifact: { sha256: 'digest', byteSize: 123, contentType: 'application/zip', versionBound: false } }, available: false },
  { label: 'download unavailable', overrides: { downloadAvailable: false }, available: false },
])('offers downloads only for current eligible packages: $label', async ({ overrides, available }) => {
  const request = vi.fn(async () => ({ exports: [job(overrides)], limit: 100 }));
  render(<CanonicalExportHistory api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" enabled revision={0}/>);
  expect(await screen.findByText('export-a')).toBeVisible();
  const download = screen.queryByRole('button', { name: 'Download stored canonical package' });
  if (available) expect(download).toBeEnabled(); else expect(download).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledWith('/canonical-exports?organizationId=org-a&environment=sandbox');
});

it('reauthorizes an eligible package download in the selected workspace and hides stale download controls after refresh fails', async () => {
  let reads = 0;
  const request = vi.fn(async () => { if (++reads > 1) throw new Error('Workspace access could not be confirmed.'); return { exports: [job()], limit: 100 }; });
  const download = vi.fn(async (_id: string, _organizationId: string, _environment: string, _options?: unknown) => { throw new Error('Download interrupted.'); }), user = userEvent.setup();
  render(<CanonicalExportHistory api={{ recordsRequest: request, recordsCanonicalExport: download } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" enabled revision={0}/>);
  await user.click(await screen.findByRole('button', { name: 'Download stored canonical package' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Download interrupted');
  expect(download.mock.calls[0].slice(0, 3)).toEqual(['export-a', 'org-a', 'sandbox']);
  expect(download.mock.calls[0][3]).toMatchObject({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
  await user.click(screen.getByRole('button', { name: 'Refresh stored packages' }));
  expect(await screen.findByText('Workspace access could not be confirmed.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Download stored canonical package' })).not.toBeInTheDocument();
  expect(screen.queryByText('No canonical package jobs are recorded for your current workspace access.')).not.toBeInTheDocument();
});

it('does not request canonical export data or offer commands without owner or administrator access', () => {
  const request = vi.fn();
  render(<><CanonicalExports {...scope} enabled={false} api={{ recordsRequest: request } as unknown as PackProofApi}/><CanonicalExportHistory api={{ recordsRequest: request } as unknown as PackProofApi} organizationId="org-a" environment="sandbox" enabled={false} revision={0}/></>);
  expect(screen.getByText('A current workspace owner or administrator can request and download canonical packages.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Queue complete-original package' })).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});
