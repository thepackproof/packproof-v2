import {useSignalReceipt} from '../signal/useSignalReceipt';
import {RecordThumbnail} from '../components/RecordThumbnail';
import type {PackProofApi} from '../api/client';
import { SignalBadge } from '../signal/Signal';
import { EvidenceSources } from '../signal/EvidenceSources';
import { useEffect, useMemo, useRef, useState } from "react";
import { actionIdentity, stableRecommendation, type HomeAction } from "../../../mobile/src/experience/task-home";
import type { FulfillmentQueueItem, ProofCollectionItem } from "../api/types";
import type { LocalRecordingSummary } from "../capture-queue";
import { useBrowserOnline } from "../components/WorkstationHeader";
import { formatWhen } from "../format";
import { MobileProofRows } from "./MobileProofRows";
import { mobileHomeState, usableSavedRecording } from "./task-state";
import { recordMobileUxEvent } from "../../../mobile/src/analytics/mobile-ux-events";

const assembledAccounts = new WeakSet<PackProofApi>();
export function MobileHomeScreen(props: { api?:PackProofApi; firstExperience?: boolean; experience?: { status: string }; reconciled?: boolean; proofs: ProofCollectionItem[]; recordings: LocalRecordingSummary[]; queue: FulfillmentQueueItem[]; loading: boolean; recordingsLoaded: boolean; error: string | null; refreshedAt: string | null; busy: boolean; notice: string | null; selection?: string; interactions: Record<string, number>; onGo: (path: string) => void; onRetry: () => void; onAction: (action: HomeAction) => void; onOpen: (proof: ProofCollectionItem) => void }) {
  const online = useBrowserOnline();
  const [assemble] = useState(() => !props.api || !assembledAccounts.has(props.api));
  useEffect(() => { if (props.api) assembledAccounts.add(props.api); }, [props.api]);
  const [usable, setUsable] = useState<Set<string>>(new Set());
  const [interacting, setInteracting] = useState(false);
  const card = useRef<HTMLElement>(null), previous = useRef<HomeAction | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all(props.recordings.filter(row => !row.accepted && row.available).map(async row => ({ key: row.key, usable: await usableSavedRecording(row.file) }))).then(rows => { if (active) setUsable(new Set(rows.filter(row => row.usable).map(row => row.key))); });
    return () => { active = false; };
  }, [props.recordings]);
  const state = useMemo(() => mobileHomeState({ ...props, usable, online, reconciled: !!props.refreshedAt && !props.error && online && (!props.firstExperience || props.reconciled === true && props.recordingsLoaded) }), [props.proofs, props.recordings, props.queue, props.refreshedAt, props.error, props.selection, props.interactions, usable, online, props.reconciled, props.recordingsLoaded, props.firstExperience]);
  const next = stableRecommendation(previous.current, state, interacting);
  const displayed = useRef("");
  useEffect(() => { previous.current = next; }, [next]);
  useEffect(() => { const key = actionIdentity(next); if (!props.loading && props.refreshedAt && displayed.current !== key) { displayed.current = key; recordMobileUxEvent("recommendation_displayed"); } }, [next, props.loading, props.refreshedAt]);
  const attention = props.proofs.filter(row => row.proofId !== next.targetId).slice(0, 3);
  const initialLoading = !props.refreshedAt && props.loading;
  const urgent = next.kind !== "create_proof";
  const pendingRecording=props.recordings.find(row=>!row.finalized&&!row.submitted&&row.accepted&&(!urgent||row.proofId===next.targetId&&(!next.sessionId||row.key===next.sessionId)));
  const saved=props.proofs.find(row=>row.presentation?.completed);
  const featured=pendingRecording ? props.proofs.find(row=>row.proofId===pendingRecording.proofId) : props.proofs.find(row=>row.proofId===next.targetId)||saved;
  const mode=pendingRecording?(!online||pendingRecording.retryStopped||pendingRecording.interrupted?'paused':'uploading'):saved&&featured?.proofId===saved.proofId?'saved':'default';
  const confirmed=useSignalReceipt(props.api,saved?.proofId||'',saved?.updatedAt||'',!!saved);
  const savedConfirmed=confirmed;

  const primary = () => {
    if (next.kind !== 'create_proof') {
      recordMobileUxEvent('recommendation_selected'); props.onAction(next);
    } else if (mode === 'paused' && featured) {
      props.onGo(`/proofs/${encodeURIComponent(featured.proofId)}/capture`);
    } else props.onGo('/new');
  };
  const primaryLabel = next.kind !== 'create_proof' ? next.buttonLabel : mode === 'paused' && featured ? 'Resume upload' : 'Pack an item';
  return <main className={`page library-page mobile-home-page eim-home${assemble ? " eim-home-assemble" : ""}`} aria-busy={initialLoading}>
    <header className="eim-home-heading"><div><p className="signal-mono">PACKPROOF WORKSPACE</p><h1 className="signal-display">{mode==='paused'?<>Let's finish<br/>this Proof.</>:mode==='uploading'?<>Carry on.<br/>We're saving.</>:mode==='saved'?<>Ready for<br/>the next one?</>:<>Pack it.<br/>Keep the proof.</>}</h1></div><p>{mode==='paused'?(pendingRecording?.available?'Your recording is kept in this browser. Review what needs attention to continue.':'Your upload needs attention. Open the record to review the available recovery options.'):mode==='uploading'?'Your upload keeps its place while you use PackProof.':mode==='saved'?'Find your last record, or start the next packing journey.':'Record how you pack. Keep what matters.'}</p></header>
    <div className="signal-home-grid">
      <section className="signal-home-primary" ref={card} aria-label="Your next task" onFocusCapture={()=>setInteracting(true)} onBlurCapture={()=>setInteracting(false)}>
        <EvidenceSources proof={featured} hasLocalRecording={!!pendingRecording?.available} confirmed={savedConfirmed&&mode==='saved'&&featured?.proofId===saved?.proofId}/>
        <div className="eim-next-action"><div><p className="signal-mono">{mode==='uploading'?(pendingRecording?.committed?'CONFIRMING':pendingRecording?.active?'UPLOAD IN PROGRESS':'QUEUED FOR UPLOAD'):next.kind==='create_proof'?'READY WHEN YOU ARE':'YOUR NEXT ACTION'}</p>{(next.kind!=='create_proof'||pendingRecording)&&<h2>{pendingRecording&&featured?featured.transaction.itemTitle||'Packing record':next.title}</h2>}<p>{mode==='uploading'?'Actual upload and confirmation details are available from your record.':next.reason}</p></div>
          {mode==='uploading' && !urgent && featured ? <button className="btn" disabled={props.busy} onClick={()=>props.onGo(`/proofs/${encodeURIComponent(featured.proofId)}/capture`)}>View upload progress <span aria-hidden="true">→</span></button> : <button className="btn" disabled={props.busy} onClick={primary}>{primaryLabel}<span aria-hidden="true">→</span></button>}
          {mode!=='uploading'&&next.kind!=='create_proof'&&<button className="btn btn-tertiary" disabled={props.busy} onClick={()=>props.onGo('/new')}>Pack an item</button>}
          {mode==='uploading'&&<button className="btn btn-tertiary" disabled={props.busy} onClick={()=>props.onGo('/new')}>Pack another item</button>}
        </div>
        {(props.notice||!online||props.error)&&<div className="task-notice" role={props.error?'alert':'status'}>{props.notice&&<p>{props.notice}</p>}{!online&&<p>Offline. Saved work remains on this device. Connect to create a Proof.</p>}{props.error&&<><p>{props.error}</p><button className="text-link" onClick={props.onRetry}>Retry refresh</button></>}{props.refreshedAt&&(props.error||!online)&&<p>Last checked {formatWhen(props.refreshedAt)}.</p>}</div>}
      </section>
      <section className="signal-home-records" aria-label="Your records">
        <div className="signal-section-title"><h2>Your records</h2><button className="text-link" onClick={()=>props.onGo('/proofs')}>View all Proofs <span aria-hidden="true">→</span></button></div>
        {initialLoading && <p role="status">Checking your records…</p>}
        {mode!=='default' && featured && <article className="signal-featured-record"><div><SignalBadge state={mode==='saved'&&savedConfirmed?'saved':mode==='uploading'?'uploading':mode==='paused'?'attention':'local'}>{mode==='saved'?(savedConfirmed?'Saved to PackProof':'Proof finalized'):mode==='paused'?'Upload paused':pendingRecording?.committed?'Confirming':pendingRecording?.active?'Uploading recording':'Queued for upload'}</SignalBadge><h2>{featured.transaction.itemTitle||'Packing record'}</h2><p>{featured.transaction.externalReference||featured.proofId}</p></div><RecordThumbnail api={props.api} proofId={featured.proofId} derivativeId={featured.thumbnailDerivativeId}/><button className="btn btn-secondary" onClick={()=>mode==='saved'?props.onOpen(featured):props.onGo(`/proofs/${encodeURIComponent(featured.proofId)}/capture`)}>{mode==='saved'?'View your Proof':'View upload progress'} <span aria-hidden="true">→</span></button></article>}
        {attention.length>0 ? <MobileProofRows api={props.api} proofs={attention.filter(row=>row.proofId!==featured?.proofId)} busy={props.busy} onOpen={props.onOpen}/> : !initialLoading && mode==='default' && <div className="eim-empty-records"><span aria-hidden="true">▤</span><h2>A clear place for your evidence.</h2><p>Your recordings and saved Proofs will appear here. Start with the item you're packing.</p></div>}
        <p className="eim-record-limitation">PackProof preserves submitted evidence. It does not decide the outcome of a dispute.</p>
      </section>
    </div>
    <span className="visually-hidden" data-recommendation={actionIdentity(next)}>{props.loading&&props.refreshedAt?'Refreshing workspace':''}</span>
  </main>;
}
