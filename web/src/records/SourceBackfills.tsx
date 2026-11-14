import { useEffect, useState } from 'react';
import type { PackProofApi } from '../api/client';
import type { SourceSubscription } from './SourceSubscriptions';
import { displayState } from './model';
import { useWorkflowCommand, useWorkflowData } from './workflow';

export interface BackfillRowCounts {
  processing: number; acceptedLinked: number; acceptedUnlinked: number; duplicate: number;
  conflict: number; quarantined: number; rejected: number;
}
export interface SourceBackfill {
  schema: 'packproof.source-backfill/v1'; id: string; organizationId: string; environment: string; principalId: string;
  connectionId: string; locationId: string; operatorMembershipId: string; subscriptionId: string; installationId: string | null;
  configurationRevision: number; configurationSha256: string; grantRevision: number; credentialId: string; manifestSha256: string;
  historyFrom: string; historyTo: string; semantics: 'cumulative_snapshot' | 'event_delta';
  state: 'proposed' | 'approved' | 'paused' | 'expired' | 'blocked_policy' | 'completed';
  approvalExpiresAt: string | null; createdAt: string; approvalPath: string;
  originals: Array<{ id: string; name: string; mediaType: string; sha256: string; byteSize: number;
    batchId: string | null; receiptState: string | null; counts: BackfillRowCounts | null }>;
  progress: { files: { total: number; received: number; pending: number; processing: number; succeeded: number; failed: number };
    rows: BackfillRowCounts; receivedRows: number };
  capabilities: { approve: boolean; pause: boolean; resume: boolean; collect: boolean };
  blockReason: string | null;
  latestDecisionId: string | null; decisionLimit: number; decisionsComplete: boolean;
  decisions: Array<{ id: string; action: string; wholeFileConsent: boolean; expiresAt: string | null; reason: string;
    actorUserId: string; actorMembershipId: string; createdAt: string; supersedesId: string | null }>;
}
interface BackfillList { jobs: SourceBackfill[]; nextCursor: string | null }
const stamp = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not approved';
const states: Record<SourceBackfill['state'], string> = {
  proposed: 'Waiting for historical import approval', approved: 'Historical import approved', paused: 'Historical import paused',
  expired: 'Historical import approval expired', blocked_policy: 'Historical import blocked', completed: 'Historical processing finished',
};
const outcomes: Array<[keyof BackfillRowCounts, string]> = [
  ['processing', 'Still processing'], ['acceptedLinked', 'Accepted and linked'], ['acceptedUnlinked', 'Accepted, awaiting a link'],
  ['duplicate', 'Duplicates'], ['conflict', 'Conflicts'], ['quarantined', 'Quarantined'], ['rejected', 'Rejected'],
];
function blockedMessage(reason: string) {
  return ({
    SOURCE_BACKFILL_AUTHORITY_CHANGED: 'The source approval or credential changed. Retained originals keep their original authority; propose a separately reviewed historical import.',
    SOURCE_BACKFILL_COLLECTOR_UNQUALIFIED: 'Use the matching authorized collector before continuing this historical import.',
    SOURCE_BACKFILL_SEMANTICS_UNQUALIFIED: 'This source no longer has the qualified snapshot or event meaning required by the historical import.',
    SOURCE_AUTHORIZATION_REQUIRED: 'Current source authorization is required before historical collection can continue.',
    AGENT_AUTHORIZATION_REQUIRED: 'The computer requires current authorization before historical collection can continue.',
  } as Record<string, string>)[reason] || (/^[A-Z0-9_]+$/.test(reason) ? displayState(reason) : reason);
}

