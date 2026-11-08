import { useEffect, useRef, useState } from 'react';
import type { PackProofApi } from '../api/client';
import { ApiError } from '../api/types';
import { randomId } from '../random-id';
import { Glyph } from '../site/Brand';
import { displayState, stateTone } from './model';
import type { RecordOrganization, RecordSummary, SourceAssociation } from './types';

const stamp = (value?: string | null) => {
  const time = value ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? time.toLocaleString() : 'Not reported';
};
function errorText(error: unknown) {
  if (error instanceof ApiError && error.status === 403) return 'Your current workspace access does not allow source exception review. Ask an administrator to review access.';
  return error instanceof Error ? error.message : 'Source exceptions are temporarily unavailable. Refresh to try again.';
}
function guidance(item: SourceAssociation) {
  if (item.state === 'conflict') return 'This source event ID was reused with changed details. Preserve both receipts and correct the source event identity before submitting a new observation.';
  if (item.state === 'blocked_policy') return 'Processing stopped safely. Review current source authorization, location and the error code before requesting recovery.';
  if (item.state === 'retryable_error') return 'The observation is retained for a bounded retry. Check source availability and the next processing result.';
  if (item.resolution?.outcome === 'unresolved_ambiguous') return 'More than one record matches the exact reference. An administrator must approve the intended source relationship.';
  if (item.resolution?.outcome === 'linked') return 'The source reference is linked. The observation is waiting for the next assembly pass.';
  return 'No exact record relationship is known yet. Automatic processing can resolve a later shipment import, or an administrator can approve a source mapping.';
}

function ReplaySource({ api, organization, item, onUpdated }: { api: PackProofApi; organization: RecordOrganization; item: SourceAssociation; onUpdated: (message: string) => void }) {
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false), [error, setError] = useState('');
  const command = useRef<{ signature: string; key: string } | null>(null), pending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function replay() {
    if (pending.current || !reason.trim()) return;
    const body = { organizationId: organization.id, environment: organization.environment, reason: reason.trim() }, signature = JSON.stringify(body);
    if (command.current?.signature !== signature) command.current = { signature, key: randomId() };
    pending.current = true; setBusy(true); setError('');
    try { const scope = new URLSearchParams({ organizationId: organization.id, environment: organization.environment }); await api.recordsRequest(`/source-associations/${encodeURIComponent(item.id)}/replay?${scope}`, 'POST', body, { 'Idempotency-Key': command.current.key }); if (active.current) { setAccepted(true); onUpdated('Replay queued. Refresh exceptions to inspect its result.'); } }
    catch (caught) { if (active.current) setError(errorText(caught)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <details className="records-source-replay"><summary>Replay after repairing this source</summary><p>Current credentials, source settings and location access are checked again. Replay retains the original source receipt and cannot approve a new shipment relationship.</p>{accepted ? <p>The replay request was accepted.</p> : <><label>What was repaired?<textarea rows={2} value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)}/></label><button className="records-button secondary" disabled={busy || !reason.trim()} onClick={() => void replay()}>{busy ? 'Queueing replay…' : 'Queue source replay'}</button></>}{error && <p role="alert" className="records-error-text">{error}</p>}</details>;
}

