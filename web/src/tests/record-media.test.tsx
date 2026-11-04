import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PackProofApi, RECORD_DOWNLOAD_LIMIT } from '../api/client';
import { RecordMedia, RecordPackageDownload } from '../records/RecordMedia';
import type { RecordDownloadOptions } from '../api/client';

const scope = { proofId: 'proof-a', organizationId: 'org-a', environment: 'live' };
const evidence = { id: 'image-a', name: 'Packing photo.jpg', contentType: 'image/jpeg' };
let createUrl: ReturnType<typeof vi.fn>, revokeUrl: ReturnType<typeof vi.fn>;
beforeEach(() => {
  createUrl = vi.fn(() => 'blob:authorized-original'); revokeUrl = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('requires an explicit click, scopes the original request, and revokes media on close', async () => {
  const original = vi.fn(async () => new Blob(['original'], { type: 'image/jpeg' }));
  render(<RecordMedia api={{ recordsOriginal: original } as unknown as PackProofApi} {...scope} evidence={evidence} canDownload/>);
  expect(original).not.toHaveBeenCalled(); expect(screen.queryByRole('img')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View Packing photo.jpg' }));
  expect(await screen.findByRole('img', { name: 'Packing photo.jpg' })).toHaveAttribute('src', 'blob:authorized-original');
  expect(original).toHaveBeenCalledWith('proof-a', 'image-a', 'org-a', 'live', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }));
  expect(revokeUrl).toHaveBeenCalledWith('blob:authorized-original'); expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('immediately removes the old viewer and revokes its URL when workspace changes', async () => {
  const api = { recordsOriginal: vi.fn(async () => new Blob(['photo'], { type: 'image/jpeg' })) } as unknown as PackProofApi;
  const { rerender } = render(<RecordMedia api={api} {...scope} evidence={evidence} canDownload/>);
  fireEvent.click(screen.getByRole('button', { name: 'View Packing photo.jpg' })); await screen.findByRole('img');
  rerender(<RecordMedia api={api} {...scope} organizationId="org-b" evidence={evidence} canDownload/>);
  expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(revokeUrl).toHaveBeenCalledWith('blob:authorized-original');
});

it('aborts a stale scoped request and never creates a URL for its late response', async () => {
  let finish: (blob: Blob) => void = () => undefined;
  let requestSignal: AbortSignal | undefined;
  const original = vi.fn((_proof: string, _id: string, _org: string, _env: string, options: RecordDownloadOptions) => {
    requestSignal = options.signal; return new Promise<Blob>(resolve => { finish = resolve; });
  });
  const api = { recordsOriginal: original } as unknown as PackProofApi;
  const { rerender } = render(<RecordMedia api={api} {...scope} evidence={evidence} canDownload/>);
  fireEvent.click(screen.getByRole('button', { name: 'View Packing photo.jpg' }));
  rerender(<RecordMedia api={api} {...scope} environment="sandbox" evidence={evidence} canDownload/>);
  expect(requestSignal?.aborted).toBe(true);
  finish(new Blob(['stale'], { type: 'image/jpeg' }));
  await waitFor(() => expect(createUrl).not.toHaveBeenCalled());
});

it('never embeds active documents or an unsafe MIME returned for a purported image', async () => {
  const original = vi.fn(async () => new Blob(['<script>bad()</script>'], { type: 'text/html' }));
  const api = { recordsOriginal: original } as unknown as PackProofApi;
  const { container, rerender } = render(<RecordMedia api={api} {...scope} evidence={{ id: 'document', name: 'invoice.html', contentType: 'text/html' }} canDownload/>);
  expect(screen.queryByRole('button', { name: /^View / })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download original' })).toBeEnabled();
  rerender(<RecordMedia api={api} {...scope} evidence={evidence} canDownload/>);
  fireEvent.click(screen.getByRole('button', { name: 'View Packing photo.jpg' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('download only');
  expect(container.querySelector('iframe, object, embed, img, video, audio')).toBeNull();
  expect(createUrl).not.toHaveBeenCalled();
});

it('shows authenticated download failure and allows a retry', async () => {
  const original = vi.fn(async () => { throw new Error('Original is no longer available.'); });
  render(<RecordMedia api={{ recordsOriginal: original } as unknown as PackProofApi} {...scope} evidence={evidence} canDownload/>);
  fireEvent.click(screen.getByRole('button', { name: 'Download original' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Original is no longer available.');
  expect(screen.getByRole('button', { name: 'Download original' })).toBeEnabled();
});

it('gates finalized package export on capability and states the frozen core limitation', async () => {
  const download = vi.fn(async () => new Blob(['package'], { type: 'application/zip' }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const api = { recordsPackage: download } as unknown as PackProofApi;
  const { rerender } = render(<RecordPackageDownload api={api} {...scope} canExport={false}/>);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  rerender(<RecordPackageDownload api={api} {...scope} canExport/>);
  expect(screen.getByText(/Later operational notes, relationships and evidence checks are not included/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Download finalized capture package' }));
  await waitFor(() => expect(createUrl).toHaveBeenCalledOnce());
  expect(download).toHaveBeenCalledWith('proof-a', 'org-a', 'live', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  rerender(<RecordPackageDownload api={api} {...scope} canExport={false}/>);
  expect(revokeUrl).toHaveBeenCalledWith('blob:authorized-original');
});

it('authenticates scoped binary gateway URLs and bounds Content-Length before reading', async () => {
  const body = { getReader: vi.fn() };
  const fetchMock = vi.fn(async () => ({ ok: true, headers: new Headers({ 'Content-Length': String(RECORD_DOWNLOAD_LIMIT + 1) }), body }));
  vi.stubGlobal('fetch', fetchMock);
  const api = new PackProofApi({ baseUrl: '', getToken: () => 'member-token' });
  await expect(api.recordsOriginal('proof/a', 'evidence/a', 'org/a', 'sandbox')).rejects.toThrow('220 MiB');
  expect(body.getReader).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledWith('/me/records/proof%2Fa/evidence/evidence%2Fa/blob?organizationId=org%2Fa&environment=sandbox', expect.objectContaining({ headers: { Authorization: 'Bearer member-token' }, referrerPolicy: 'no-referrer' }));
  await expect(new PackProofApi({ baseUrl: '', getToken: () => null }).recordsPackage('p', 'o', 'live')).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('cancels an oversized chunked body even without a Content-Length header', async () => {
  const cancel = vi.fn(async () => undefined), releaseLock = vi.fn();
  const reader = { read: vi.fn(async () => ({ done: false, value: { byteLength: RECORD_DOWNLOAD_LIMIT + 1 } })), cancel, releaseLock };
  const fetchMock = vi.fn(async () => ({ ok: true, headers: new Headers(), body: { getReader: () => reader } }));
  vi.stubGlobal('fetch', fetchMock);
  const api = new PackProofApi({ baseUrl: '', getToken: () => 'member-token' });
  await expect(api.recordsPackage('p', 'o', 'live')).rejects.toThrow('220 MiB');
  expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
});

it('returns the original response MIME and byte inventory with bounded progress', async () => {
  const bytes = new TextEncoder().encode('exact original');
  const reader = { read: vi.fn().mockResolvedValueOnce({ done: false, value: bytes }).mockResolvedValueOnce({ done: true }), releaseLock: vi.fn() };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length) }), body: { getReader: () => reader } })));
  const progress = vi.fn(), api = new PackProofApi({ baseUrl: '', getToken: () => 'member-token' });
  const original = await api.recordsOriginal('p', 'e', 'o', 'live', { onProgress: progress });
  expect(original.size).toBe(bytes.length); expect(original.type).toBe('image/jpeg');
  expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
  expect(reader.releaseLock).toHaveBeenCalledOnce();
});
