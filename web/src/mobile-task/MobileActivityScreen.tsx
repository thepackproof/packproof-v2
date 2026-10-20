import {SIGNAL_ENABLED,SignalBadge} from '../signal/Signal';
import {useSignalReceipt} from '../signal/useSignalReceipt';
import type {ProofCollectionItem} from '../api/types';
import { useEffect, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
import type { InvitationInboxView } from "../api/types";
import { listRecoverableRecordings, resumeLocalRecording, type LocalRecordingSummary } from "../capture-queue";
import { useBrowserOnline } from "../components/WorkstationHeader";
import { NotificationCenter } from "../components/NotificationCenter";
import { recordMobileUxEvent } from "../../../mobile/src/analytics/mobile-ux-events";

export function MobileActivityScreen(props: { proofs?:ProofCollectionItem[]; api: PackProofApi; userId: string; recordings: LocalRecordingSummary[]; recordingsLoaded: boolean; invitations: InvitationInboxView[]; error: string | null; onRefresh: () => void; onChange: (rows: LocalRecordingSummary[]) => void; onOpen: (id: string, recording?: LocalRecordingSummary) => void; onInvitation: (id: string) => void; onCreate: () => void }) {
  const online = useBrowserOnline();
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const completed = (row: LocalRecordingSummary) => row.finalized && row.preserved || row.submitted;
  const needsAction = (row: LocalRecordingSummary) => !completed(row) && (!row.accepted || row.retryStopped || row.errorMessage && !row.retryScheduled);
  const groups = [
    { title: "Needs your attention", rows: props.recordings.filter(needsAction) },
    { title: "In progress", rows: props.recordings.filter(row => !completed(row) && !needsAction(row)) },
    { title: "Completed events", rows: props.recordings.filter(completed) },
  ];
  async function retry(row: LocalRecordingSummary) {
    if (pending.current || !online) return;
    pending.current = true; setBusy(row.key); setError(null);
    recordMobileUxEvent("upload_recovery");
    try {
      const latest = (await listRecoverableRecordings(props.userId, props.api)).find(item => item.key === row.key);
      if (!latest) throw new Error("This recording changed. Refresh Activity to see its current state.");
      await resumeLocalRecording(props.api, props.userId, latest);
      if (mounted.current) props.onChange(await listRecoverableRecordings(props.userId, props.api));
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "Upload recovery could not finish. Your recording was kept."); }
    finally { pending.current = false; if (mounted.current) setBusy(null); }
  }
  if(SIGNAL_ENABLED)return <main className="page task-stack mobile-activity-page"><span className="signal-mono">THE LATEST ON YOUR RECORDS.</span><div className="task-section-heading"><h1>Activity</h1><button className="btn btn-tertiary" onClick={props.onRefresh}>Refresh</button></div>{(props.error||error)&&<p className="signal-note" role="alert">{error||props.error}</p>}{!props.recordingsLoaded&&<p role="status">Checking saved recordings…</p>}<section className="signal-activity-feed" aria-label="Recording updates">{props.recordings.map(row=><SignalActivityRow key={row.key} row={row} api={props.api} proof={props.proofs?.find(proof=>proof.proofId===row.proofId)} online={online} busy={!!busy} onOpen={()=>props.onOpen(row.proofId,row)} onRetry={()=>void retry(row)}/>)}{props.recordingsLoaded&&!props.recordings.length&&<p>Your recording updates will appear here.</p>}</section>{props.invitations.length>0&&<section><h2>Invitations</h2>{props.invitations.map(invitation=><button key={invitation.invitationId} className="btn btn-secondary" onClick={()=>props.onInvitation(invitation.invitationId)}>{invitation.transaction.itemTitle||'Review invitation'}</button>)}</section>}<details className="settings-detail"><summary>Proof updates</summary><NotificationCenter api={props.api} onOpen={props.onOpen}/></details><p className="signal-note">Every event stays with its Proof.</p></main>;
  return <main className="page task-stack mobile-activity-page"><div className="task-section-heading"><h1 className="page-title">Activity</h1><button className="text-link" onClick={props.onRefresh}>Refresh</button></div>
    {(props.error || error) && <p className="task-notice" role="alert">{error || props.error}</p>}
    {!props.recordingsLoaded && <p role="status">Checking saved recordings…</p>}
    {props.recordingsLoaded && props.recordings.length === 0 && <section className="task-notice"><h2>No upload jobs</h2><p>Saved recordings and upload recovery from this browser appear here.</p><button className="btn btn-secondary" onClick={props.onCreate}>Create Proof</button></section>}
    {groups.filter(group => group.rows.length > 0).map(group => <section className="task-activity-group" key={group.title} aria-label={group.title}><h2>{group.title}</h2>{group.rows.map(row => {
      const stage = row.finalized && row.preserved ? "Proof finalized" : row.submitted ? "Submission confirmed" : row.committed || row.preserved ? "Evidence committed · finalization pending" : !row.accepted ? row.available ? "Evidence saved on device · review needed" : "Recording recovery needed" : !online ? "Waiting for connection" : row.active ? "Uploading" : row.retryStopped || row.errorMessage && !row.retryScheduled ? "Upload needs attention" : "Waiting to upload";
      return <article className="task-activity-row" key={row.key}><h3>{stage}</h3><p>{row.kind === "stage" ? "Receipt or return recording" : "Packing recording"} · {((row.file?.size || 0) / 1_000_000).toFixed(1)} MB</p>{row.errorMessage && <p>{row.errorMessage}</p>}<div className="task-activity-actions"><button className="btn btn-secondary" disabled={!!busy} onClick={() => props.onOpen(row.proofId, row)}>{!row.accepted && row.available ? "Review evidence" : "View Proof"}</button>{row.accepted && !row.active && !completed(row) && <button className="btn" disabled={!!busy || !online} onClick={() => void retry(row)}>{busy === row.key ? "Recovering…" : row.committed ? "Retry confirmation" : "Retry upload"}</button>}</div>{!row.accepted && row.available && !online && <p>Saved locally. Connect to revalidate the Proof and continue its review.</p>}</article>;
    })}</section>)}
    {props.invitations.length > 0 && <section className="task-activity-group"><h2>Invitations</h2>{props.invitations.map(invitation => <article className="task-activity-row" key={invitation.invitationId}><h3>{invitation.transaction.itemTitle || "Proof invitation"}</h3><button className="btn btn-secondary" onClick={() => props.onInvitation(invitation.invitationId)}>Review invitation</button></article>)}</section>}
    <details className="settings-detail"><summary>Notifications</summary><NotificationCenter api={props.api} onOpen={props.onOpen} /></details>
    <p className="note">Local recordings stay associated with this account. Keep this browser’s data until preservation is confirmed.</p>
  </main>;
}

