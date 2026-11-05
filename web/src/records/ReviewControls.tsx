import { useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { randomId } from '../random-id';
import type { RecordSummary } from './types';

type Props = { api: PackProofApi; record: RecordSummary; query: string; onUpdated: () => void };
function useCommand({ api, record, query, onUpdated }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef(false), receipt = useRef({ fingerprint: '', key: '' });
  async function execute(path: string, body: Record<string, unknown>, method = 'POST') {
    if (pending.current) return false;
    const fingerprint = JSON.stringify({ path, body, revision: record.revision });
    if (receipt.current.fingerprint !== fingerprint) receipt.current = { fingerprint, key: randomId() };
    pending.current = true; setBusy(true); setError(null);
    try { await api.recordsRequest(`/${encodeURIComponent(record.id)}${path}?${query}`, method, body, { 'If-Match': `"${record.revision}"`, 'Idempotency-Key': receipt.current.key }); onUpdated(); return true; }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The action could not be confirmed. Retry the same choices.'); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, error, execute };
}
export function RecordReviewControl(props: Props) {
  const [action, setAction] = useState(props.record.review === 'reviewed' ? 'reset_review' : 'mark_reviewed'), [reason, setReason] = useState('');
  const command = useCommand(props);
  return <details className="records-panel records-workflow-action"><summary>Record a review decision</summary><p>A review records your decision. Evidence completeness, unresolved issues, file integrity, and physical condition remain separate.</p><label>Decision<select value={action} onChange={event => setAction(event.target.value)}><option value="mark_reviewed">Mark reviewed</option><option value="reset_review">Return to unreviewed</option></select></label><label>Review reason<textarea rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}/></label>{command.error && <p className="records-error-text" role="alert">{command.error}</p>}<button className="records-button secondary" disabled={command.busy || !reason.trim()} onClick={() => void command.execute('/review', { action, reason: reason.trim() }).then(saved => { if (saved) setReason(''); })}>Save review decision</button></details>;
}
export function RequirementWaiverControl(props: Props & { requirementId: string }) {
  const [reason, setReason] = useState(''), command = useCommand(props);
  return <details className="records-review-form"><summary>Record an administrator waiver</summary><p>A waiver records why this requirement is being set aside. It does not create evidence or change an original file.</p><label>Waiver reason<textarea rows={2} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)}/></label>{command.error && <p className="records-error-text" role="alert">{command.error}</p>}<button className="records-button secondary" disabled={command.busy || !reason.trim()} onClick={() => void command.execute(`/requirements/${encodeURIComponent(props.requirementId)}/waiver`, { reason: reason.trim() }).then(saved => { if (saved) setReason(''); })}>Record waiver</button></details>;
}
export function RecordMetadataControl(props: Props) {
  const [title, setTitle] = useState(props.record.title || ''), [reference, setReference] = useState(props.record.reference || ''), [reason, setReason] = useState('');
  const command = useCommand(props), changed = title !== (props.record.title || '') || reference !== (props.record.reference || '');
  return <details className="records-panel records-workflow-action"><summary>Amend the reference or title</summary><p>The current labels change and the reason remains in the audit history. Source events and evidence remain preserved.</p><label>Shipment reference<input maxLength={200} value={reference} onChange={event => setReference(event.target.value)}/></label><label>Title<input maxLength={200} value={title} onChange={event => setTitle(event.target.value)}/></label><label>Amendment reason<textarea maxLength={1000} rows={2} value={reason} onChange={event => setReason(event.target.value)}/></label>{command.error && <p className="records-error-text" role="alert">{command.error}</p>}<button className="records-button secondary" disabled={command.busy || !changed || !reason.trim()} onClick={() => void command.execute('', { title: title.trim() || null, reference: reference.trim() || null, reason: reason.trim() }, 'PATCH').then(saved => { if (saved) setReason(''); })}>Save amendment</button></details>;
}
