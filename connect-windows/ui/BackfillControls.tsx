import { useEffect, useState } from "react";
import type { BackfillJob, BackfillSemantics, ConnectBridge, ConnectStatus, SourceSubscriptionStatus } from "./types";

type Action = (message: string, operation: () => Promise<ConnectStatus>) => Promise<void>;
const rowLabels = { processing: "Still processing", acceptedLinked: "Accepted and linked", acceptedUnlinked: "Accepted, awaiting association", duplicate: "Duplicate", conflict: "Identity conflict", quarantined: "Quarantined", rejected: "Rejected" };
const stateLabels = { proposed: "Awaiting exact-file approval", approved: "Approved for historical collection", paused: "Historical collection paused", expired: "Approval expired", blocked_policy: "Approval needs review", completed: "Historical processing finished" };
function utcInput(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 19) : ""; }
function instant(value: string) { const utc = value ? `${value}${value.length === 16 ? ":00" : ""}Z` : ""; return Number.isFinite(Date.parse(utc)) ? new Date(utc).toISOString().replace(".000Z", "Z") : ""; }
function stamp(value: string) { return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { timeZoneName: "short" }) : "Time unavailable"; }

export function BackfillControls({ source, bridge, available, disabled, action, external }: { source: SourceSubscriptionStatus; bridge: ConnectBridge; available: boolean; disabled: boolean; action: Action; external: (operation: () => Promise<unknown>) => void }) {
  const draft = source.backfillDraft;
  const [from, setFrom] = useState(() => utcInput(draft?.historyFrom)), [to, setTo] = useState(() => utcInput(draft?.historyTo));
  const [semantics, setSemantics] = useState<BackfillSemantics | "">(draft?.semantics ?? source.backfillSemantics ?? ""), [consent, setConsent] = useState(false);
  const jobsFingerprint = source.backfillJobs?.map(job => `${job.id}:${job.state}:${job.manifestSha256}`).join("|") ?? "";
  useEffect(() => setConsent(false), [draft?.inspectionSha256, source.configurationRevision, source.grantRevision, source.state, source.localPaused, available, jobsFingerprint]);
  useEffect(() => { if (!draft && source.backfillSemantics) { setSemantics(source.backfillSemantics); setConsent(false); } }, [draft?.inspectionSha256, source.backfillSemantics]);
  const allowed = available && source.state === "active" && !source.localPaused;
  const fromAt = instant(from), toAt = instant(to);
  const intervalValid = !!from && !!to && Number.isFinite(Date.parse(fromAt)) && Number.isFinite(Date.parse(toAt)) && Date.parse(fromAt) <= Date.parse(toAt);
  const current = !!draft && draft.configurationRevision === source.configurationRevision && draft.grantRevision === source.grantRevision && intervalValid && semantics === draft.semantics && (!source.backfillSemantics || semantics === source.backfillSemantics) && Date.parse(fromAt) === Date.parse(draft.historyFrom) && Date.parse(toAt) === Date.parse(draft.historyTo);
  const jobsShown = source.backfillJobsShown ?? source.backfillJobs?.length ?? 0, jobsKnown = source.backfillJobKnownTotal ?? source.backfillJobTotal;
  if (!available && !source.backfillJobs?.length && !draft && !jobsKnown) return null;
  return <section className="source-backfill" aria-label="Historical reports">
    <h3>Import historical reports</h3>
    <p>Select completed reports from this source's approved folder. An administrator reviews the exact file list before upload. New reports keep a separate collection budget.</p>
    {!allowed && <p className="connect-notice warning" role="status">Historical file inspection needs a current compatible collector, an approved source policy for historical records, and an active, resumed source. Retained jobs and receipts stay preserved.</p>}
    {allowed && <details className="connect-advanced"><summary>Choose historical reports</summary>
      <p>Use the source owner's approved history interval and update meaning. Each original remains bounded by the existing source limits; one request supports at most 100 files and 200 MiB.</p>
      <div className="source-form-grid">
        <label>Historical interval begins (UTC)<input type="datetime-local" step="1" value={from} disabled={disabled} onChange={event => { setFrom(event.target.value); setConsent(false); }}/></label>
        <label>Historical interval ends (UTC)<input type="datetime-local" step="1" value={to} disabled={disabled} onChange={event => { setTo(event.target.value); setConsent(false); }}/></label>
        <label>How these reports update the source<select value={semantics} disabled={disabled} onChange={event => { setSemantics(event.target.value as BackfillSemantics | ""); setConsent(false); }}><option value="">Choose the source owner's meaning</option>{(!source.backfillSemantics || source.backfillSemantics === "cumulative_snapshot") && <option value="cumulative_snapshot">Cumulative snapshots at their source revisions</option>}{(!source.backfillSemantics || source.backfillSemantics === "event_delta") && <option value="event_delta">Individual events or changes</option>}</select></label>
      </div>
      <p className="source-caption">UTC controls do not change source timestamps. Every historical row needs its actual source time inside this interval; receipt time cannot replace it.</p>
      <button className="secondary" disabled={disabled || !intervalValid || !semantics} onClick={() => { setConsent(false); if (semantics) void action("Inspecting selected historical reports locally", () => bridge.chooseBackfillFiles({ id: source.id, historyFrom: fromAt, historyTo: toAt, semantics })); }}>Choose files for local inspection</button>
      {draft && <div className="connect-notice"><h4>Locally inspected originals</h4><p>{draft.originalCount.toLocaleString()} files · {draft.totalBytes.toLocaleString()} bytes. Original bytes have not been uploaded by this inspection.</p>
        <ul>{draft.originals.map(original => <li key={original.name}>{original.name} · {original.byteSize.toLocaleString()} bytes</li>)}</ul>
        {!current && <p role="status">The source approval, history interval or update meaning differs from this inspection. Inspect the selected files again before requesting approval.</p>}
        <details className="connect-advanced"><summary>Exact local inspection details</summary><p>Inspected {stamp(draft.inspectedAt)}. Inspection SHA 256: <code>{draft.inspectionSha256}</code></p>{draft.originals.map(original => <p key={original.name}>{original.name}: <code>{original.sha256}</code></p>)}</details>
        <label className="connect-checkbox"><input type="checkbox" checked={consent} disabled={disabled || !current} onChange={event => setConsent(event.target.checked)}/>Request administrator approval to upload and preserve these exact whole originals, including unmapped columns and other records they contain.</label>
        <button className="primary" disabled={disabled || !current || !consent} onClick={() => void action("Saving the exact historical file list for browser approval", () => bridge.proposeBackfill({ id: source.id, inspectionSha256: draft.inspectionSha256, wholeFileUploadApproved: true }))}>Request historical import approval</button>
      </div>}
    </details>}
    {jobsKnown !== undefined && <p>Showing {jobsShown} of {jobsKnown} historical jobs retained on this computer. The browser review has the authorized source history.</p>}
    {source.backfillJobsTruncated && !!source.backfillJobs?.[0] && <button className="secondary" disabled={disabled} onClick={() => external(() => bridge.openBackfillApproval({ id: source.id, jobId: source.backfillJobs![0].id }))}>View all historical jobs in browser</button>}
    {source.backfillJobsTruncated && !source.backfillJobs?.length && source.state !== "revoked" && <button className="secondary" disabled={disabled} onClick={() => external(() => bridge.openSubscriptionApproval(source.id))}>Review source history in browser</button>}
    {source.backfillJobs?.map(job => <BackfillProgress key={job.id} source={source} job={job} bridge={bridge} available={available} disabled={disabled} action={action} external={external}/>)}
  </section>;
}

