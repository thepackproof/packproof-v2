import { useEffect, useRef, useState } from 'react';
import type { PackProofApi, RecordDownloadOptions } from '../api/client';
import { ApiError } from '../api/types';
import type { RecordEvidence } from './types';

const safeImages = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const safeVideos = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const safeAudio = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm']);
function mediaKind(type: string): 'image' | 'video' | 'audio' | null {
  const mime = type.split(';')[0].trim().toLowerCase();
  return safeImages.has(mime) ? 'image' : safeVideos.has(mime) ? 'video' : safeAudio.has(mime) ? 'audio' : null;
}
function failure(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'Your current access does not allow this download. Ask your workspace administrator to review access.';
  return error instanceof Error ? error.message : 'The download could not be completed. Try again.';
}
function progressText(progress: { bytes: number; total: number | null } | null): string {
  if (!progress) return 'Preparing download…';
  const bytes = (progress.bytes / (1024 * 1024)).toFixed(1);
  return progress.total ? `Downloading ${bytes} of ${(progress.total / (1024 * 1024)).toFixed(1)} MiB…` : `Downloading ${bytes} MiB…`;
}
function safeName(name: string): string { return name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 180) || 'evidence.bin'; }

interface ScopeProps { api: PackProofApi; proofId: string; organizationId: string; environment: string }

/** Every click reauthorizes through the organization gateway; scope changes cancel reads. */
function useDownload(scope: string) {
  const [state, setState] = useState<{ scope: string; busy: boolean; error: string; progress: { bytes: number; total: number | null } | null }>({ scope, busy: false, error: '', progress: null });
  const controller = useRef<AbortController | null>(null);
  const urls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    controller.current?.abort();
    controller.current = null;
    for (const [url, timer] of urls.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
    urls.current.clear();
  }, [scope]);
  async function run(load: (options: RecordDownloadOptions) => Promise<Blob>, complete: (blob: Blob) => void) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ scope, busy: true, error: '', progress: null });
    try {
      const blob = await load({ signal: current.signal, onProgress: (bytes, total) => {
        if (!current.signal.aborted) setState({ scope, busy: true, error: '', progress: { bytes, total } });
      } });
      if (!current.signal.aborted) { complete(blob); setState({ scope, busy: false, error: '', progress: null }); }
    } catch (error) {
      if (!current.signal.aborted) setState({ scope, busy: false, error: failure(error), progress: null });
    }
  }
  function save(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = safeName(filename); link.rel = 'noopener';
    document.body.appendChild(link); link.click(); link.remove();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
    urls.current.set(url, timer);
  }
  function cancel() { controller.current?.abort(); setState({ scope, busy: false, error: '', progress: null }); }
  return { ...(state.scope === scope ? state : { busy: false, error: '', progress: null }), run, save, cancel };
}

export function RecordMedia({ api, proofId, organizationId, environment, evidence, canDownload }: ScopeProps & { evidence: RecordEvidence; canDownload: boolean }) {
  const evidenceId = evidence.id || evidence.evidenceId || '';
  const scope = JSON.stringify([proofId, organizationId, environment, evidenceId, canDownload]);
  const download = useDownload(scope);
  const [viewer, setViewer] = useState<{ scope: string; url: string; kind: 'image' | 'video' | 'audio' } | null>(null);
  const activeUrl = useRef<string | null>(null);
  function close() {
    download.cancel();
    if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
    activeUrl.current = null; setViewer(null);
  }
  useEffect(() => () => {
    if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
    activeUrl.current = null;
  }, [scope]);
  const name = evidence.name || evidence.filename || evidence.originalFileName || `Evidence ${evidenceId}`;
  const kind = mediaKind(evidence.contentType || evidence.mimeType || '');
  const currentViewer = viewer?.scope === scope ? viewer : null;
  if (!canDownload || !evidenceId) return <p className="records-muted">Original download is unavailable with your current access.</p>;
  const load = (options: RecordDownloadOptions) => api.recordsOriginal(proofId, evidenceId, organizationId, environment, options);
  function preview() {
    void download.run(load, blob => {
      const actualKind = mediaKind(blob.type);
      if (!actualKind) throw new Error('This file is available as a download only.');
      if (activeUrl.current) URL.revokeObjectURL(activeUrl.current);
      const url = URL.createObjectURL(blob); activeUrl.current = url;
      setViewer({ scope, url, kind: actualKind });
    });
  }
  return <div>
    <div className="records-actions">
      {kind && !currentViewer && <button type="button" className="records-button" disabled={download.busy} onClick={preview} aria-label={`View ${name}`}>View {kind}</button>}
      <button type="button" className="records-button" disabled={download.busy} onClick={() => { void download.run(load, blob => download.save(blob, mediaKind(blob.type) ? name : `${safeName(name)}.bin`)); }}>Download original</button>
      {(currentViewer || download.busy) && <button type="button" className="records-text-button" onClick={close}>{download.busy ? 'Cancel download' : 'Close viewer'}</button>}
    </div>
    {download.busy && <p role="status" className="records-muted">{progressText(download.progress)} Files are limited to 220 MiB in this browser.</p>}
    {download.error && <p role="alert" className="records-error-text">{download.error}</p>}
    {currentViewer && <div aria-label={`Original media: ${name}`} style={{ marginTop: 12 }}>
      {currentViewer.kind === 'image' ? <img src={currentViewer.url} alt={name} style={{ width: '100%', maxHeight: '65vh', objectFit: 'contain' }}/> : currentViewer.kind === 'video' ? <video src={currentViewer.url} controls playsInline preload="metadata" aria-label={name} style={{ width: '100%', maxHeight: '65vh' }}/> : <audio src={currentViewer.url} controls preload="metadata" aria-label={name} style={{ width: '100%' }}/>}
      <p className="records-muted">Preserved media documents what was captured. It does not establish physical condition independently.</p>
    </div>}
    {!kind && <p className="records-muted">This file type is download only.</p>}
  </div>;
}

export function RecordPackageDownload({ api, proofId, organizationId, environment, canExport }: ScopeProps & { canExport: boolean }) {
  const scope = JSON.stringify([proofId, organizationId, environment, canExport]);
  const download = useDownload(scope);
  if (!canExport) return null;
  return <div>
    <button type="button" className="records-button" disabled={download.busy} onClick={() => { void download.run(options => api.recordsPackage(proofId, organizationId, environment, options), blob => download.save(blob, `packproof-${proofId}-capture.zip`)); }}>Download finalized capture package</button>
    {download.busy && <><p role="status" className="records-muted">{progressText(download.progress)} Maximum package size: 220 MiB.</p><button type="button" className="records-text-button" onClick={download.cancel}>Cancel download</button></>}
    {download.error && <p role="alert" className="records-error-text">{download.error}</p>}
    <p className="records-muted">Includes the frozen capture inventory and its verification files. Later operational notes, relationships and evidence checks are not included. This package does not establish physical condition independently.</p>
  </div>;
}
