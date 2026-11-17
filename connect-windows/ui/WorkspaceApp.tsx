import { WorkspaceAttention } from './WorkspaceAttention';
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectApp } from "./ConnectApp";
import { getBridge, type ConnectBridge, type ConnectStatus } from "./types";
import { DraftOrderPreview, ExampleFields, Orders } from "./WorkspaceOrders";
import { sourceRoles, type SourceRole, type WorkspaceSource, type WorkspaceStep } from "./workspace-types";
import "./workspace.css";

const categories: Record<SourceRole,{name:string; prompt:string; icon:string}> = {
  order: {name:"Order records",prompt:"Choose where your sales system saves order information.",icon:"\uE8A5"},
  picking: {name:"Picking records",prompt:"Choose where your warehouse saves picking records.",icon:"\uE8FF"},
  packing: {name:"Packing and evidence",prompt:"Choose where your packing records and photos are saved.",icon:"\u{1F4E6}"},
  shipping: {name:"Shipping records",prompt:"Choose where your shipping system saves labels and shipment records.",icon:"\u{1F69A}"},
  evidence: {name:"Photos and documents",prompt:"Choose where your operation saves evidence files.",icon:"\uEB9F"},
  handoff: {name:"Handoff records",prompt:"Choose where your operation records loading or transfer to a carrier.",icon:"\uEDE4"},
  delivery: {name:"Delivery records",prompt:"Choose where your operation saves delivery confirmations.",icon:"\uE73E"},
  returns: {name:"Return records",prompt:"Choose where your operation records returned items and inspections.",icon:"\uE7A7"}
};
const defaults: SourceRole[] = ["order","picking","packing","shipping"];
const dashboardPages = ["Overview","Orders","Sources","Needs attention","Settings"] as const;
type DashboardPage = typeof dashboardPages[number];
type Run = (label:string, action:()=>Promise<ConnectStatus | void | unknown>)=>Promise<void>;
const shortPath = (path:string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const sourceTitle=(s:WorkspaceSource)=>s.transport==="api" ? (s.displayName || "Partner API") : (s.displayName && s.displayName!==s.folder ? s.displayName : shortPath(s.folder));
const needsHelp = (s:WorkspaceSource) => ["ambiguous","unsupported","unavailable","incomplete"].includes(s.recognition.state) || ["interrupted","error","revoked","needs_attention"].includes(s.state);
const eligible = (s:WorkspaceSource) => (s.recognition.state === "recognized" || s.recognition.state === "empty") && !!s.roles.length && s.state !== "paused";
const isStatus = (value:unknown):value is ConnectStatus => !!value && typeof value === "object" && "health" in value && "environment" in value;
const permissions = (state:string) => ["revoked","permission_required"].includes(state);
function Clarify({source,bridge,run,busy}:{source:WorkspaceSource;bridge:ConnectBridge;run:Run;busy:boolean}) {
  const found=source.recognition;
  const choice=found.relatedChoices?.[0];
  if(found.state==="ambiguous" && choice)return <section><h3>{found.question || "Which source supplies this reference?"}</h3>
    <p>{categories[choice.role]?.name}</p><div className="ws-actions">{choice.options.map(option=>
      <button key={option.id} className="secondary" disabled={busy} onClick={()=>run("Checking the related source",()=>
        bridge.chooseWorkspaceRelatedSource(source.id,source.generation,choice.role,option.id))}>{option.displayName}</button>)}</div>
  </section>;
  if(found.state!=="ambiguous" || !found.question || !found.profileVersion)return null;
  return <section>
    <h3>{found.question}</h3>
    {found.suggestedOrderColumn && found.sample?.[found.suggestedOrderColumn] && <p>Example · {found.sample[found.suggestedOrderColumn]}</p>}
    <button className="secondary" disabled={busy} onClick={()=>run("Checking order references",()=>
      bridge.confirmWorkspaceOrderMap(source.id,source.generation,found.profileVersion!))}>Confirm this reference</button>
  </section>;
}
function SourceCard({source,children}:{source:WorkspaceSource;children?:React.ReactNode}) {
  return <article className="ws-source">
    <h3>{sourceTitle(source)}</h3>
    <p className={needsHelp(source) ? "ws-warning" : "ws-caption"}>{source.recognition.message}</p>
    {source.recognition.state === "recognized" && <ExampleFields sample={source.recognition.sample}/>}
    <details><summary>Source details</summary>{source.folder && <p className="ws-path">{source.folder}</p>}{source.sourceNamespace && <p>Upstream system · {source.sourceNamespace}</p>}
      <p>{source.roles.map(role=>categories[role]?.name).filter(Boolean).join(" · ")}</p></details>
    {children}
  </article>;
}
function Brand(){return <div className="ws-brand"><img src="./brand/packproof-symbol.svg" alt="" width="34" height="34"/><span>PackProof <b>Connect</b></span></div>;}
function Picker({role,sources,bridge,run,busy}:{role:SourceRole;sources:WorkspaceSource[];bridge:ConnectBridge;run:Run;busy:boolean}) {
  const selected = sources.filter(item=>item.roles.includes(role));
  const reusable = sources.filter(item=>item.transport!=="api" && !item.roles.includes(role));
  const [reuse,setReuse] = useState("");
  const [namespace,setNamespace]=useState("");
  return <>
    {selected.map(source=><SourceCard key={source.id} source={source}>
      <Clarify source={source} bridge={bridge} run={run} busy={busy}/>
      {needsHelp(source) && <button className="secondary" disabled={busy} onClick={()=>run("Checking records",()=>bridge.inspectWorkspaceSource(source.id))}>Check again</button>}
      <button className="quiet" disabled={busy} onClick={()=>run("Updating this source",()=>bridge.removeWorkspaceRole(source.id,role))}>Remove from this step</button>
    </SourceCard>)}
    <div className="ws-actions">
      <button className={selected.length ? "secondary" : "primary"} disabled={busy} onClick={()=>run("Checking your folder",()=>bridge.chooseWorkspaceFolder(role))}>{selected.length ? "Add another location" : "Choose folder"}</button>
      {!!reusable.length && <details className="ws-reuse"><summary>Use an existing location</summary>
        <label>Records folder<select value={reuse} onChange={e=>setReuse(e.target.value)}><option value="">Choose a location</option>
          {reusable.map(item=><option key={item.id} value={item.id}>{item.folder}</option>)}</select></label>
        <button className="secondary" disabled={!reuse || busy} onClick={()=>run("Saving location",()=>bridge.reuseWorkspaceFolder(reuse,role))}>Use this location</button></details>}
    </div>
    <details><summary>Connect a system instead</summary>
      {role==="order" && <><p>Receive orders directly from the system connected to your PackProof partner account.</p>
        <details><summary>IT connection details</summary><label>Upstream system identifier (optional)<input maxLength={100} value={namespace} onChange={e=>setNamespace(e.target.value)} /></label></details>
        <button className="secondary" disabled={busy || selected.some(item=>item.transport==="api" && (item.sourceNamespace || "partner-api")===(namespace.trim()||"partner-api"))}
          onClick={()=>run("Adding the order connection",()=>bridge.addWorkspaceDirectSource(namespace.trim()||undefined))}>Connect PackProof Partner API</button></>}
      <button className="secondary" disabled={busy} onClick={()=>run("Opening connections",()=>bridge.openPortal())}>Open system connections</button></details>
  </>;
}

function Setup({status,bridge,run,busy,legacy}:{status:ConnectStatus;bridge:ConnectBridge;run:Run;busy:boolean;legacy:()=>void}) {
  const ws = status.workspace!;
  const step = ws.step || "order";
  const [sample,setSample] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const role = sourceRoles.find(item=>item===step);
  const sourceIndex = role ? defaults.indexOf(role) : -1;
  const sources = ws.sources.filter(item=>item.roles.length);
  const ready = sources.filter(eligible);
  const pending = sources.filter(source=>!eligible(source));
  const output = ws.outputFolder || status.proofOutput?.folder;
  const outputReady = ws.outputState === "ready" || status.proofOutput?.state === "ready" || status.proofOutput?.state === "current";
  const temporaryOutput = !!output && ws.outputState === "unavailable";
  const pendingApproval = ws.phase === "awaiting_approval" && (!ws.expiresAt || Date.parse(ws.expiresAt)>Date.now());
  const enrolling = !status.installationId && status.enrollment?.state === "pending" && Date.parse(status.enrollment.expiresAt)>Date.now();
  const move = (next:WorkspaceStep)=>run("Saving setup",()=>bridge.saveWorkspaceStep(next));
  const next = role && sourceIndex >= 0 && sourceIndex < defaults.length-1 ? defaults[sourceIndex+1] : "review";
  const previous:WorkspaceStep = role ? sourceIndex>0 ? defaults[sourceIndex-1] : "review" : step==="review" ? "shipping" : step==="output" ? "review" : "output";
  const stepTitle = role ? categories[role].name : step === "review" ? "Review an order" : step === "output" ? "Where should PackProof save your proofs?" : "Start collecting";
  useEffect(()=>{heading.current?.focus();setSample(false);},[step]);
  const start = ()=>run(status.installationId ? "Requesting collection" : "Opening PackProof sign-in",()=>bridge.activateWorkspace(temporaryOutput ? true : undefined));
  return <main className="ws-work" aria-label="Connection setup">
    <div className="ws-step-header"><span>{role ? <span className="ws-icon" aria-hidden="true">{categories[role].icon}</span> : null}Connection setup</span>
      <button className="quiet" disabled={busy} onClick={()=>window.close()}>Save and exit</button></div>
    <section className="ws-panel">
      <h1 ref={heading} tabIndex={-1}>{stepTitle}</h1>
      {role && <><p className="ws-intro">{categories[role].prompt}</p><Picker key={role} role={role} sources={sources} bridge={bridge} run={run} busy={busy}/></>}
      {step==="review" && <>
        <DraftOrderPreview bridge={bridge} sources={sources}/>{ws.canReadOrders!==false && !!ws.orders?.length && <details><summary>Previously saved orders</summary><Orders sources={sources} list={ws.orders} bridge={bridge}/></details>}
        <h2>Source coverage</h2>
        <ul className="ws-coverage">{defaults.map(item=><li key={item}><span>{categories[item].name}</span><span>{sources.some(s=>s.roles.includes(item)) ? "Selected" : "Skipped"}</span></li>)}</ul>
        <details><summary>Add another source</summary><div className="ws-actions">{sourceRoles.map(item=><button key={item} className="secondary" disabled={busy} onClick={()=>move(item)}>{categories[item].name}</button>)}</div></details>
        <details open={sample} onToggle={e=>setSample(e.currentTarget.open)}><summary>Try a sample order</summary><section className="ws-sample"><h3>Sample order SO10482</h3><p>Two units on line 20 and one unit on line 30 share item A100. Each line ships in a separate package.</p><p className="ws-caption">Illustration only. Your records stay separate.</p></section></details>
      </>}
      {step==="output" && <><p className="ws-intro">Choose a folder for your order summaries and evidence. Your proofs will also appear in the dashboard.</p>
        {output && <p className="ws-path">{output}</p>}
        <button className="primary" disabled={busy} onClick={()=>run("Checking write access",()=>bridge.chooseWorkspaceOutput())}>{output ? "Change folder" : "Choose proof folder"}</button>
        {output && <p role="status">{outputReady ? "The background service can save proofs here." : temporaryOutput ? "This destination is temporarily unavailable." : "Write access needs attention. Choose another folder or check its permissions."}</p>}
        <p className="ws-caption">Example folder name · SO10482 with its unique proof key</p>
      </>}
      {step==="activate" && <>
        <p className="ws-intro">Review the sources and destination for this computer.</p>
        <h2>Records to collect</h2>
        {sources.length ? <ul>{sources.map(source=><li key={source.id}><strong>{sourceTitle(source)}</strong> · {source.roles.map(role=>categories[role].name).join(", ")}
          {!eligible(source) && " · Needs attention"}</li>)}</ul> : <p>Choose at least one records source to begin.</p>}
        <p>{sources.some(s=>s.transport!=="api") && "PackProof will read existing files in the selected folders and check there for new or changed files. Subfolders can be added separately. "}{sources.some(s=>s.transport==="api") && "The partner connection will accept new orders sent within its approved scope. "}Approved originals are retained with order proofs available to your team online.</p>
        <p><strong>Local copies</strong><br/><span className="ws-path">{output || "Choose a proof folder."}</span></p>
        {!!pending.length && <p className="ws-warning">{pending.length} {pending.length===1 ? "source needs" : "sources need"} a review before collection can start there.</p>}
        {status.authorizationNotice && <p role="status">{status.authorizationNotice}</p>}
        {pendingApproval || enrolling ? <div className="ws-notice"><h2>{enrolling ? "Connect this computer" : "Review access in your browser"}</h2>
          <p>{enrolling ? "Sign in to the account for this operation." : "Confirm the sources and access listed in PackProof."} This window updates when your approval arrives.</p>
          {enrolling && status.enrollment?.comparisonCode && <p>Match this code in your browser · <strong>{status.enrollment.comparisonCode}</strong></p>}
          <button className="primary" disabled={busy} onClick={()=>run("Opening browser review",()=>enrolling ? bridge.openApproval() : bridge.openWorkspaceApproval())}>Open browser review</button></div>
          : <button className="primary" disabled={busy || !ready.length || !output || !outputReady && !temporaryOutput || permissions(status.state)} onClick={start}>{temporaryOutput ? "Start with local copies pending" : "Start collecting"}</button>}
      </>}
      {(status.config || status.sourceSubscriptions?.length || status.recoveryAvailable) ? <details><summary>Existing connection</summary><button className="secondary" onClick={legacy}>Manage earlier connections</button></details> : null}
      <footer className="ws-actions ws-footer">
        {ws.phase==="active" && <button className="quiet" disabled={busy} onClick={()=>move("overview")}>Return to Overview</button>}
        {step!=="order" && <button className="secondary" disabled={busy} onClick={()=>move(previous)}>Back</button>}
        {role && <button className={sources.some(item=>item.roles.includes(role)) ? "primary" : "quiet"} disabled={busy} onClick={()=>move(next)}>{sources.some(item=>item.roles.includes(role)) ? "Next" : "Skip for now"}</button>}
        {step==="review" && <button className="primary" disabled={busy} onClick={()=>move("output")}>Next</button>}
        {step==="output" && <button className="secondary" disabled={busy || !output || !outputReady && !temporaryOutput} onClick={()=>move("activate")}>Next</button>}
      </footer>
    </section>
  </main>;
}

function CopyConnection({source,bridge}:{source:WorkspaceSource;bridge:ConnectBridge}){
  const [state,setState]=useState<"idle"|"copying"|"copied">("idle");
  const [error,setError]=useState("");
  return <><button className="secondary" disabled={state==="copying"} onClick={async()=>{
    setState("copying");setError("");
    try{await bridge.copyWorkspaceDirectProfile(source.id);setState("copied");}
    catch(e){setState("idle");setError(e instanceof Error ? e.message : "The connection details are unavailable.");}
  }}>Copy connection details for IT</button><span role="status">{state==="copied" ? " Connection details copied." : error}</span></>;
}
function Dashboard({status,bridge,run,busy,legacy}:{status:ConnectStatus;bridge:ConnectBridge;run:Run;busy:boolean;legacy:()=>void}) {
  const [page,setPage] = useState<DashboardPage>("Overview");
  const [adding,setAdding] = useState(false);
  const workspace=status.workspace!;
  const sources=workspace.sources.filter(source=>source.roles.length);
  const issues=sources.filter(needsHelp);
  const output=status.proofOutput;
  const destination=output?.folder || workspace.outputFolder;
  const pendingCopy=!!output && (output.pending>0 || ["pending","access_denied","unavailable"].includes(output.state));
  const offline=["unreachable","unauthenticated","forbidden"].includes(status.transport?.state || "") || workspace.syncState==="offline";
  const change=(role:SourceRole)=>run("Opening source settings",()=>bridge.saveWorkspaceStep(role));
  const folderButton=<button className="secondary" disabled={busy || !destination} onClick={()=>run("Opening your proof folder",()=>bridge.openWorkspaceOutput())}>Open proof folder</button>;
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{heading.current?.focus();},[page]);
  return <div className="ws-dash">
    <nav aria-label="Workspace">{dashboardPages.map(item=><button key={item} aria-current={page===item ? "page" : undefined} onClick={()=>setPage(item)}>{item}</button>)}</nav>
    <main className="ws-panel"><h1 tabIndex={-1} ref={heading}>{page}</h1>
      {offline && <p role="status" className="ws-warning">The online connection is interrupted. Reconnect to see the latest orders.</p>}
      {!offline && workspace.syncState==="pending" && <p role="status" className="ws-caption">Checking for the latest online orders.</p>}
      {page==="Overview" && <><div className="ws-metrics">
        <div><strong>{sources.filter(source=>source.state==="active").length}</strong><span>Active sources</span></div>
        <div><strong>{issues.length}</strong><span>Sources needing attention</span></div>
        {output && <div><strong>{output.pending}</strong><span>Pending local copies</span></div>}
        </div><h2>Recent orders</h2>{workspace.canReadOrders!==false ? <Orders sources={sources} list={(workspace.orders || []).slice(0,5)} bridge={bridge}/> : <p>Reconnect to your approved workspace to see its orders.</p>}<h2>Saved proofs</h2>{pendingCopy && <p>Saved online · Local copies pending</p>}{folderButton}</>}
      {page==="Orders" && (workspace.canReadOrders!==false ? <Orders searchable sources={sources} list={workspace.orders || []} bridge={bridge}/> : <p>Reconnect to your approved workspace to see its orders.</p>)}
      {page==="Sources" && <>{sources.length ? sources.map(source=><SourceCard source={source} key={source.id}><p>Collection · {source.state.replaceAll("_"," ")}</p>
        {source.transport==="api" && source.state==="active" && <CopyConnection source={source} bridge={bridge}/>}
        {["active","paused"].includes(source.state) && <button className="secondary" disabled={busy} onClick={()=>run("Updating collection",()=>source.state==="paused" ? bridge.resumeWorkspaceSource(source.id) : bridge.pauseWorkspaceSource(source.id))}>{source.state==="paused" ? "Resume collection" : "Pause collection"}</button>}</SourceCard>) : <p>Choose the first records source for this operation.</p>}
        <button className="primary" disabled={busy} aria-expanded={adding} onClick={()=>setAdding(!adding)}>Add a source</button>
        {adding && <div className="ws-actions">{sourceRoles.map(role=><button key={role} className="secondary" onClick={()=>change(role)}>{categories[role].name}</button>)}</div>}</>}
      {page==="Needs attention" && <>{workspace.canReadOrders!==false && <WorkspaceAttention bridge={bridge} sources={sources}/>}{!issues.length && !pendingCopy && !offline && <p>No source or output issues reported.</p>}
        {issues.map(source=><SourceCard key={source.id} source={source}><Clarify source={source} bridge={bridge} run={run} busy={busy}/><button className="secondary" disabled={busy} onClick={()=>run("Checking records",()=>bridge.inspectWorkspaceSource(source.id))}>Check again</button></SourceCard>)}
        {pendingCopy && <><h2>Local copies pending</h2><p>Reconnect the proof folder. The background service will retry.</p>{folderButton}</>}</>}
      {page==="Settings" && <><h2>Proof folder</h2><p className="ws-path">{destination || "Choose a destination for local proofs."}</p>
        <div className="ws-actions">{folderButton}<button className="quiet" disabled={busy} onClick={()=>run("Opening output settings",()=>bridge.saveWorkspaceStep("output"))}>Change proof folder</button></div>
        <h2>Account</h2><button className="secondary" disabled={busy} onClick={()=>run("Opening connections",()=>bridge.openPortal())}>Manage online connections</button>
        <details><summary>Support and existing connections</summary><div className="ws-actions">
          <button className="secondary" disabled={busy} onClick={()=>run("Preparing diagnostics",()=>bridge.exportDiagnostics())}>Export diagnostics</button>
          <button className="quiet" onClick={legacy}>Manage earlier connections</button></div></details></>}
    </main></div>;
}

