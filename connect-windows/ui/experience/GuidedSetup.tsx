import { useCallback, useEffect, useRef, useState } from "react";
import type { FacilityDraft, FacilityInputs } from "../guided-workflow-types";
import type { ConnectStatus } from "../types";
import type { DraftPreview, WorkspaceStep } from "../workspace-types";
import { GuidedSources } from "./GuidedSources";
import { PreviewCorrections } from "./PreviewCorrections";
import { eventFacts, RuleImpact } from "./RuleImpact";
import { dateLabel } from "./ProofModel";
import type { ManualReview } from "./SetupAssistant";
import type { SetupProps } from "./Setup";
import { Context, kindNames, Row, SetupDialog, sourceName } from "./SetupParts";
import { exampleKinds, exampleNames, ExpectationEditor, WorkflowEditor } from "./WorkflowEditor";

type Page = "learn" | "sources" | "review" | "activate";
const pages: Page[] = ["learn", "sources", "review", "activate"];
const labels = { learn: "Choose order", sources: "Find records", review: "Review Proof", activate: "Activate" };
const savedSteps: Record<Page, WorkspaceStep> = { learn: "order", sources: "packing", review: "review", activate: "output" };
function resume(step: WorkspaceStep): Page {
  if (step === "order") return "learn";
  if (step === "review") return "review";
  if (step === "output" || step === "activate" || step === "overview") return "activate";
  return "sources";
}
function inputs(d: FacilityInputs): FacilityInputs {
  return { steps: d.steps, examples: d.examples, rules: d.rules, excludedSourceIds: d.excludedSourceIds, timing: d.timing ?? [],
    packing: d.packing ?? [], recordEdits: d.recordEdits ?? [] };
}
function failure(e: unknown) { return e instanceof Error ? e.message : "The request could not be completed. Try again."; }