function SignalActivityRow({row,api,proof,online,busy,onOpen,onRetry}:{row:LocalRecordingSummary;api:PackProofApi;proof?:ProofCollectionItem;online:boolean;busy:boolean;onOpen:()=>void;onRetry:()=>void}){
 const confirmed=useSignalReceipt(api,row.proofId,proof?.updatedAt||row.key,!!(row.finalized&&row.preserved));
 const paused=row.accepted&&!confirmed&&(!online||row.retryStopped||!!row.errorMessage&&!row.retryScheduled);
 const title=confirmed?'Proof saved to PackProof':row.submitted?'Recording received':row.interrupted?'Recording interrupted · retained':!row.accepted?'Recording saved on this device':paused?'Upload paused':row.committed?'Confirming your Proof':row.active?'Uploading recording':'Waiting to upload';
 return <article className="signal-activity-event"><span className="signal-event-icon" aria-hidden="true">{confirmed?'✓':row.active?'↑':'◷'}</span><div><button className="signal-event-title" disabled={busy} onClick={onOpen}>{title}</button><p>{proof?.transaction.itemTitle||row.label||'Packing recording'}</p><SignalBadge state={confirmed?'saved':row.active?'uploading':'local'}>{confirmed?'Saved to PackProof':paused?'Your recording is retained':row.proofId}</SignalBadge>{row.updatedAt&&<time className="signal-mono" dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleString()}</time>}{row.errorMessage&&<p>{row.errorMessage}</p>}{paused&&row.accepted&&!row.active&&<button className="btn btn-secondary" disabled={busy||!online} onClick={onRetry}>Resume upload</button>}</div></article>;
}
