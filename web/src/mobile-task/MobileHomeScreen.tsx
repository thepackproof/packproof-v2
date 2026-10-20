import {useSignalReceipt} from '../signal/useSignalReceipt';
import {RecordThumbnail} from '../components/RecordThumbnail';
import type {PackProofApi} from '../api/client';
import { SignalParcel, SignalBadge } from '../signal/Signal';
import { useEffect, useMemo, useRef, useState } from "react";
import { actionIdentity, stableRecommendation, type HomeAction } from "../../../mobile/src/experience/task-home";
import type { FulfillmentQueueItem, ProofCollectionItem } from "../api/types";
import type { LocalRecordingSummary } from "../capture-queue";
import { useBrowserOnline } from "../components/WorkstationHeader";
import { formatWhen } from "../format";
import { MobileProofRows } from "./MobileProofRows";
import { mobileHomeState, usableSavedRecording } from "./task-state";
import { recordMobileUxEvent } from "../../../mobile/src/analytics/mobile-ux-events";

export function MobileHomeScreen(props: { api?:PackProofApi; firstExperience?: boolean; experience?: { status: string }; reconciled?: boolean; proofs: ProofCollectionItem[]; recordings: LocalRecordingSummary[]; queue: FulfillmentQueueItem[]; loading: boolean; recordingsLoaded: boolean; error: string | null; refreshedAt: string | null; busy: boolean; notice: string | null; selection?: string; interactions: Record<string, number>; onGo: (path: string) => void; onRetry: () => void; onAction: (action: HomeAction) => void; onOpen: (proof: ProofCollectionItem) => void }) {
  const online = useBrowserOnline();
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
  const pendingRecording=props.recordings.find(row=>!row.finalized&&!row.submitted&&row.accepted);
  const saved=props.proofs.find(row=>row.presentation?.completed);
  const featured=props.proofs.find(row=>row.proofId===pendingRecording?.proofId)||saved;
  const mode=pendingRecording?(!online||pendingRecording.errorMessage?'paused':'uploading'):saved?'saved':'default';
  const confirmed=useSignalReceipt(props.api,saved?.proofId||'',saved?.updatedAt||'',!!saved);
  const savedConfirmed=confirmed||!!saved&&props.recordings.some(row=>row.proofId===saved.proofId&&row.finalized&&row.preserved);

  return <main className="page library-page mobile-home-page" aria-busy={initialLoading}>
    <div className="signal-home-grid"><section className="signal-home-primary">
      {mode!=='default'&&featured?<><div className="signal-home-intro"><p className="signal-mono">{mode==='paused'?'ONE THING NEEDS YOUR ATTENTION.':mode==='uploading'?"WE’LL KEEP THINGS MOVING.":'A CLEAR RECORD. A CONFIDENT SEND.'}</p><h1 className="signal-display">{mode==='paused'?<>Let’s finish<br/>this Proof.</>:mode==='uploading'?<>Carry on.<br/>We’re saving.</>:<>Ready for<br/>the next one?</>}</h1><p>{mode==='paused'?'Your recording is safe in this browser.':mode==='uploading'?'You can keep using PackProof.':'Your last shipment has a record.'}</p></div>{mode==='saved'&&<button className="btn" onClick={()=>props.onGo('/new')}>Pack an item →</button>}<div className="signal-featured-record"><SignalBadge state={mode==='saved'&&savedConfirmed?'saved':mode==='uploading'?'uploading':'local'}>{mode==='saved'?(savedConfirmed?'Saved to PackProof':'Proof finalized'):mode==='paused'?'Upload paused':'Saving in progress'}</SignalBadge>{mode==='saved'?<SignalParcel sealed/>:<RecordThumbnail api={props.api} proofId={featured.proofId} derivativeId={featured.thumbnailDerivativeId}/>}<h2>{featured.transaction.itemTitle||'Packing record'}</h2><p>{featured.transaction.externalReference||featured.proofId}</p><button className="btn btn-tertiary" onClick={()=>mode==='saved'?props.onOpen(featured):props.onGo(`/proofs/${encodeURIComponent(featured.proofId)}/capture`)}>{mode==='saved'?'View your Proof':'View upload progress'} →</button></div>{mode!=='saved'&&<button className="btn" disabled={props.busy} onClick={()=>mode==='paused'?props.onGo(`/proofs/${encodeURIComponent(featured.proofId)}/capture`):props.onGo('/new')}>{mode==='paused'?'Resume upload':'Pack another item'} →</button>}</>:<><div className="signal-home-intro"><p className="signal-mono">A CLEAR RECORD. A CONFIDENT SEND.</p><h1 className="signal-display">Pack it.<br/>Keep the proof.</h1><p>Record how you pack. Keep what matters.</p></div><SignalParcel/><button className="btn" disabled={props.busy} onClick={()=>props.onGo('/new')}>Pack an item <span aria-hidden="true">→</span></button></>}
    </section><section className="signal-home-records" ref={card} aria-label="Your records" onFocusCapture={()=>setInteracting(true)} onBlurCapture={()=>setInteracting(false)}>
      <div className="signal-section-title"><h2>{next.kind==='create_proof'?'Your records':'Ready when you are'}</h2><span>{String(state.counts.waiting+state.counts.uploading).padStart(2,'0')}</span></div>
      {initialLoading && <p role="status">Checking your records…</p>}
      {next.kind !== 'create_proof' && <button className="signal-proof-row" disabled={props.busy} onClick={()=>{recordMobileUxEvent('recommendation_selected');props.onAction(next);}}><span aria-hidden="true">↗</span><span className="signal-row-copy"><strong>{next.title}</strong><small>{next.reason}</small><SignalBadge state={next.kind==='review_upload'?'uploading':'local'}>{next.buttonLabel}</SignalBadge></span><img src="/signal/chevron.svg" alt=""/></button>}
      {attention.length>0 ? <MobileProofRows api={props.api} proofs={attention} busy={props.busy} onOpen={props.onOpen}/> : !initialLoading && next.kind==='create_proof' && <p>Your recordings and saved Proofs will appear here. Start with the item you’re packing.</p>}
      <button className="btn btn-tertiary" onClick={()=>props.onGo('/proofs')}>View all Proofs <span aria-hidden="true">→</span></button>
      {(props.notice||!online||props.error)&&<div className="task-notice" role={props.error?'alert':'status'}>{props.notice&&<p>{props.notice}</p>}{!online&&<p>Offline. Saved work remains on this device. Connect to create a Proof.</p>}{props.error&&<><p>{props.error}</p><button className="text-link" onClick={props.onRetry}>Retry refresh</button></>}{props.refreshedAt&&(props.error||!online)&&<p>Last checked {formatWhen(props.refreshedAt)}.</p>}</div>}
      <span className="visually-hidden" data-recommendation={actionIdentity(next)}>{props.loading&&props.refreshedAt?'Refreshing workspace':''}</span>
    </section></div>
  </main>;
}
