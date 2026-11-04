import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { randomId } from '../random-id';
import { displayState } from './model';
interface Operation { operationId?: string; state: string; message?: string; nextAction?: string; nextAttemptAt?: string | null; attempts?: number }
export function ConnectionActions({ api, id, query, paused, onUpdated }: { api: PackProofApi; id: string; query: string; paused: boolean; onUpdated: () => void }) {
  const [reason, setReason] = useState(''), [action, setAction] = useState(paused ? 'resume' : 'test'), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [operation, setOperation] = useState<Operation | null>(null);
  const key = useRef(randomId()), pending = useRef(false);
  useEffect(() => { setAction(paused ? 'resume' : 'test'); }, [paused]);
  useEffect(() => { key.current = randomId(); }, [reason, action]);
  useEffect(() => {
    if (!operation?.operationId || !['queued', 'running', 'leased'].includes(operation.state)) return;
    let active = true;
    const timer = window.setTimeout(() => { void api.recordsRequest<Operation>(`/connections/${encodeURIComponent(id)}/operations/${encodeURIComponent(operation.operationId!)}?${query}`).then(value => { if (!active) return; setOperation(value); if (!['queued', 'running', 'leased'].includes(value.state)) onUpdated(); }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : 'Source check status is unavailable. Refresh connection health before relying on it.'); }); }, 2000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, id, query, operation, onUpdated]);
  async function submit() {
    if (pending.current || !reason.trim()) return; pending.current = true; setBusy(true); setError(null);
    try { const value = await api.recordsRequest<Operation>(`/connections/${encodeURIComponent(id)}/actions?${query}`, 'POST', { action, reason: reason.trim() }, { 'Idempotency-Key': key.current }); setOperation(value); if (!value.operationId) onUpdated(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The source action could not be accepted. Retry using the same choices.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <details className="records-connection-actions"><summary>Review source controls</summary><label>Action<select value={action} onChange={event => setAction(event.target.value)}><option value="test" disabled={paused}>Test source access and freshness</option><option value="reconcile" disabled={paused}>Reconcile source updates</option><option value={paused ? 'resume' : 'pause'}>{paused ? 'Resume synchronization' : 'Pause new synchronization'}</option></select></label><label>Reason<textarea value={reason} maxLength={1000} rows={2} onChange={event => setReason(event.target.value)} placeholder="Explain the source check or operational change."/></label><p>Accepted records stay available. A check succeeds only when a validated source adapter establishes its health measurements.</p>{error && <p role="alert" className="records-error-text">{error}</p>}<button className="records-button secondary" disabled={busy || !reason.trim()} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Submit source action'}</button>{operation && <div className="records-operation-receipt" role="status"><strong>{displayState(operation.state)}</strong>{operation.operationId && <small>Operation {operation.operationId}</small>}<p>{operation.message || 'A durable source operation was accepted. Check its result before relying on source freshness.'}</p>{operation.nextAction && <p>{operation.nextAction}</p>}{operation.nextAttemptAt && <small>Next attempt: {new Date(operation.nextAttemptAt).toLocaleString()}</small>}</div>}</details>;
}