export function WorkspaceApp({bridge=getBridge()}:{bridge?:ConnectBridge}) {
  const [status,setStatus] = useState<ConnectStatus|null>(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState("");
  const [pollError,setPollError] = useState("");
  const [legacy,setLegacy] = useState(false);
  const inAction=useRef(false), epoch=useRef(0), mounted=useRef(true), displayed=useRef<ConnectStatus|null>(null);
  const followupApproval=useRef(false);
  const accept=useCallback((value:ConnectStatus)=>{
    const ws = value.workspace;
    const next = ws ? {...value,workspace:{...ws,sources:(ws.sources || []).map(source=>
      source.recognition ? source : {...source,recognition:{state:"incomplete",message:"Check this folder to preview its records."}}
    )}} : value;
    if (!next.installationId && next.enrollment?.state==="pending" && ws?.step==="activate") followupApproval.current=true;
    if (next.installationId && ws?.phase==="awaiting_approval" && ws.approvalPath && followupApproval.current && bridge) {
      followupApproval.current=false;
      void bridge.openWorkspaceApproval().catch(()=>{if(mounted.current)setError("Your connection review is ready. Open browser review to continue.");});
    }
    displayed.current=next;setStatus(next);setPollError("");
  },[bridge]);
  const run:Run=useCallback(async(label,operation)=>{
    if(inAction.current) return;
    inAction.current=true;
    const id=++epoch.current;
    setBusy(label);setError("");
    try {
      const value=await operation();
      if (mounted.current && id===epoch.current && isStatus(value)) accept(value);
    } catch(e) { if(mounted.current && id===epoch.current) setError(e instanceof Error ? e.message : "This action could not be completed. Try again."); }
    finally { inAction.current=false;if(mounted.current && id===epoch.current) setBusy(""); }
  },[accept]);
  useEffect(()=>{
    mounted.current=true;
    if (!bridge || legacy) return;
    let stopped=false,polling=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      if(stopped || polling || inAction.current) return;
      clearTimeout(timer);polling=true;
      const id=epoch.current;
      try{
        const current=displayed.current;
        const enrolling=!current?.installationId && current?.enrollment?.state==="pending" && Date.parse(current.enrollment.expiresAt)>Date.now();
        const next=await (enrolling ? bridge.pollEnrollment() : current?.workspace ? bridge.getWorkspaceStatus() : bridge.getStatus());
        if(!stopped && id===epoch.current) accept(next);
      }catch(e){if(!stopped && id===epoch.current) setPollError(e instanceof Error ? e.message : "The background service is unavailable. Try again.");}
      finally{
        polling=false;
        if(!stopped && (!displayed.current || displayed.current.workspace)){
          const pending = displayed.current?.workspace?.phase==="awaiting_approval" || displayed.current?.enrollment?.state==="pending";
          timer=setTimeout(schedule,pending ? 1800 : displayed.current?.workspace?.phase==="active" ? 2000 : 10000);
        }
      }
    };
    const schedule=()=>{if(inAction.current) {clearTimeout(timer);timer=setTimeout(schedule,750);} else void poll();};
    const focus=()=>{if(document.visibilityState!=="hidden") schedule();};
    schedule();window.addEventListener("focus",focus);document.addEventListener("visibilitychange",focus);
    return ()=>{stopped=true;mounted.current=false;epoch.current++;clearTimeout(timer);window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",focus);};
  },[bridge,legacy,accept]);
  if (bridge && (legacy || status && (!status.workspace || status.installationId && status.capabilities?.orderWorkspace===false))) return <>
    {legacy && <button className="secondary" onClick={()=>setLegacy(false)}>Return to workspace</button>}<ConnectApp bridge={bridge}/></>;
  const workspace=status?.workspace;
  return <div className="ws-shell"><header><Brand/>{status?.binding?.organizationName && <span>{status.binding.organizationName}</span>}</header>
    {workspace?.attention && <p role="status" className="ws-error">{workspace.attention}</p>}
    {(error || pollError || status?.error?.message) && <div role="alert" className="ws-error">{error || pollError || status?.error?.message}
      {bridge && <button className="quiet" disabled={!!busy} onClick={()=>run("Checking the connection",()=>bridge.getStatus())}>Check connection</button>}</div>}
    {busy && <p role="status" className="ws-busy">{busy}…</p>}
    {!bridge ? <main className="ws-work"><h1>Open PackProof Connect on Windows</h1><p>Use the installed application to connect your sources.</p></main> :
    !status || !workspace ? <main className="ws-work"><h1>Opening your workspace</h1><p role="status">Connecting to the background service…</p></main> :
    workspace.step==="overview" && workspace.phase==="active" ? <Dashboard key={[status.environment,status.installationId,status.binding?.organizationId,workspace.viewKey,workspace.canReadOrders].join("/")} status={status} bridge={bridge} run={run} busy={!!busy} legacy={()=>setLegacy(true)}/> :
    <Setup status={status} bridge={bridge} run={run} busy={!!busy} legacy={()=>setLegacy(true)}/>}
  </div>;
}