export function SourceBackfills({ api, source, organizationId, environment, requestedJobId, requestedManifest, sourceMismatch = false }: {
  api: PackProofApi; source: SourceSubscription; organizationId: string; environment: string;
  requestedJobId?: string | null; requestedManifest?: string | null; sourceMismatch?: boolean;
}) {
  const [open, setOpen] = useState(!!requestedJobId), [selectedId, setSelectedId] = useState<string | null>(requestedJobId || null);
  const [cursor, setCursor] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const scope = new URLSearchParams({ organizationId, environment }).toString();
  const available = source.capabilities?.sourceBackfillJobs === true;
  const list = useWorkflowData<BackfillList>(api, available && open ? `/source-subscriptions/${encodeURIComponent(source.id)}/backfills?${scope}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` : null, revision);
  const detail = useWorkflowData<SourceBackfill>(api, available && open && selectedId ? `/source-backfills/${encodeURIComponent(selectedId)}?${scope}` : null, revision);
  const matchesTarget = (job: SourceBackfill) => job.organizationId === organizationId && job.environment === environment && job.subscriptionId === source.id;
  const validDetail = detail.data && matchesTarget(detail.data) && detail.data.id === selectedId;
  if (!available && !requestedJobId) return null;
  return <details className="source-approval-action" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Historical imports</summary>
    <p>Review older files inspected in PackProof Connect. Each import has its own exact-file approval and processing budget while live collection continues.</p>
    {!available ? <p role="alert">Historical import review is unavailable for this source. Refresh the source and matching collector before continuing.</p> : <>
      <button className="records-button secondary" disabled={list.loading || detail.loading} onClick={() => setRevision(n => n + 1)}>Refresh historical imports</button>
      {list.loading && <p role="status">Loading historical imports…</p>}
      {list.error && <p role="alert">{list.error}</p>}
      {list.data && !list.data.jobs.every(matchesTarget) && <p role="alert">The historical import inventory does not match this source workspace. Refresh the current source review.</p>}
      {list.data && list.data.jobs.every(matchesTarget) && <>{list.data.jobs.length ? <ul>{list.data.jobs.map(job => <li key={job.id}><button className="records-text-button" onClick={() => setSelectedId(job.id)}>{stamp(job.createdAt)} · {states[job.state]} · {job.progress.files.total} files</button></li>)}</ul> : <p>No historical import has been proposed. In PackProof Connect, inspect the older files from this approved source before requesting browser review.</p>}
        <div className="records-pagination">{cursor && <button className="records-button secondary" onClick={() => setCursor(null)}>First historical import page</button>}{list.data.nextCursor && <button className="records-button secondary" onClick={() => setCursor(list.data!.nextCursor)}>Next historical import page</button>}</div></>}
      {detail.loading && <p role="status">Loading this exact historical file manifest…</p>}
      {detail.error && <p role="alert">{detail.error}</p>}
      {detail.data && !validDetail && <p role="alert">The historical manifest does not match the exact job and workspace in this review. Open a fresh source review.</p>}
      {detail.data && validDetail && <BackfillReview key={`${scope}.${source.id}.${detail.data.id}.${detail.data.manifestSha256}.${source.configurationRevision}.${source.grantRevision}.${source.state}`} api={api} source={source} job={detail.data} organizationId={organizationId} environment={environment} requestedManifest={selectedId === requestedJobId ? requestedManifest : null} sourceMismatch={sourceMismatch || selectedId === requestedJobId && !requestedManifest} readUnavailable={detail.loading || !!detail.error} onUpdated={() => setRevision(n => n + 1)}/>}
    </>}
  </details>;
}

