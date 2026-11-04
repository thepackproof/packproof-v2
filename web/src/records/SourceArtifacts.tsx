import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { randomId } from '../random-id';
import { RecordMedia } from './RecordMedia';
import { displayState } from './model';
import { useWorkflowData, workflowDate, workflowError, WorkflowStatus } from './workflow';

interface SourceArtifact { artifactId: string; filename: string; contentType: string; byteSize: number; sha256: string | null; state: string; receivedAt?: string; reportedAt?: string; acceptedAt?: string; subjectId?: string; sourceAssurance: string; downloadAvailable: boolean; errorCode?: string | null }
interface UploadSession { artifactId: string; sessionId: string; state: string; expiresAt: string; receivedParts: Array<number | { partNumber: number }>; partSize: number; resumable?: boolean; blockedReason?: string | null }
interface UploadReceipt { key: string; fingerprint: string; filename: string; byteSize: number; sha256: string; contentType: string; reportedAt: string; subjectId: string; session?: UploadSession; operationId?: string }
interface UploadOperation { operationId: string; state: string; errorCode?: string | null; message?: string; nextAction?: string; updatedAt?: string; result?: null | { artifactId: string; sha256: string; byteSize: number; contentType: string; acceptedAt: string } }
const MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf', 'audio/mpeg', 'audio/mp4', 'audio/wav'];
const LIMIT = 250_000_000, PART_SIZE = 5 * 1024 * 1024;
function fingerprintFile(file: File): Promise<string> { return file.arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')); }
function activeOperation(value: UploadOperation): boolean { return ['queued', 'pending', 'running', 'leased', 'retrying'].includes(value.state.toLowerCase()); }

export function SourceArtifacts({ api, proofId, organizationId, environment, entities, canUpload, revision, storageScope, onUpdated, selectedEntity = 'all' }: { api: PackProofApi; proofId: string; organizationId: string; environment: string; entities: Array<{ id: string; label: string }>; canUpload: boolean; revision: number; storageScope: string; onUpdated: () => void; selectedEntity?: string }) {
  const scope = new URLSearchParams({ organizationId, environment }).toString(), boundary = `${organizationId}.${environment}.${proofId}`;
  const storageKey = `packproof.records.source-upload.${storageScope}.${boundary}`;
  const [refresh, setRefresh] = useState(0), [cursor, setCursor] = useState<string | null>(null), list = useWorkflowData<{ artifacts: SourceArtifact[]; hasMore?: boolean; nextCursor?: string | null; total?: number; limit?: number }>(api, `/${encodeURIComponent(proofId)}/source-artifacts?${scope}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, revision + refresh);
  const [file, setFile] = useState<File | null>(null), [hash, setHash] = useState(''), [contentType, setContentType] = useState(''), [reportedAt, setReportedAt] = useState(''), [subjectId, setSubjectId] = useState(proofId);
  const [receipt, setReceipt] = useState<UploadReceipt | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [hashing, setHashing] = useState(false), [progress, setProgress] = useState(0);
  const fileGeneration = useRef(0), controller = useRef<AbortController | null>(null), pending = useRef(false), mounted = useRef(true), completed = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as UploadReceipt | null; if (saved && typeof saved.key === 'string' && typeof saved.sha256 === 'string') { setReceipt(saved); setContentType(saved.contentType); setReportedAt(saved.reportedAt); setSubjectId(saved.subjectId); } } catch { /* A new upload remains available without local storage. */ } return () => { mounted.current = false; fileGeneration.current++; controller.current?.abort(); }; }, [storageKey]);
  const operation = useWorkflowData<UploadOperation>(api, receipt?.operationId ? `/source-artifact-operations/${encodeURIComponent(receipt.operationId)}?${scope}` : null, refresh, activeOperation);
  useEffect(() => { if (!operation.data || activeOperation(operation.data) || completed.current === operation.data.operationId) return; completed.current = operation.data.operationId; setCursor(null); setRefresh(value => value + 1); onUpdated(); }, [operation.data, onUpdated]);
  useEffect(() => { setCursor(null); }, [selectedEntity]);
  function persist(value: UploadReceipt | null) { setReceipt(value); try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); } catch { /* Only receipt metadata is stored; never source bytes. */ } }
  async function choose(next: File | null) {
    if (!next) return;
    if (next.size === 0 || next.size > LIMIT) { setError('Choose a non-empty file no larger than 250 MB.'); return; }
    const generation = ++fileGeneration.current; setHashing(true); setFile(null); setHash(''); setError(null);
    try { const sha256 = await fingerprintFile(next); if (!mounted.current || generation !== fileGeneration.current) return; if (receipt?.session && receipt.sha256 !== sha256) throw new Error('This file does not match the original upload receipt. Choose the original file to resume, or start another upload.'); setFile(next); setHash(sha256); if (!receipt?.session) setContentType(MEDIA.includes(next.type) ? next.type : ''); }
    catch (caught) { if (mounted.current && generation === fileGeneration.current) setError(workflowError(caught)); }
    finally { if (mounted.current && generation === fileGeneration.current) setHashing(false); }
  }
  async function upload() {
    if (!file || !hash || pending.current || !contentType || !reportedAt.trim() || !subjectId) return;
    if (!/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(reportedAt.trim()) || !Number.isFinite(Date.parse(reportedAt.trim()))) { setError('Enter the source-reported date and time with Z or an explicit UTC offset.'); return; }
    pending.current = true; setBusy(true); setError(null); const cancel = new AbortController(); controller.current = cancel;
    const fingerprint = JSON.stringify({ proofId, filename: receipt?.session ? receipt.filename : file.name, byteSize: file.size, sha256: hash, contentType, reportedAt: reportedAt.trim(), subjectId });
    let current: UploadReceipt = receipt?.fingerprint === fingerprint ? receipt : { key: randomId(), fingerprint, filename: file.name, byteSize: file.size, sha256: hash, contentType, reportedAt: reportedAt.trim(), subjectId };
    persist(current);
    try {
      if (!current.session) { const session = await api.recordsRequest<UploadSession>(`/source-upload-sessions?${scope}`, 'POST', { proofId, filename: current.filename, contentType: current.contentType, byteSize: current.byteSize, sha256: current.sha256, reportedAt: current.reportedAt, subjectId: current.subjectId }, { 'Idempotency-Key': current.key }); if (!mounted.current) return; current = { ...current, session }; persist(current); if (cancel.signal.aborted) throw new DOMException('Upload paused', 'AbortError'); }
      const session = current.session!;
      const partStatus = await api.recordsRequest<UploadSession & { operation?: UploadOperation | null }>(`/source-upload-sessions/${encodeURIComponent(session.sessionId)}/parts?${scope}`);
      if (partStatus.operation?.operationId) { if (mounted.current) { persist({ ...current, operationId: partStatus.operation.operationId }); setFile(null); setHash(''); setRefresh(value => value + 1); } return; }
      if (partStatus.state === 'expired' || !['received', 'complete'].includes(partStatus.state) && Date.parse(partStatus.expiresAt) <= Date.now()) throw new Error('This upload session expired. Start another upload; accepted records remain preserved.');
      if (partStatus.resumable === false) throw new Error(partStatus.blockedReason === 'CONNECTION_PAUSED' ? 'This source is paused. Accepted receipts remain available; an administrator must review the source before upload resumes.' : 'Source settings changed. Preserve this receipt and start another upload after administrator review.');
      const parts = partStatus.receivedParts; if (!Array.isArray(parts)) throw new Error('The received upload parts could not be confirmed. Retry this upload.');
      const received = new Set(parts.map(part => typeof part === 'number' ? part : part.partNumber)), partSize = session.partSize || PART_SIZE;
      if (partSize > PART_SIZE || partSize <= 0) throw new Error('This upload uses an unsupported part size.');
      let receivedBytes = 0;
      for (let index = 0; index < Math.ceil(file.size / partSize); index++) {
        if (cancel.signal.aborted) throw new DOMException('Upload paused', 'AbortError');
        const start = index * partSize, end = Math.min(file.size, start + partSize);
        if (!received.has(index + 1)) await api.recordsUploadPart(session.sessionId, index + 1, organizationId, environment, file.slice(start, end, contentType), cancel.signal);
        receivedBytes += end - start; if (mounted.current) setProgress(receivedBytes);
      }
      if (cancel.signal.aborted) throw new DOMException('Upload paused', 'AbortError');
      await api.recordsRequest(`/source-upload-sessions/${encodeURIComponent(session.sessionId)}/parts/complete?${scope}`, 'POST', {}, { 'Idempotency-Key': `${current.key}-parts` });
      if (cancel.signal.aborted || !mounted.current) throw new DOMException('Upload paused', 'AbortError');
      const accepted = await api.recordsRequest<{ operationId: string }>(`/source-upload-sessions/${encodeURIComponent(session.sessionId)}/complete?${scope}`, 'POST', {}, { 'Idempotency-Key': `${current.key}-complete` });
      if (!accepted.operationId) throw new Error('The upload outcome was not confirmed. Retry using this receipt.');
      if (mounted.current) { persist({ ...current, operationId: accepted.operationId }); setFile(null); setHash(''); setRefresh(value => value + 1); }
    } catch (caught) { if (mounted.current) setError(cancel.signal.aborted ? 'Upload paused. Accepted requests may finish; select the same file and resume this receipt to confirm status.' : workflowError(caught)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  function restart() { controller.current?.abort(); fileGeneration.current++; persist(null); setFile(null); setHash(''); setError(null); setProgress(0); completed.current = null; }
  const visibleArtifacts = Array.isArray(list.data?.artifacts) ? list.data.artifacts.filter(item => selectedEntity === 'all' || item.subjectId === selectedEntity) : [];
  return <section className="records-panel records-source-artifacts"><h2>Source files</h2><p>Existing source files retain their source-reported time and upload attribution. An imported attachment is separate from a PackProof camera capture or personal attestation.</p>
    {list.error && <p role="alert" className="records-error-text">{list.error} <button className="records-text-button" onClick={() => setRefresh(value => value + 1)}>Retry source files</button></p>}
    {list.loading && !list.data && <p role="status">Loading source file receipts.</p>}
    {list.data && Array.isArray(list.data.artifacts) && (visibleArtifacts.length ? <div className="records-evidence-grid">{visibleArtifacts.map(artifact => <article className="records-evidence-card" key={artifact.artifactId}><h3>{artifact.filename}</h3><WorkflowStatus state={artifact.state}/><dl className="records-facts"><div><dt>Uploaded</dt><dd>{workflowDate(artifact.receivedAt)}</dd></div><div><dt>Source reported</dt><dd>{workflowDate(artifact.reportedAt)}</dd></div><div><dt>Type &amp; size</dt><dd>{artifact.contentType} · {artifact.byteSize.toLocaleString()} bytes</dd></div><div><dt>Attribution</dt><dd>{displayState(artifact.sourceAssurance)}</dd></div></dl><details><summary>File verification details</summary><code>{artifact.sha256 || 'Digest not established'}</code></details>{artifact.errorCode && <p className="records-error-text">{displayState(artifact.errorCode)}</p>}<RecordMedia api={api} proofId={proofId} organizationId={organizationId} environment={environment} sourceArtifactId={artifact.artifactId} evidence={{ id: artifact.artifactId, name: artifact.filename, contentType: artifact.contentType }} canDownload={artifact.downloadAvailable === true && !list.error && !list.loading}/></article>)}</div> : <p>No source files match this entity in the returned receipts.</p>)}
    {(cursor || list.data?.nextCursor) && <div className="records-pagination"><button className="records-button secondary" disabled={!cursor || list.loading} onClick={() => setCursor(null)}>First source page</button><span>Up to {list.data?.limit || 100} receipts per page · {list.data?.total ?? 'Unknown'} total</span><button className="records-button secondary" disabled={!list.data?.nextCursor || list.loading} onClick={() => setCursor(list.data?.nextCursor || null)}>Next source page</button></div>}
    {canUpload && <details className="records-workflow-action"><summary>Add an existing source file</summary><p>Supported files: JPEG, PNG, WebP, MP4, WebM, QuickTime, PDF, MPEG audio, MP4 audio, and WAV. Maximum 250 MB. File checks do not establish malware clearance.</p>
      {receipt?.session && <div className="records-operation-receipt"><strong>Upload receipt {receipt.session.sessionId}</strong><small>{receipt.filename} · {receipt.byteSize.toLocaleString()} bytes</small><small>Upload session expires {workflowDate(receipt.session.expiresAt)}</small>{!receipt.operationId && <p>Choose the original file to resume. The file fingerprint must match this receipt.</p>}</div>}
      {!receipt?.operationId && <div className="records-import-fields"><label>Source file<input type="file" disabled={busy || hashing} accept={MEDIA.join(',')} onChange={event => void choose(event.target.files?.[0] || null)}/></label><div className="records-field-stack"><label>File type<select value={contentType} disabled={busy || !!receipt?.session} onChange={event => setContentType(event.target.value)}><option value="">Confirm the file type</option>{MEDIA.map(type => <option key={type} value={type}>{type}</option>)}</select></label><label>Source-reported time<input placeholder="2026-11-04T14:00:00-05:00" value={reportedAt} maxLength={80} disabled={busy || !!receipt?.session} onChange={event => setReportedAt(event.target.value)}/><small>Use the time supplied by the source, with its UTC offset. Upload time is recorded separately.</small></label><label>Associated entity<select value={subjectId} disabled={busy || !!receipt?.session} onChange={event => setSubjectId(event.target.value)}>{entities.map(entity => <option value={entity.id} key={entity.id}>{entity.label}</option>)}</select></label></div></div>}
      {hashing && <p role="status">Computing the file fingerprint before upload.</p>}{file && hash && <p className="records-muted">{file.name} · {file.size.toLocaleString()} bytes · fingerprint confirmed</p>}
      {error && <p role="alert" className="records-error-text">{error}</p>}
      {busy && <p role="status">Uploading {progress.toLocaleString()} of {file?.size.toLocaleString()} bytes. Accepted parts can be resumed. Pausing stops subsequent steps; a request already sent may finish.</p>}
      {receipt?.operationId && <div className="records-operation-receipt"><strong>Source file operation {receipt.operationId}</strong>{operation.data ? <><WorkflowStatus state={operation.data.state}/><p>{operation.data.message || 'This receipt reports the server outcome; source attribution remains unchanged.'}</p>{operation.data.result && <p>Accepted {workflowDate(operation.data.result.acceptedAt)} · {operation.data.result.byteSize.toLocaleString()} bytes · digest {operation.data.result.sha256}</p>}{operation.data.errorCode && <p className="records-error-text">{displayState(operation.data.errorCode)}</p>}{operation.data.nextAction && <p>{operation.data.nextAction}</p>}</> : <p role="status">Checking the accepted upload operation.</p>}{operation.error && <p role="alert">{operation.error}</p>}<button className="records-text-button" onClick={() => setRefresh(value => value + 1)}>Refresh operation</button></div>}
      <div className="records-actions">{!receipt?.operationId && <button className="records-button secondary" disabled={busy || hashing || !file || !hash || !contentType || !reportedAt.trim()} onClick={() => void upload()}>{receipt?.session ? 'Resume source upload' : 'Reviewed file - upload'}</button>}{busy ? <button className="records-text-button" onClick={() => controller.current?.abort()}>Pause upload</button> : receipt && <button className="records-text-button" onClick={restart}>Start another upload</button>}</div>
    </details>}
  </section>;
}