function SourceMapping({ api, organization, item, onUpdated }: { api: PackProofApi; organization: RecordOrganization; item: SourceAssociation; onUpdated: (message: string) => void }) {
  const scope = new URLSearchParams({ organizationId: organization.id, environment: organization.environment }).toString();
  const [search, setSearch] = useState(''), [results, setResults] = useState<RecordSummary[] | null>(null), [selected, setSelected] = useState<RecordSummary | null>(null);
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [searching, setSearching] = useState(false), [error, setError] = useState(''), [accepted, setAccepted] = useState(false);
  const generation = useRef(0), pending = useRef(false), command = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => () => { generation.current++; }, []);
  async function findRecords() {
    const term = search.trim(); if (!term || searching || busy) return;
    const request = ++generation.current; setSearching(true); setError(''); setResults(null); setSelected(null); setConfirmed(false);
    try {
      const params = new URLSearchParams(scope); params.set('q', term); params.set('limit', '20'); if (item.locationId) params.set('locationId', item.locationId);
      const page = await api.recordsRequest<{ records: RecordSummary[] }>(`?${params}`);
      if (request === generation.current) setResults(page.records.filter(record => record.locationId === item.locationId));
    } catch (caught) { if (request === generation.current) setError(errorText(caught)); }
    finally { if (request === generation.current) setSearching(false); }
  }
  async function approve() {
    if (pending.current || !selected || !confirmed || !reason.trim()) return;
    const body = { organizationId: organization.id, environment: organization.environment, connectionId: item.connectionId, locationId: item.locationId, reference: item.reference, proofId: selected.proofId, ruleVersion: 'packproof.source-reference/v1', reason: reason.trim() };
    const signature = JSON.stringify(body); if (command.current?.signature !== signature) command.current = { signature, key: randomId() };
    const request = ++generation.current; pending.current = true; setBusy(true); setError('');
    try {
      await api.recordsRequest(`/source-crosswalks?${scope}`, 'POST', body, { 'Idempotency-Key': command.current.key });
      if (request === generation.current) { setAccepted(true); setConfirmed(false); onUpdated('Mapping approved. Matching observations are queued for replay. Refresh exceptions to inspect the processing result.'); }
    } catch (caught) { if (request === generation.current) setError(errorText(caught)); }
    finally { if (request === generation.current) setBusy(false); pending.current = false; }
  }
  return <details className="records-source-mapping"><summary>Approve an exact source mapping</summary><p>Choose an existing record after checking the source reference and location. This mapping applies to future observations with this exact source identity. It cannot silently move earlier evidence to another shipment.</p>
    {accepted ? <p>The mapping approval was recorded.</p> : <>
      <form className="records-source-search" onSubmit={event => { event.preventDefault(); void findRecords(); }}><label>Find the target shipment<input value={search} maxLength={200} disabled={busy || searching} onChange={event => { setSearch(event.target.value); setSelected(null); setResults(null); setConfirmed(false); }} placeholder="Search a shipment reference or record ID"/></label><button className="records-button secondary" disabled={busy || searching || !search.trim()} type="submit">{searching ? 'Finding records…' : 'Find authorized records'}</button></form>
      {results && <fieldset className="records-source-targets"><legend>Choose the intended record</legend>{results.length ? results.map(record => <label key={record.proofId}><input type="radio" name={`source-target-${item.id}`} value={record.proofId} disabled={busy} checked={selected?.proofId === record.proofId} onChange={() => { setSelected(record); setConfirmed(false); }}/><span><strong>{record.reference || record.proofId}</strong><span>{record.title || 'Shipping record'}</span><small>{record.proofId} · {record.locationId ? organization.locations.find(location => location.id === record.locationId)?.name || record.locationId : 'Unlocated source'}</small></span></label>) : <p>No permitted record matches this search and exact source location. Check the source identity or wait for its shipment import.</p>}</fieldset>}
      {selected && <><label>Reason for this mapping<textarea value={reason} maxLength={1000} rows={3} disabled={busy} onChange={event => { setReason(event.target.value); setConfirmed(false); }}/></label><label className="records-source-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/><span>I checked the source records and approve linking {item.reference.externalId} to {selected.reference || selected.proofId} in this location.</span></label></>}
      <button className="records-button secondary" disabled={busy || !selected || !confirmed || !reason.trim()} onClick={() => void approve()}>{busy ? 'Approving mapping…' : 'Approve mapping and queue replay'}</button>
    </>}{error && <p role="alert" className="records-error-text">{error}</p>}
  </details>;
}

