import { useEffect, useMemo, useRef, useState } from "react";
import { actionIdentity, stableRecommendation, type HomeAction } from "../../../mobile/src/experience/task-home";
import type { FulfillmentQueueItem, ProofCollectionItem } from "../api/types";
import type { LocalRecordingSummary } from "../capture-queue";
import { useBrowserOnline } from "../components/WorkstationHeader";
import { formatWhen } from "../format";
import { MobileProofRows } from "./MobileProofRows";
import { mobileHomeState, usableSavedRecording } from "./task-state";
import { recordMobileUxEvent } from "../../../mobile/src/analytics/mobile-ux-events";

export function MobileHomeScreen(props: { proofs: ProofCollectionItem[]; recordings: LocalRecordingSummary[]; queue: FulfillmentQueueItem[]; loading: boolean; recordingsLoaded: boolean; error: string | null; refreshedAt: string | null; busy: boolean; notice: string | null; selection?: string; interactions: Record<string, number>; onGo: (path: string) => void; onRetry: () => void; onAction: (action: HomeAction) => void; onOpen: (proof: ProofCollectionItem) => void }) {
  const online = useBrowserOnline();
  const [usable, setUsable] = useState<Set<string>>(new Set());
  const [interacting, setInteracting] = useState(false);
  const card = useRef<HTMLElement>(null), previous = useRef<HomeAction | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all(props.recordings.filter(row => !row.accepted && row.available).map(async row => ({ key: row.key, usable: await usableSavedRecording(row.file) }))).then(rows => { if (active) setUsable(new Set(rows.filter(row => row.usable).map(row => row.key))); });
    return () => { active = false; };
  }, [props.recordings]);
  const state = useMemo(() => mobileHomeState({ ...props, usable, online, reconciled: !!props.refreshedAt && !props.error && online }), [props.proofs, props.recordings, props.queue, props.refreshedAt, props.error, props.selection, props.interactions, usable, online]);
  const next = stableRecommendation(previous.current, state, interacting);
  const displayed = useRef("");
  useEffect(() => { previous.current = next; }, [next]);
  useEffect(() => { const key = actionIdentity(next); if (!props.loading && props.refreshedAt && displayed.current !== key) { displayed.current = key; recordMobileUxEvent("recommendation_displayed"); } }, [next, props.loading, props.refreshedAt]);
  const attentionIds = new Set(state.actions.filter(row => row.targetId).map(row => row.targetId));
  const attention = props.proofs.filter(row => attentionIds.has(row.proofId)).slice(0, 3);
  const shownAttention = new Set(attention.map(row => row.proofId));
  const recent = [...props.proofs].filter(row => !shownAttention.has(row.proofId)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 3);
  const initialLoading = !props.refreshedAt && props.loading;
  const count = (value: number) => !props.refreshedAt ? "—" : value;
  return <main className="page library-page task-stack mobile-home-page" aria-busy={initialLoading}>
    {initialLoading ? <section className="task-loading" role="status"><strong>Finding your next task…</strong><span /><span /><p>Checking Proofs and saved recordings.</p></section> : <section ref={card} className="task-next-card" aria-label="Recommended action" onFocusCapture={() => setInteracting(true)} onBlurCapture={() => { requestAnimationFrame(() => { if (!card.current?.contains(document.activeElement)) setInteracting(false); }); }} onPointerDown={() => setInteracting(true)} onPointerUp={() => { if (!card.current?.contains(document.activeElement)) setInteracting(false); }}>
      <p className="task-state-label">{next.kind === "create_proof" ? "Ready when you are" : next.sourceFreshness === "device" ? "Saved on this device" : "Your next task"}</p><h1>{!props.refreshedAt && props.error ? "Check your workspace" : next.title}</h1><p>{!props.refreshedAt && props.error ? "Your current Proofs could not be checked. Retry or start a new manual Proof when connected." : next.reason}</p>
      <button className="btn" disabled={props.busy} onClick={() => { if (!props.refreshedAt && props.error) props.onRetry(); else { recordMobileUxEvent("recommendation_selected"); props.onAction(next); } }}>{props.busy ? "Checking task…" : !props.refreshedAt && props.error ? "Retry workspace" : next.buttonLabel}</button>
      {(next.kind !== "create_proof" || !props.refreshedAt && !!props.error) && <button className="text-link" onClick={() => props.onGo("/new")}>Create Proof</button>}
      {next.count > 1 && <p>{next.count} similar tasks available below.</p>}
    </section>}
    {initialLoading && <button className="btn btn-secondary" onClick={() => props.onGo("/new")}>Create Proof</button>}
    {(props.notice || !online || props.error) && <div className="task-notice" role={props.error ? "alert" : "status"}>{props.notice && <p>{props.notice}</p>}{!online && <p>Offline. Saved work remains on this device. Creating a Proof needs a connection.</p>}{props.error && <p>{props.error}</p>}{props.refreshedAt && (props.error || !online) && <p>Last checked {formatWhen(props.refreshedAt)}. Cached completion is not a new verification.</p>}{props.error && <button className="text-link" onClick={props.onRetry}>Retry refresh</button>}</div>}
    <section className="task-summary" aria-label="Workspace summary"><button onClick={() => props.onGo("/proofs?filter=attention")}><strong>{count(state.counts.attention)}</strong><span>Needs attention</span></button><button onClick={() => props.onGo("/activity?view=uploads")}><strong>{props.recordingsLoaded ? state.counts.uploading : "—"}</strong><span>Uploading jobs</span></button><button onClick={() => props.onGo("/proofs?filter=completed")}><strong>{count(state.counts.completed)}</strong><span>Completed</span><small>All time</small></button></section>
    {state.counts.waiting > 0 && <button className="text-link" onClick={() => props.onGo("/activity?view=uploads")}>{state.counts.waiting} {online ? "waiting upload jobs" : "jobs waiting for connection"}</button>}
    {attention.length > 0 && <section className="task-stack"><div className="task-section-heading"><h2>Needs attention</h2><button className="text-link" onClick={() => props.onGo("/proofs?filter=attention")}>View all</button></div><MobileProofRows proofs={attention} busy={props.busy} onOpen={props.onOpen} /></section>}
    {recent.length > 0 && <section className="task-stack"><div className="task-section-heading"><h2>Recent Proofs</h2><button className="text-link" onClick={() => props.onGo("/proofs?filter=all")}>View all</button></div><MobileProofRows proofs={recent} busy={props.busy} onOpen={props.onOpen} /></section>}
    <span className="visually-hidden" data-recommendation={actionIdentity(next)}>{props.loading && props.refreshedAt ? "Refreshing workspace" : ""}</span>
  </main>;
}