function BackfillReview({ api, source, job, organizationId, environment, requestedManifest, sourceMismatch, readUnavailable, onUpdated }: {
  api: PackProofApi; source: SourceSubscription; job: SourceBackfill; organizationId: string; environment: string;
  requestedManifest?: string | null; sourceMismatch: boolean; readUnavailable: boolean; onUpdated: () => void;
}) {
  const [consent, setConsent] = useState(false), [reason, setReason] = useState(''), [expires, setExpires] = useState(''), [notice, setNotice] = useState('');
  const scope = new URLSearchParams({ organizationId, environment }).toString();
  const fingerprint = JSON.stringify([job.id, job.manifestSha256, job.latestDecisionId, job.state, job.approvalExpiresAt, job.capabilities, source.state, source.configurationRevision, source.grantRevision]);
  const command = useWorkflowCommand(api, `${scope}.${fingerprint}`);
  useEffect(() => { setConsent(false); setNotice(''); }, [fingerprint]);
  const mismatch = sourceMismatch || job.organizationId !== organizationId || job.environment !== environment || job.subscriptionId !== source.id || job.installationId !== source.installationId || job.connectionId !== source.connectionId || job.locationId !== source.locationId || job.operatorMembershipId !== source.operatorMembershipId || job.configurationRevision !== source.configurationRevision || job.configurationSha256 !== source.configurationSha256 || job.grantRevision !== source.grantRevision || !!requestedManifest && requestedManifest !== job.manifestSha256;
  const allowed = !mismatch && !readUnavailable && job.decisionsComplete && source.state === 'active' && !source.capabilities?.blockedReason;
  const expiry = expires ? new Date(expires).getTime() : NaN;
  const validExpiry = Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + 24 * 60 * 60 * 1000;
  const reconciled = outcomes.reduce((sum, [key]) => sum + job.progress.rows[key], 0) === job.progress.receivedRows;
  const attentionRows = job.progress.rows.acceptedUnlinked + job.progress.rows.conflict + job.progress.rows.quarantined + job.progress.rows.rejected;
  async function act(action: 'approve' | 'pause' | 'resume') {
    if (!allowed || !job.capabilities[action] || !reason.trim() || command.busy || action !== 'pause' && (!consent || !validExpiry)) return;
    const value = await command.run(`/source-backfills/${encodeURIComponent(job.id)}/actions?${scope}`, {
      organizationId, environment, action, manifestSha256: job.manifestSha256,
      configurationRevision: job.configurationRevision, grantRevision: job.grantRevision, expectedDecisionId: job.latestDecisionId, reason: reason.trim(),
      ...(action === 'pause' ? {} : { expiresAt: new Date(expiry).toISOString(), wholeFileConsent: true }),
    });
    if (value) { setConsent(false); setNotice(action === 'pause' ? 'Historical import paused. Queued originals and receipts remain preserved.' : 'This exact historical import was approved. The collector will reconcile each original separately.'); onUpdated(); }
  }
  return <article className="case-report" aria-label="Historical import review">
    <h3>{states[job.state]}</h3>
    {job.state === 'completed' && <p>Review {job.progress.files.failed} {job.progress.files.failed === 1 ? 'file' : 'files'} and {attentionRows} {attentionRows === 1 ? 'row' : 'rows'} requiring attention. Processing has finished; each receipt outcome remains visible. This does not establish complete source coverage.</p>}
    <dl className="records-facts"><div><dt>Historical source interval</dt><dd>{stamp(job.historyFrom)} → {stamp(job.historyTo)}</dd></div><div><dt>Source update meaning</dt><dd>{job.semantics === 'cumulative_snapshot' ? 'Cumulative snapshots — compare active revisions' : 'Events and changes — preserve source identities'}</dd></div><div><dt>Approval expires</dt><dd>{stamp(job.approvalExpiresAt)}</dd></div><div><dt>Originals received</dt><dd>{job.progress.files.received} of {job.progress.files.total}</dd></div><div><dt>Files still pending</dt><dd>{job.progress.files.pending}</dd></div><div><dt>Files processing</dt><dd>{job.progress.files.processing}</dd></div><div><dt>Files reconciled successfully</dt><dd>{job.progress.files.succeeded}</dd></div><div><dt>Files requiring attention</dt><dd>{job.progress.files.failed}</dd></div></dl>
    {(job.capabilities.approve || job.capabilities.resume) && <><h4>Files awaiting your decision</h4><ul>{job.originals.map(original => <li key={original.id}>{original.name} · {original.byteSize.toLocaleString()} bytes</li>)}</ul></>}
    <details><summary>Exact historical originals ({job.originals.length})</summary><p>Every complete original is preserved, including unmapped columns. Files outside this manifest remain outside this historical import.</p><div className="source-backfill-files" tabIndex={0} role="region" aria-label="Historical originals file inventory"><table><caption>Approved file inventory and current receipts</caption><thead><tr><th scope="col">Original file</th><th scope="col">Size</th><th scope="col">Receipt state</th><th scope="col">SHA 256</th></tr></thead><tbody>{job.originals.map(original => <tr key={original.id}><th scope="row">{original.name}</th><td>{original.byteSize.toLocaleString()} bytes</td><td>{original.receiptState ? displayState(original.receiptState) : 'Not yet received'}</td><td><code>{original.sha256}</code></td></tr>)}</tbody></table></div><p>Manifest SHA 256: <code>{job.manifestSha256}</code></p><p>Source revision {job.configurationRevision} · approval revision {job.grantRevision}</p></details>
    <details open={job.state === 'completed' && attentionRows > 0}><summary>Historical input accounting</summary><p>Received rows: {job.progress.receivedRows}. Each received row has one current outcome.</p><dl className="records-facts">{outcomes.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{job.progress.rows[key]}</dd></div>)}</dl>{!reconciled && <p role="status">Historical input accounting has not yet reconciled. Refresh before relying on these totals.</p>}<p>Duplicate snapshots are not additional quantities. Conflicts and unresolved links remain visible.</p></details>
    {job.decisions.length > 0 && <details><summary>Historical import approval history</summary><ol>{job.decisions.map(decision => <li key={decision.id}><strong>{displayState(decision.action)}</strong> · {stamp(decision.createdAt)}<p>{decision.reason}</p>{decision.wholeFileConsent && <p>Exact complete-original consent recorded until {stamp(decision.expiresAt)}.</p>}</li>)}</ol>{!job.decisionsComplete && <p role="alert">The complete decision history is unavailable. Refresh before making another decision.</p>}</details>}
    {job.decisions.length >= job.decisionLimit - 1 && <p role="status">This finite historical import has reached its approval action budget. Pause any remaining collection and propose a separately reviewed import if more work is required.</p>}
    {mismatch && <p role="alert">This historical import no longer matches the exact source, grant, installation or manifest in this review. Open a fresh review from PackProof Connect. Retained work keeps its original authority.</p>}
    {source.state !== 'active' && <p role="status">Historical collection is blocked while this source is {displayState(source.state).toLowerCase()}. Already captured originals and receipts remain preserved.</p>}
    {job.blockReason && <p role="status" className="records-notice warning">{blockedMessage(job.blockReason)}</p>}
    {allowed && (job.capabilities.approve || job.capabilities.resume || job.capabilities.pause) && <div className="source-approval-action">
      <label>Reason for this historical import decision<textarea value={reason} maxLength={1000} disabled={command.busy} onChange={event => { setReason(event.target.value); setConsent(false); }}/></label>
      {(job.capabilities.approve || job.capabilities.resume) && <><label>Historical import approval expires (your timezone)<input type="datetime-local" value={expires} disabled={command.busy} onChange={event => { setExpires(event.target.value); setConsent(false); }}/></label><p>Choose a future expiry within 24 hours. This authorizes only the exact reviewed historical originals within the existing source interval.</p><label className="agent-check"><input type="checkbox" checked={consent} disabled={command.busy} onChange={event => setConsent(event.target.checked)}/>I reviewed these exact historical files and authorize their complete-original upload, source interval and update meaning until the chosen expiry.</label></>}
      <div className="records-actions">{job.capabilities.approve && <button className="records-button" disabled={!consent || !reason.trim() || !validExpiry || command.busy} onClick={() => void act('approve')}>Approve exact historical import</button>}{job.capabilities.resume && <button className="records-button" disabled={!consent || !reason.trim() || !validExpiry || command.busy} onClick={() => void act('resume')}>Resume reviewed historical import</button>}{job.capabilities.pause && <button className="records-button secondary" disabled={!reason.trim() || command.busy} onClick={() => void act('pause')}>Pause historical import</button>}</div>
      <p>Live collection keeps its own budget. Source configuration, grants and previously queued originals retain their existing identities.</p>
    </div>}
    {command.error && <p role="alert">{command.error}</p>}{notice && <p role="status">{notice}</p>}
  </article>;
}