function BackfillProgress({ source, job, bridge, available, disabled, action, external }: { source: SourceSubscriptionStatus; job: BackfillJob; bridge: ConnectBridge; available: boolean; disabled: boolean; action: Action; external: (operation: () => Promise<unknown>) => void }) {
  const current = source.state === "active" && job.subscriptionId === source.id && job.configurationRevision === source.configurationRevision && job.grantRevision === source.grantRevision;
  const blocked = !current || job.state === "blocked_policy" || job.state === "expired";
  const localAttention = job.localItems?.filter(item => !!item.errorCode).length ?? 0;
  const originalsShown = job.originalsShown ?? job.originals.length, originalsTotal = job.originalsTotal ?? job.progress.files.total;
  return <article className="connect-notice backfill-progress" aria-label={`Historical import from ${stamp(job.historyFrom)}`}>
    <h4>{stateLabels[job.state]}</h4><p>{stamp(job.historyFrom)} to {stamp(job.historyTo)} · {job.semantics === "cumulative_snapshot" ? "Cumulative source snapshots" : "Source events or changes"}</p>
    {job.state === "completed" && <p>Processing finished for this file list. File receipts requiring attention: {job.progress.files.failed}. Rows needing association or review: {job.progress.rows.acceptedUnlinked + job.progress.rows.conflict + job.progress.rows.quarantined + job.progress.rows.rejected}.</p>}
    {job.approvalExpiresAt && <p>Approval expires {stamp(job.approvalExpiresAt)}.</p>}
    {(blocked || job.blockReason || job.lastErrorCode) && <p role="status">{job.blockReason || (current ? "Historical collection needs current approval. Retained originals and receipts are preserved." : "The source approval changed or was revoked. This job cannot run under a different source revision or grant.")}{job.lastErrorCode ? ` ${job.lastErrorCode.replaceAll("_", " ").toLowerCase()}.` : ""}</p>}
    {localAttention > 0 && <p role="status">Displayed originals needing local collection review: {localAttention}. Open the historical file receipts below for each retained error.</p>}
    {(job.originalsTruncated || originalsShown < originalsTotal) && <p role="status">Showing {originalsShown} of {originalsTotal} original file receipts; full manifest in browser.</p>}
    <dl className="connect-facts"><div><dt>Files received</dt><dd>{job.progress.files.received} of {job.progress.files.total}</dd></div><div><dt>Awaiting upload</dt><dd>{job.progress.files.pending}</dd></div><div><dt>Files processing</dt><dd>{job.progress.files.processing}</dd></div><div><dt>Successful file receipts</dt><dd>{job.progress.files.succeeded}</dd></div><div><dt>Files requiring attention</dt><dd>{job.progress.files.failed}</dd></div><div><dt>Rows received</dt><dd>{job.progress.receivedRows}</dd></div></dl>
    <p>Each received row has one outcome. File completion and successful business association are separate.</p>
    <dl className="connect-facts">{Object.entries(rowLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{job.progress.rows[key as keyof typeof rowLabels]}</dd></div>)}</dl>
    <div className="connect-actions">
      <button className="secondary" disabled={disabled} onClick={() => external(() => bridge.openBackfillApproval({ id: source.id, jobId: job.id }))}>{current && ["proposed", "paused", "expired", "blocked_policy"].includes(job.state) ? "Review historical import in browser" : "View retained historical job in browser"}</button>
      {current && available && !blocked && job.state === "approved" && !job.localPaused && job.capabilities.collect && <button className="secondary" disabled={disabled} onClick={() => void action("Pausing this historical import on this computer", () => bridge.pauseBackfill({ id: source.id, jobId: job.id }))}>Pause historical import</button>}
      {current && available && !blocked && job.state === "approved" && job.localPaused && job.capabilities.collect && <button className="secondary" disabled={disabled || source.localPaused} onClick={() => void action("Checking current historical import approval", () => bridge.resumeBackfill({ id: source.id, jobId: job.id }))}>Resume approved historical import</button>}
    </div>
    <details className="connect-advanced"><summary>Historical file receipts and exact approval</summary><p>Manifest SHA 256: <code>{job.manifestSha256}</code> · Configuration revision {job.configurationRevision} · Grant revision {job.grantRevision}</p><ul>{job.originals.map(original => { const localError = job.localItems?.find(item => item.itemId === original.id)?.errorCode; return <li key={original.id}>{original.name}: {original.receiptState ? original.receiptState.replaceAll("_", " ") : "Not received"}{original.batchId ? ` · Receipt ${original.batchId}` : ""}{localError ? ` · Local collection: ${localError.replaceAll("_", " ").toLowerCase()}` : ""}</li>; })}</ul></details>
  </article>;
}