export function SourceAssociations({ api, organization, revision, onUpdated }: { api: PackProofApi; organization: RecordOrganization; revision: number; onUpdated: () => void }) {
  const scope = new URLSearchParams({ organizationId: organization.id, environment: organization.environment }).toString(), canReview = ['OWNER', 'ADMIN', 'REVIEWER'].includes(organization.role);
  const access = JSON.stringify([scope, organization.role, organization.locations.map(location => location.id).sort()]);
  const [page, setPage] = useState<{ api: PackProofApi; scope: string; items: SourceAssociation[]; nextCursor: string | null } | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState<{ api: PackProofApi; scope: string; message: string } | null>(null);
  const generation = useRef(0), pending = useRef(false);
  useEffect(() => {
    const request = ++generation.current; setPage(null); setError(''); if (!canReview) return;
    let active = true; setLoading(true); pending.current = true;
    void api.recordsRequest<{ items: SourceAssociation[]; nextCursor: string | null }>(`/source-associations?${scope}&limit=50`).then(value => { if (active && request === generation.current) setPage({ api, scope: access, items: value.items || [], nextCursor: value.nextCursor || null }); }).catch(caught => { if (active && request === generation.current) setError(errorText(caught)); }).finally(() => { if (active && request === generation.current) { setLoading(false); pending.current = false; } });
    return () => { active = false; generation.current++; pending.current = false; };
  }, [api, scope, access, revision, refresh, canReview]);
  if (!canReview) return null;
  const current = page?.api === api && page.scope === access ? page : null;
  function updated(message: string) { setNotice({ api, scope: access, message }); onUpdated(); }
  async function loadMore() {
    if (pending.current || !current?.nextCursor) return; const request = generation.current; pending.current = true; setLoading(true); setError('');
    try { const next = await api.recordsRequest<{ items: SourceAssociation[]; nextCursor: string | null }>(`/source-associations?${scope}&limit=50&before=${encodeURIComponent(current.nextCursor)}`); if (request === generation.current) setPage({ api, scope: access, items: [...current.items, ...next.items.filter(item => !current.items.some(known => known.id === item.id))], nextCursor: next.nextCursor }); }
    catch (caught) { if (request === generation.current) setError(errorText(caught)); }
    finally { if (request === generation.current) { pending.current = false; setLoading(false); } }
  }
  return <section className="records-panel records-source-associations" aria-label="Unlinked source observations" aria-busy={loading}>
    <header className="records-panel-heading"><div><span className="records-eyebrow">SOURCE EXCEPTIONS</span><h2>Unlinked source observations</h2><p>Retained source data is kept separate until its shipment relationship is safe.</p></div><button className="records-button secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh exceptions</button></header>
    <p className="records-muted">This queue covers your permitted workspace locations. Reported source times, PackProof receipt times and assembly results are different facts. Operational updates are outside the inventory of earlier signed snapshots.</p>
    {notice?.api === api && notice.scope === access && <p role="status" className="records-notice neutral">{notice.message}</p>}
    {error && <p role="alert" className="records-error-text">{error}</p>}{loading && !current && <p role="status">Checking retained source observations…</p>}
    {current && !current.items.length && <p>No unlinked observations are reported in your current access. Source coverage and freshness still need separate review.</p>}
    {current?.items.map(item => <article className="records-source-observation" key={item.id}><header><span className="records-connection-icon"><Glyph name="link" size={20}/></span><div><h3>{item.reference.externalId}</h3><p>{displayState(item.reference.type)} · {item.sourceKind} · {item.sourceSchemaVersion}</p></div><span className={`records-status ${stateTone(item.state)}`}>{displayState(item.state)}</span></header><p>{guidance(item)}</p>
      <dl className="records-facts"><div><dt>Location</dt><dd>{item.locationId ? organization.locations.find(location => location.id === item.locationId)?.name || item.locationId : 'Unlocated source'}</dd></div><div><dt>Source-reported time</dt><dd>{stamp(item.reportedAt)}</dd></div><div><dt>PackProof received</dt><dd>{stamp(item.receivedAt)}</dd></div><div><dt>Last processing update</dt><dd>{stamp(item.updatedAt)}</dd></div><div><dt>Source interpretation</dt><dd>{item.mappingVersion}</dd></div><div><dt>Assurance</dt><dd>Organization-submitted source assertion</dd></div></dl>
      <details><summary>Receipt and matching details</summary><dl className="records-facts"><div><dt>Source connection</dt><dd>{item.connectionId}</dd></div><div><dt>Source event</dt><dd>{item.sourceEventId}</dd></div><div><dt>Preserved receipt</dt><dd>{item.id}</dd></div><div><dt>Resolution</dt><dd>{displayState(item.resolution?.outcome)}</dd></div><div><dt>Matching rule</dt><dd>{item.resolution?.ruleVersion || 'Not reported'}</dd></div><div><dt>Rule basis</dt><dd>{displayState(item.resolution?.basis)}</dd></div><div><dt>Candidate records</dt><dd>{item.resolution?.candidates?.join(', ') || 'None'}</dd></div><div><dt>Processing attempts</dt><dd>{item.attempts}</dd></div>{item.errorCode && <div><dt>Error code</dt><dd>{item.errorCode}</dd></div>}</dl></details>
      {['OWNER', 'ADMIN'].includes(organization.role) && item.state === 'pending' && item.resolution?.outcome !== 'linked' && <SourceMapping key={`${scope}:${item.id}`} api={api} organization={organization} item={item} onUpdated={updated}/>}
      {['OWNER', 'ADMIN'].includes(organization.role) && ['blocked_policy', 'retryable_error'].includes(item.state) && <ReplaySource key={`${scope}:${item.id}`} api={api} organization={organization} item={item} onUpdated={updated}/>}
      {organization.role === 'REVIEWER' && item.state === 'pending' && <p className="records-muted">A workspace administrator can approve a verified source mapping.</p>}
    </article>)}
    {current?.nextCursor && <div className="records-pagination"><span>{current.items.length} retained observations loaded</span><button className="records-button secondary" disabled={loading} onClick={() => void loadMore()}>{loading ? 'Loading exceptions…' : 'Load more source exceptions'}</button></div>}
  </section>;
}