export function GuidedSetup({ status, bridge, onStatus, onSample, onOpenDraftProof, onComplete, onBusyChange }: SetupProps) {
  const ws = status.workspace!;
  const offline = ws.offlineDraftOnly === true;
  const [page, setPage] = useState<Page>(() => offline ? "learn" : resume(ws.step));
  const [draft, setDraft] = useState<FacilityDraft | null>(null);
  const [edits, setEdits] = useState<FacilityInputs | null>(null);
  const [previous, setPrevious] = useState<FacilityInputs | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [help, setHelp] = useState(false);
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [impact,setImpact]=useState<{previous:DraftPreview;current:DraftPreview;sourceId:string}|null>(null);
  const [inspected,setInspected]=useState<DraftPreview["examples"][number]["events"][number]|null>(null);
  const [loadAttempt, retryLoad] = useState(0);
  const [saved, setSaved] = useState(false);
  const current = useRef(draft), pending = useRef(edits), saving = useRef<Promise<FacilityDraft> | null>(null);
  const alive = useRef(true), working = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const manualReview = useRef<ManualReview | null>(null);
  const blocked = ["revoked", "permission_required"].includes(status.state);
  const active = ws.phase === "active" && ws.step === "overview";
  const awaiting = ws.phase === "awaiting_approval" && (!ws.expiresAt || Date.parse(ws.expiresAt) > Date.now());
  const outputReady = ws.outputState === "ready";
  const sources = ws.sources.filter(s => s.roles.length > 0);
  const value = edits ?? draft;
  function install(fresh: FacilityDraft) {
    current.current = fresh;
    if (alive.current) setDraft(fresh);
  }
  useEffect(() => {
    alive.current = true;
    const showHelp = () => setHelp(true);
    window.addEventListener("packproof-setup-help", showHelp);
    return () => { alive.current = false; window.removeEventListener("packproof-setup-help", showHelp); };
  }, []);
  useEffect(() => {
    let valid = true;
    if (blocked) {
      current.current = null; pending.current = null;
      setDraft(null); setEdits(null); setPrevious(null); setPreview(null);
    }
    if (!blocked && bridge.getFacilityDraft) {
      bridge.getFacilityDraft().then(d => {
        if (!valid) return;
        install(d); pending.current = null; setEdits(null); setPrevious(null); setImpact(null);setInspected(null);setPreview(null);setError("");
      }).catch(e => { if (valid) setError(failure(e)); });
    }
    return () => { valid = false; };
  }, [bridge, blocked, loadAttempt, offline]);
  useEffect(() => { heading.current?.focus(); }, [page, active]);
  useEffect(() => { if (awaiting) setPage("activate"); }, [awaiting]);

  const flush = useCallback(async (): Promise<FacilityDraft> => {
    while (saving.current) await saving.current;
    if (!current.current) throw Error("Reconnect this installation to edit setup.");
    const batch = pending.current;
    if (!batch) return current.current;
    const base = current.current;
    const save = offline || base.notesOnly
      ? bridge.saveFacilityNotes?.(base.revision, { steps: batch.steps, examples: batch.examples })
      : bridge.saveFacilityDraft?.(base.revision, batch);
    if (!save) throw Error("Update this installation to save the facility workflow.");
    const request = save.then(next => {
      if (alive.current && current.current === base) {
        install(next);
        if (pending.current === batch) { pending.current = null; setEdits(null); setSaved(true); }
        setError("");
      }
      return next;
    });
    saving.current = request;
    try { return await request; } finally { if (saving.current === request) saving.current = null; }
  }, [bridge, offline]);
  useEffect(() => {
    if (!edits || blocked) return;
    const timer = window.setTimeout(() => { void flush().catch(e => alive.current && setError(failure(e))); }, 700);
    return () => window.clearTimeout(timer);
  }, [edits, blocked, flush]);
  function edit(change: Partial<FacilityInputs>, remember = true) {
    const before = pending.current ?? current.current;
    if (!before) return;
    const review=manualReview.current;
    if(review && remember && review.revision===current.current?.revision){
      const ruleEdit=change.rules?.find(r=>r.sourceId===review.sourceId);
      const fieldEdit=change.packing?.find(p=>p.sourceId===review.sourceId);
      const relevant=review.sourceId
        ? review.field==="Shipped At"
          ? ruleEdit && ruleEdit.shippedAt!==before.rules.find(r=>r.sourceId===review.sourceId)?.shippedAt
          : fieldEdit && JSON.stringify(fieldEdit)!==JSON.stringify(before.packing?.find(p=>p.sourceId===review.sourceId))
        : change.steps && JSON.stringify(change.steps)!==JSON.stringify(before.steps);
      if(relevant){manualReview.current=null;review.report();}
    }
    if (remember) setPrevious(inputs(before));
    const next = { ...inputs(before), ...change };
    pending.current = next; setEdits(next); setPreview(null); setImpact(null); setError(""); setSaved(false);
  }
  async function run(fn: () => Promise<void>) {
    if (working.current || blocked) return;
    working.current = true; setBusy(true); onBusyChange?.(true); setError("");
    try { await fn(); } catch (e) { if (alive.current) setError(failure(e)); }
    finally { working.current = false; onBusyChange?.(false); if (alive.current) setBusy(false); }
  }
  function accept(s: ConnectStatus) {
    if (!alive.current) return;
    onStatus(s);
    if (s.error) throw Error(s.error.message);
  }
  function move(to: Page) {
    void run(async () => { await flush(); accept(await bridge.saveWorkspaceStep(savedSteps[to])); if (alive.current) setPage(to); });
  }
  function sourceOperation(action: () => Promise<ConnectStatus>) {
    void run(async () => {
      await flush(); accept(await action()); if (!alive.current) return;
      setPreview(null); setPrevious(null); install(await bridge.getFacilityDraft!());
    });
  }
  function testRules() {
    void run(async () => {
      const d = await flush();
      install(await bridge.replayFacilityDraft!(d.revision));
    });
  }
  const signature = JSON.stringify([ws.outputFolder, ws.outputState, sources.map(s => [s.id,s.generation,s.state,s.recognition.profileVersion])]);
  useEffect(() => { setPreview(null); setImpact(null);setInspected(null); }, [signature]);
  const changedSource=value && previous && sources.find(s=>["packing","rules"].some(key=>{
    const field=key as "packing"|"rules";
    return JSON.stringify(value[field]?.find(r=>r.sourceId===s.id))!==JSON.stringify(previous[field]?.find(r=>r.sourceId===s.id));
  }));
  function compareSource() {
    if(!previous || !changedSource) return;
    const previousRules={rules:previous.rules,packing:previous.packing ?? []};
    void run(async()=>{
      const d=await flush(), identity={draftId:d.id,expectedRevision:d.revision};
      const before=await bridge.workspaceDraftPreview({...identity,previous:previousRules});
      const after=await bridge.workspaceDraftPreview(identity);
      if(alive.current && current.current?.revision===d.revision) setImpact({previous:before,current:after,sourceId:changedSource.id});
    });
  }
  const inputReady = !!value?.examples.some(e => e.reference.trim());
  const acceptedExamples = new Set(value?.examples.map(e => e.reference.trim()).filter(Boolean));
  const matches = preview?.examples.filter(e => [e.orderReference, ...(e.lookupReferences ?? e.packages)].some(ref => acceptedExamples.has(ref)));
  const title = active ? "Automatic updates are on." : {
    learn: "Start with an order you know.", sources: "Where can we look?",
    review: "Does this match the shipment?", activate: "Approve the facility setup.",
  }[page];
  const intro = { learn: "Think of a recent shipment. Its reference helps PackProof find the records your team already creates.",
    sources: "Choose where PackProof may look. Check what each source can tell you and set the rest up later.",
    review: "Compare a familiar order with the records your sources can support. Each event leads back to its source.",
    activate: "Choose where to save proofs, then test the exact setup before requesting approval." }[page];
  if (blocked) return <main className="pp-system-state"><h1>Sign in to continue setup</h1><p>Your facility needs a current authorization.</p></main>;
  if (!draft || !value) return <main className="pp-system-state"><h1>Facility setup</h1>
    {error || !bridge.getFacilityDraft ? <><p role="alert">{error || "This service needs a compatible Windows client."}</p>
      <button className="setup-secondary" onClick={() => retryLoad(n => n+1)}>Try again</button></> : <p role="status">Opening your saved workflow…</p>}
  </main>;
  if (offline || draft.notesOnly) return <main className="setup-experience guided-experience" aria-label="Offline facility draft">
    <div className="setup-left"><span className="setup-tag">Working offline</span><h1>Continue your warehouse draft.</h1>
      <p className="setup-lead">Record workflow steps and the orders you want to check. Source review resumes when you reconnect.</p>
      <ExpectationEditor examples={value.examples} onChange={examples => edit({examples})}/>
      <WorkflowEditor steps={value.steps} onChange={steps => edit({steps})}/>
      {previous && <button className="setup-link" onClick={() => {edit(previous,false);setPrevious(null);}}>Undo last edit</button>}
      <button className="setup-secondary" onClick={() => void run(async () => { await flush(); })}>Save draft</button>
      {saved && !edits && <p role="status">Draft saved on this installation.</p>}
      {error && <p role="alert">{error}</p>}
    </div></main>;
  if (active) return <main className="setup-experience"><div><h1>{title}</h1><p>Approved sources are connected to this installation.</p>
    <button className="setup-primary" onClick={onComplete}>Open my workspace</button></div></main>;
  return <>
    <nav className="guided-progress" aria-label="Facility setup"><strong>Facility setup</strong><ol>{pages.map((p,i) =>
      <li key={p} aria-current={p === page ? "step" : undefined}><span>{i+1}</span>{labels[p]}</li>)}</ol></nav>
    <main className="setup-experience guided-experience" aria-label="Guided facility setup">
      <div className="setup-left"><h1 ref={heading} tabIndex={-1}>{title}</h1><p className="setup-lead">{intro}</p>
      <fieldset className="guided-controls" disabled={busy || awaiting}><legend className="guided-sr">Facility configuration</legend>
        {page === "learn" && <>
          <ExpectationEditor compact examples={value.examples} onChange={examples => edit({ examples })}/>
          <details className="guided-workflow"><summary>Edit your workflow · {value.steps.length} {value.steps.length === 1 ? "step" : "steps"}</summary>
            <WorkflowEditor steps={value.steps} onChange={steps => edit({ steps })}/>
          </details>
          <div className="setup-actions">{inputReady ? <>
            <button className="setup-primary" onClick={() => move("sources")}>Find records</button>
            <button className="setup-link" onClick={onSample}>Try a sample order</button>
          </> : <button className="setup-primary" onClick={onSample}>Try a sample order</button>}</div>
        </>}
        {page === "sources" && <>
          <GuidedSources bridge={bridge} draft={draft} value={value} sources={sources} busy={busy} update={edit} run={sourceOperation}
            onManualReview={review=>{manualReview.current=review;}} editWorkflow={() => move("learn")}
            ruleComparison={sourceId=>changedSource?.id===sourceId && <>
              <button type="button" className="setup-secondary" onClick={compareSource}>Compare this rule on sample orders</button>
              {impact?.sourceId===sourceId && <RuleImpact {...impact}/>}
            </>}/>
          <div className="setup-actions"><button className="setup-primary" disabled={!sources.some(s => !value.excludedSourceIds.includes(s.id))} onClick={() => move("review")}>Review a known order</button>
            <button className="setup-link" onClick={() => move("learn")}>Back to workflow</button></div>
        </>}
        {page === "review" && <>
          <ExpectationEditor examples={value.examples} onChange={examples => edit({ examples })}/>
          <button className="setup-secondary" disabled={!inputReady} onClick={() => void run(async () => {
            await flush(); const result = await bridge.workspaceDraftPreview(); if (alive.current) setPreview(result);
          })}>Find these orders</button>
          {preview && <section className="setup-card"><h3>From your selected sources</h3>
            {matches?.length ? matches.map((order,i) => <div key={i}>
              <Row icon="order" title={order.displayReference || order.orderReference} detail={order.source}
                onClick={onOpenDraftProof ? () => onOpenDraftProof(order) : undefined}/>
              {order.cartons?.map(carton => <Row key={carton.namespace+"|"+carton.id} icon={carton.status === "delivered" ? "delivery" : "packing"}
                title={carton.id} detail={[
                  carton.status === "delivered" ? "Delivery confirmed" : "Awaiting delivery evidence",
                  carton.lastKind && (kindNames[carton.lastKind]?.[1] ?? carton.lastKind),
                  carton.occurredAt && dateLabel(carton.occurredAt),
                ].filter(Boolean).join(" · ")}/>)}
              {order.events.filter(e => e.qualifiedWeight && e.qualifiedWeightUnit).map((e,i) => <p key={i}>
                {e.entity?.id} · {e.qualifiedWeight} {e.qualifiedWeightUnit} · {e.fileName} {e.locator}
              </p>)}
              <PreviewCorrections order={order} choices={preview.examples} onEditSource={() => move("sources")} onMove={entry => edit({
                recordEdits:[...(value.recordEdits ?? []).filter(e => e.recordHash!==entry.recordHash || e.sourceId!==entry.sourceId),entry],
              })}/>
            </div>) :
              <p>No matching reference in this sample. Check the reference and the source that owns it.</p>}
            <small>{preview.scannedFiles} files sampled · {preview.unreadFiles} unread · {preview.unresolved} unresolved</small>
          </section>}
          {!!value.recordEdits?.length && <div className="setup-card"><h3>Preview changes</h3>
            {value.recordEdits.map(change=><p key={change.recordHash}>{change.fromId} → {change.toId}{" "}
              <button type="button" className="setup-link" onClick={() => edit({recordEdits:value.recordEdits?.filter(e=>e!==change)})}>Undo this correction</button></p>)}
            <small>Find these orders again to compare the corrected preview.</small>
          </div>}
          <div className="setup-actions"><button className="setup-primary" onClick={() => move("activate")}>Test and approve</button>
            <button className="setup-link" onClick={() => move("sources")}>Change sources</button></div>
        </>}
        {page === "activate" && <>
          <section className="setup-card"><h3>Local proof folder</h3><p>{ws.outputFolder || "Choose a folder outside your input locations."}</p>
            {ws.outputFolder && <p>{outputReady ? "The background service can write here." : "The destination needs attention before replay."}</p>}
            <button className="setup-secondary" onClick={() => sourceOperation(() => bridge.chooseWorkspaceOutput())}>{ws.outputFolder ? "Change folder" : "Choose proof folder"}</button>
          </section>
          <section className="setup-card"><h3>Known-order replay</h3>
            {exampleKinds.map(kind => {
              const expectation = value.examples.find(e => e.kind === kind);
              const check = !edits && draft.replay?.checks.find(c => c.kind === kind);
              return <Row key={kind} icon={check ? check.passed ? "success" : "attention" : "records"} title={exampleNames[kind]}
                detail={check ? check.message : expectation?.reference || "Add a familiar example before activation"}/>;
            })}
            {!edits && draft.replay?.checks.filter(c => !exampleKinds.some(k => k === c.kind)).map(c =>
              <Row key={c.kind} icon={c.passed ? "success" : "attention"} title="Setup check" detail={c.message}/>)}
            <button className="setup-secondary" disabled={!outputReady || !bridge.replayFacilityDraft} onClick={testRules}>Run known-order checks</button>
          </section>
          <button className="setup-link" onClick={() => move("review")}>Edit examples</button>
        </>}
        {previous && <button type="button" className="setup-link" onClick={() => { edit(previous,false); setPrevious(null); }}>Undo last edit</button>}
      </fieldset>
      {page === "activate" && <div className="setup-actions">
        <button className="setup-primary" disabled={busy || (!awaiting && (!draft.replay?.passed || !!edits || !outputReady))} onClick={() => void run(async () => {
          if (awaiting) await bridge.openWorkspaceApproval();
          else { await flush(); accept(await bridge.activateWorkspace()); }
        })}>{awaiting ? "Open browser approval" : "Request browser approval"}</button>
      </div>}
      {awaiting && <p role="status">Approval is open for this installation. This window will update when your reviewer finishes.</p>}
      {status.authorizationNotice && <p role="status">{status.authorizationNotice}</p>}
      {busy ? <p role="status">Checking your setup…</p> : saved && !edits && <small role="status">Draft saved on this installation.</small>}
      {error && <div role="alert" className="setup-error"><p>{error}</p><button className="setup-link" onClick={() => retryLoad(n => n+1)}>Reload saved draft</button></div>}
      </div>
      <Context label={page === "learn" ? "Order preview · Sample" : page==="review" ? "Evidence behind this Proof" : page==="activate" ? "Facility profile" : "Match details"}
        title={page === "learn" ? "SO-10482" : page==="review" && matches?.length===1 ? matches[0].displayReference || matches[0].orderReference : status.binding?.organizationName || "Your facility"}
        intro={page === "learn" ? "North Ridge Supply" : page==="review" ? "Open an event to see its source, matching identifiers and recorded quantities." : page==="sources" ? "Review the records available from each source." : "Review the included sources and their approved meanings."}
        footer={ws.phase === "active" ? "The previous approved profile continues collecting." : "Collection begins after approval."}>
        {page === "learn" ? <>
          <div className="guided-illustration"><img alt="" src="./brand/connect/guided-carton.svg"/></div>
          <Row icon="order" title="Sales order" detail="The order your customer placed."/>
          <Row icon="packing" title="Carton scans" detail="What the packing station recorded."/>
          <Row icon="shipping" title="Dispatch records" detail="Labels and carrier events for each carton."/>
        </> : <>
          {(page!=="review" || !matches?.length) && sources.map(s => <Row key={s.id} icon={value.excludedSourceIds.includes(s.id) ? "clock" : "connection"} title={sourceName(s)}
            detail={value.excludedSourceIds.includes(s.id) ? "Outside the proposed coverage" : draft.replay?.sources.find(r => r.sourceId === s.id)?.message ?? s.recognition.message}/>)}
          {page === "review" && matches?.map(order=>{
            const events=order.events.map((e,j)=><Row key={j} icon={kindNames[e.kind]?.[0] || "file"} title={kindNames[e.kind]?.[1] || e.kind}
              detail={[e.entity?.id,e.fileName,e.locator].filter(Boolean).join(" · ")} onClick={()=>setInspected(e)}/>);
            return <div key={JSON.stringify([order.orderNamespace,order.orderId || order.orderReference])}>
              {matches.length>1 && <h3>{order.displayReference || order.orderReference}</h3>}
              {events.slice(0,6)}
              {events.length>6 && <details><summary>View {events.length-6} more source records</summary>{events.slice(6)}</details>}
            </div>;
          })}
          {page === "activate" && value.rules.filter(r=>!value.excludedSourceIds.includes(r.sourceId)).map(r=>{
            const origin=sources.find(s=>s.id===r.sourceId);
            return origin && <Row key={r.sourceId} icon="shipping" title={sourceName(origin)} detail={
              r.shippedAt==="label"?"Shipped At records label printing. Handoff needs separate evidence.":
              r.shippedAt==="handoff"?"Shipped At records carrier handoff.":"The meaning of Shipped At remains unknown."
            }/>;
          })}
        </>}
      </Context>
      {inspected && <SetupDialog title={kindNames[inspected.kind]?.[1] || inspected.kind} onClose={()=>setInspected(null)}>
        <p>{eventFacts(inspected)}</p>
        <Row icon="file" title={inspected.fileName} detail={[inspected.source,inspected.locator].filter(Boolean).join(" · ")}/>
        <h3>Matching references</h3>
        {inspected.shared && <p>This source record is shared across orders.</p>}
        <ul>{[inspected.entity,...inspected.references ?? []].filter(r=>!!r).map((r,i)=><li key={i}>{r!.type} · {r!.id} · {r!.namespace}</li>)}</ul>
        {!!Object.keys(inspected.fieldLineage ?? {}).length && <details><summary>Fields used to interpret this record</summary>
          <dl className="guided-compare">{Object.entries(inspected.fieldLineage!).map(([name,loc])=><div key={name}><dt>{name}</dt><dd>{loc}</dd></div>)}</dl>
        </details>}
        {inspected.profileVersion && <small>Reader rule · {inspected.profileVersion}</small>}
      </SetupDialog>}
      {help && <SetupDialog title="Your facility setup" onClose={() => setHelp(false)}>
        <p>Enter a shipment you recognize, choose its record sources and compare what PackProof finds. You can return to your saved draft.</p>
        <p>Each source you set up later is excluded from the approval request.</p>
      </SetupDialog>}
    </main>
  </>;
}
