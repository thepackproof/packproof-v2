import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { workflowError } from './workflow';

interface SourceRecord {
  eventKey?: string; receiptId?: string; kind: 'original' | 'derived_excerpt'; reason?: string;
  originalText?: string; fields?: Record<string, unknown>; fileName?: string; locator?: string;
  fieldLineage?: Record<string,string>; originalSha256?: string; bytesBase64?: string;
}
export function revisionPath(proofId: string, revision: number) {
  return '/order-proofs/' + encodeURIComponent(proofId) + '/revisions/' + revision;
}
function download(bytes: Blob, name: string) {
  const url = URL.createObjectURL(bytes);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const reasons: Record<string,string> = {
  original_scope_unavailable: 'The source is outside the current approval.',
  shared_or_reassigned_record: 'This original also contains other records.',
  record_excerpt: 'Only the permitted source row is available.',
  format_unqualified: 'This format cannot be opened as a verified original.',
};
type Common = {api: PackProofApi; scope: string; proofId: string; revision: number};
export function OrderEvidence({api, scope, proofId, revision, id, artifact = false}: Common & {id: string; artifact?: boolean}) {
  const [record, setRecord] = useState<SourceRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function open() {
    setError(''); setBusy(true); setRecord(null);
    try {
      const path = revisionPath(proofId, revision) + (artifact ? '/artifacts/' : '/sources/') + encodeURIComponent(id);
      const result = await api.recordsRequest<SourceRecord>(path + '?' + scope);
      if (!active.current) return;
      if ((artifact ? result.receiptId : result.eventKey) !== id) throw Error('The source has changed. Reopen the order.');
      if (artifact && result.kind === 'original') {
        if (!result.bytesBase64) throw Error('This original is unavailable.');
        const bytes = Uint8Array.from(atob(result.bytesBase64), c => c.charCodeAt(0));
        download(new Blob([bytes], {type: 'application/octet-stream'}), result.fileName || 'evidence');
        setRecord({...result, bytesBase64:undefined});
      } else setRecord(result);
    } catch (caught) { if (active.current) setError(workflowError(caught)); }
    finally { if (active.current) setBusy(false); }
  }
  return <div>
    <button type="button" className="records-text-button" disabled={busy} onClick={() => void open()}>
      {busy ? 'Checking access…' : artifact ? 'Download original' : 'Inspect source record'}
    </button>
    {error && <p role="alert">{error}</p>}
    {record && <section aria-label="Authorized source">
      <strong>{record.kind === 'derived_excerpt' ? 'Permitted excerpt' : artifact ? 'Original downloaded' : 'Verified original'}</strong>
      {record.reason && <p>{reasons[record.reason] || 'Original unavailable for this revision.'}</p>}
      {record.originalText !== undefined && <pre>{record.originalText}</pre>}
      {Object.keys(record.fields || {}).length > 0 && <dl className="records-facts">
        {Object.entries(record.fields!).map(([field,value]) => <div key={field}><dt>{record.fieldLineage?.[field] || field}</dt><dd>{String(value ?? 'Unreported')}</dd></div>)}
      </dl>}
      <button type="button" className="records-text-button" onClick={() => setRecord(null)}>Close source</button>
    </section>}
  </div>;
}

export function OrderPacketDownload({api, scope, proofId, revision}: Common) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function save() {
    setBusy(true); setMessage(''); setError('');
    try {
      const packet = await api.recordsRequest<{schema:string;proofId:string;revision:number;exportedAt:string}>(
        revisionPath(proofId,revision) + '/packet?' + scope, 'POST');
      if (!active.current) return;
      if (packet.schema !== 'packproof.order-packet/v1' || packet.proofId !== proofId || packet.revision !== revision)
        throw Error('The downloaded packet did not match this revision.');
      download(new Blob([JSON.stringify(packet, null, 2)], {type:'application/json'}),
        'PackProof-' + proofId + '-r' + revision + '-' + packet.exportedAt.substring(0,10) + '.json');
      setMessage('Prepared revision ' + revision + ' for download.');
    } catch (caught) { if (active.current) setError(workflowError(caught)); }
    finally { if (active.current) setBusy(false); }
  }
  return <><button type="button" className="records-button secondary" disabled={busy} onClick={() => void save()}>
    {busy ? 'Preparing packet…' : 'Download revision ' + revision}</button>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}</>;
}
