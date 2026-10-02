import {useCallback,useEffect,useRef,useState} from 'react';
import {FEATURES,FEATURE_LABELS,findingLabel} from '../../../packages/evidence-contracts/contracts.mjs';
import type {AnalysisEnvelope,Feature,RndSnapshot,RndTransport,SourcePreview,SourceRef} from './types';
import './rnd.css';
import {MaskEditor} from './MaskEditor';
import {ArtifactPreview} from './ArtifactPreview';
import {DerivativeGrants} from './DerivativeGrants';
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const rows=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.map(record):[];
const text=(value:unknown)=>typeof value==='string'?value:typeof value==='number'?String(value):'';
function readable(value:unknown):string {return text(value).replaceAll('_',' ').toLowerCase();}
function sourceIds(row:Record<string,unknown>,fallback:SourceRef[]):string[] {
 const refs=row.sourceRefs??row.sourceIds;
 if(Array.isArray(refs))return refs.map(x=>typeof x==='string'?x:text(record(x).sourceId)).filter(Boolean);
 const direct=text(row.sourceId);return direct?[direct]:fallback.map(x=>x.sourceId);
}
function Findings({result,onSource}:{result:AnalysisEnvelope;onSource:(id:string,startMs?:number)=>void}) {
 const details=record(result.details);const allObservations=rows(details.observations??details.events);const observations=allObservations.filter(row=>row.type!=='COMPARISON_CHANNEL');const channels=rows(details.channels??record(details.comparison).channels??details.regions??allObservations.filter(row=>row.type==='COMPARISON_CHANNEL'));
 const coverage=Object.entries(result.coverage??{}).filter(([,v])=>typeof v!=='object');
 return <div className="rnd-findings">
  <p><strong>Scope:</strong> {result.scope}</p>
  {coverage.length>0&&<dl className="rnd-metadata">{coverage.map(([key,value])=><div key={key}><dt>{key.replace(/([A-Z])/g,' $1')}</dt><dd>{String(value)}</dd></div>)}</dl>}
  {observations.length>0&&<ol className="rnd-timeline">{observations.map((row,i)=>{
   const interval=record(row.interval);const start=Number(row.startMs??interval.startMs??row.offsetMs??row.timeMs);const label=text(row.type??row.event??row.eventType)||'Recorded observation';
   return <li key={text(row.observationId)||i}><strong>{readable(label)}</strong>{Number.isFinite(start)&&<span> · {(start/1000).toFixed(1)}s</span>}
    {text(row.attribution)&&<small>{readable(row.attribution)}</small>}{row.value!==undefined&&<p>{typeof row.value==='object'?JSON.stringify(row.value):String(row.value)}</p>}
    {sourceIds(row,result.sourceRefs).map(id=><button key={id} onClick={()=>onSource(id,Number.isFinite(start)?start:undefined)}>Open supporting source</button>)}
    {Array.isArray(row.limitations)&&<p className="rnd-limits">{row.limitations.map(String).join(' · ')}</p>}
   </li>;
  })}</ol>}
  {channels.length>0&&<div className="rnd-table-scroll"><table><caption>Comparison by channel</caption><thead><tr><th>Channel or region</th><th>Observed result</th><th>Evidence and limits</th></tr></thead><tbody>{channels.map((row,i)=><tr key={text(row.channel??row.regionId)||i}><th scope="row">{readable(row.channel??row.regionId??row.group)||'Region'}</th><td>{readable(row.findingState??row.outcome??row.status)||'Not checked'}{row.conflict===true&&<strong className="rnd-conflict"> · Unresolved conflict</strong>}</td><td>{text(row.scope)&&<p>{text(row.scope)}</p>}{text(row.missingReason)&&<p>{text(row.missingReason)}</p>}{rows(row.supportingObservations).map((support,j)=><p key={j}>{readable(support.type??support.channel)}{text(support.attribution)?` · ${readable(support.attribution)}`:''}{support.value!==undefined?` · ${typeof support.value==='object'?JSON.stringify(support.value):String(support.value)}`:''}</p>)}{Array.isArray(row.limitations)&&row.limitations.map(String).join(' ')}{sourceIds(row,result.sourceRefs).map(id=><button key={id} onClick={()=>onSource(id)}>Open source</button>)}</td></tr>)}</tbody></table></div>}
  {Array.isArray(details.conflicts)&&details.conflicts.length>0&&<p className="rnd-conflict" role="note">Conflicting observations require review: {details.conflicts.map(String).join('; ')}</p>}
  {result.reasonCodes.length>0&&<p>{result.reasonCodes.map(readable).join(' · ')}</p>}
  {result.limitations.length>0&&<ul className="rnd-limits">{result.limitations.map((limit,i)=><li key={i}>{limit}</li>)}</ul>}
  <div className="rnd-source-buttons">{result.sourceRefs.map(source=><button key={source.sourceId} disabled={source.retentionState!=='AVAILABLE'} onClick={()=>onSource(source.sourceId)}>Original {source.sourceId.slice(-8)}{source.retentionState!=='AVAILABLE'?' · no longer available':''}</button>)}</div>
  <details><summary>Method and capture details</summary><dl className="rnd-metadata"><div><dt>Policy</dt><dd>{result.method.policyVersion}</dd></div><div><dt>Qualification</dt><dd>{result.qualification?.gate??'Not qualified for customer conclusions'}</dd></div><div><dt>Received</dt><dd>{result.serverReceivedAt}</dd></div></dl><pre>{JSON.stringify({method:result.method,details:result.details,inputDigest:result.inputDigest,rootManifestDigest:result.rootManifestDigest},null,2)}</pre></details>
 </div>;
}
/** Authenticated review only. No customer/public route mounts this component. */
export function RndReview({proofId,transport,openSource,saveExport}:{proofId:string;transport:RndTransport;openSource:(sourceId:string,legId?:string)=>Promise<SourcePreview>;saveExport:(bundle:unknown)=>Promise<void>}) {
 const [snapshot,setSnapshot]=useState<RndSnapshot|null>(null);
 const [allowed,setAllowed]=useState<Feature[]>([]),[displayed,setDisplayed]=useState<Feature[]>([]);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[agreed,setAgreed]=useState(false),[consented,setConsented]=useState(false);
 const [selected,setSelected]=useState<string[]>([]),[feature,setFeature]=useState<Feature>('proofpilot'),[parameters,setParameters]=useState('{}');
 const [preview,setPreview]=useState<(SourcePreview & {label:string})|null>(null);
 const [pinned,setPinned]=useState<(SourcePreview & {label:string})|null>(null);
 const [maskSource,setMaskSource]=useState<(SourcePreview & {sourceId:string})|null>(null);
 const [reviewedPreview,setReviewedPreview]=useState<string|null>(null);
 const generation=useRef(0),video=useRef<HTMLVideoElement>(null),urls=useRef<string[]>([]);
 const refresh=useCallback(async()=>{const current=generation.current;const [value,notes]=await Promise.all([transport.list(proofId),transport.annotations?.(proofId)]);if(current===generation.current)setSnapshot({...value,annotations:notes?.annotations??value.annotations??[]});},[transport,proofId]);
 useEffect(()=>{
  generation.current++;setSnapshot(null);setSelected([]);setConsented(false);setAgreed(false);setPreview(null);setPinned(null);setMaskSource(null);setReviewedPreview(null);setError('');setBusy(false);setAllowed([]);setDisplayed([]);setParameters('{}');let alive=true;
  void transport.capabilities().then(async cap=>{
   if(!alive)return;
   const flags=cap.flags?.features??cap.features;
   if(!cap.enabled||(cap.flags?.killSwitch??cap.killSwitch)!==false){setSnapshot({analyses:[],sources:[],limitations:['Research operations are disabled.']});return;}
   setAllowed(FEATURES.filter(f=>flags?.[f]?.processing===true));setDisplayed(FEATURES.filter(f=>flags?.[f]?.internalDisplay===true));await refresh();
  }).catch(e=>{if(alive)setError(e instanceof Error?e.message:'Research results unavailable.');});
  return()=>{alive=false;generation.current++;urls.current.forEach(URL.revokeObjectURL);urls.current=[];};
 },[transport,proofId,refresh]);
 useEffect(()=>{if(!snapshot?.analyses.some(row=>['QUEUED','RUNNING'].includes(row.operationalState)))return;const timer=setTimeout(()=>void refresh().catch(()=>{}),5000);return()=>clearTimeout(timer);},[snapshot,refresh]);
 async function action(fn:(current:()=>boolean)=>Promise<void>) {
  const expected=generation.current,current=()=>expected===generation.current;setBusy(true);setError('');
  try{await fn(current);}catch(e){if(current())setError(e instanceof Error?e.message:'Research request failed.');}finally{if(current())setBusy(false);}
 }
 function retain(source:SourcePreview,current:()=>boolean):boolean {
  if(!current()){if(source.url.startsWith('blob:'))URL.revokeObjectURL(source.url);return false;}
  if(source.url.startsWith('blob:'))urls.current.push(source.url);return true;
 }
 async function showSource(id:string,startMs?:number) {await action(async current=>{
  const mapped=snapshot?.sources.find(s=>s.sourceId===id||`rnd_source_${s.sourceId}`===id);
  if(!mapped)throw new Error('This source is no longer available in the authorized inventory.');
  const source=await openSource(mapped.evidenceId??mapped.sourceId,mapped.legId);
  if(retain(source,current))setPreview({...source,startMs,label:'Authorized original source'});
 });}
 const sources=snapshot?.sources??[],analyses=snapshot?.analyses.filter(job=>displayed.includes(job.feature))??[];
 return <section className="rnd-panel" aria-label="Experimental evidence analysis">
  <div className="rnd-heading"><div><span className="rnd-eyebrow">EXPERIMENTAL R&D</span><h2>Evidence observations</h2></div><button disabled={busy||!displayed.length} onClick={()=>void action(refresh)}>Refresh</button></div>
  <p>Original evidence remains the reference. Each observation has its own scope and limits; unavailable analysis does not change the Proof.</p>
  {error&&<p role="alert" className="rnd-error">{error}</p>}
  {!snapshot&&!error&&<p role="status">Loading research observations…</p>}
  {snapshot&&analyses.length===0&&<p className="rnd-empty">No research analyses are available for review on this Proof.</p>}
  {analyses.map(job=><article className="rnd-analysis" key={job.analysisId}>
   <div className="rnd-heading"><h3>{FEATURE_LABELS[job.feature]}</h3><span className="rnd-status">{findingLabel(job)}</span></div>
   {job.errorCode&&<p>Analysis did not finish: {readable(job.errorCode)}. No physical finding was made.</p>}
   {job.result&&<Findings result={job.result} onSource={(id,start)=>void showSource(id,start)}/>}
   {job.result&&rows(job.result.details.artifacts).map((artifact,index)=>{
    const transformation=record(rows(job.result!.details.observations).find(row=>row.type==='SIGNED_TRANSFORMATION_RECORD')?.record);
    const artifactSha256=text(artifact.sha256??transformation.derivativeSha256),recipeSha256=text(transformation.recipeSha256);
    const reviewKey=`${job.analysisId}/${index}/${artifactSha256}/${recipeSha256}`,privacy=job.feature==='proofshield';
    return <div className="rnd-actions" key={index}>
     <button disabled={busy} onClick={()=>void action(async current=>{const source=await transport.artifact(proofId,job.analysisId,index);if(retain(source,current)){setPreview({...source,label:privacy?'Redacted derivative for review':'Derived analysis artifact'});setReviewedPreview(reviewKey);}})}>{privacy?'Review redacted derivative':`Open analysis artifact ${index+1}`}</button>
     {privacy&&<><button disabled={busy||reviewedPreview!==reviewKey||!artifactSha256||!recipeSha256} onClick={()=>void action(async current=>{await transport.review(proofId,job.analysisId,{approved:true,artifactSha256,recipeSha256},crypto.randomUUID());if(current()){setReviewedPreview(null);await refresh();}})}>Approve these exact redacted bytes</button><button disabled={busy} onClick={()=>void action(()=>transport.exportArchive(proofId,job.analysisId))}>Export approved derivative</button><DerivativeGrants key={`${proofId}/${job.analysisId}/${index}`} proofId={proofId} analysisId={job.analysisId} artifactSha256={artifactSha256} recipeSha256={recipeSha256} transport={transport}/></>}
    </div>;
   })}
   {(snapshot?.annotations??[]).filter(note=>note.annotation.analysisId===job.analysisId).map(note=><blockquote key={note.annotation.annotationId}><p>{note.annotation.statement}</p><footer>Participant statement · {note.annotation.actorId} · {note.annotation.createdAt}{note.annotation.supersedesId?' · correction of an earlier statement':''}</footer>{note.annotation.sourceRefs.map(source=><button key={source.sourceId} onClick={()=>void showSource(source.sourceId,note.annotation.interval?.startMs)}>Open statement source</button>)}</blockquote>)}
   {job.result&&transport.annotate&&<ReviewerNote result={job.result} disabled={busy} onSubmit={input=>void action(async current=>{await transport.annotate!(proofId,input,crypto.randomUUID());if(current())await refresh();})}/>}
  </article>)}
  <details className="rnd-controls"><summary>Consented research tools</summary>
   <p>Use staged or explicitly consented evidence. This consent covers experimental analysis of this Proof; it does not grant collaborative training permission.</p>
   <label><input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)}/> I am authorized to use these sources for experimental analysis.</label>
   <div className="rnd-actions"><button disabled={busy||!agreed||consented||!allowed.length} onClick={()=>void action(async current=>{await transport.consent(proofId,true,crypto.randomUUID());if(current())setConsented(true);})}>{consented?'Research consent recorded':'Record research consent'}</button><button disabled={busy||!allowed.length} onClick={()=>void action(async current=>{await transport.consent(proofId,false,crypto.randomUUID());if(current()){setConsented(false);setAgreed(false);setMaskSource(null);}})}>Withdraw future participation</button></div>
   <fieldset disabled={busy||!consented}><legend>Committed sources for this analysis</legend>{sources.length===0?<p>No committed sources are available.</p>:sources.map(source=><label key={source.sourceId}><input type="checkbox" disabled={source.retentionState!=='AVAILABLE'} checked={selected.includes(source.sourceId)} onChange={e=>{setMaskSource(null);setSelected(current=>e.target.checked?[...current,source.sourceId]:current.filter(id=>id!==source.sourceId));}}/>{source.sourceId.slice(-12)} · {source.mimeType} · {readable(source.relationship)}</label>)}</fieldset>
   <label>Analysis <select value={feature} onChange={e=>{setFeature(e.target.value as Feature);setMaskSource(null);setParameters('{}');}}>{FEATURES.map(f=><option key={f} value={f} disabled={!allowed.includes(f)}>{FEATURE_LABELS[f]}{allowed.includes(f)?'':' · disabled'}</option>)}</select></label>
   {feature!=='proofshield'&&<details><summary>Research annotations</summary><p>For region comparisons, enter source-pixel polygons and unchanged support regions. Sparse reconstruction requires a mask for every view. These annotations describe inputs; they cannot set a finding or qualification.</p><textarea aria-label="Research parameters" rows={6} value={parameters} maxLength={32768} onChange={e=>setParameters(e.target.value)}/></details>}
   <div className="rnd-actions">
    <button disabled={busy||!consented||selected.length===0||!allowed.includes(feature)||feature==='proofshield'} onClick={()=>void action(async current=>{const parsed=JSON.parse(parameters);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Research parameters must be an object.');await transport.request(proofId,{feature,evidenceIds:selected,parameters:parsed},crypto.randomUUID());if(current())await refresh();})}>Request analysis</button>
    <button disabled={busy||!analyses.length} onClick={()=>void action(async current=>{const bundle=await transport.export(proofId,crypto.randomUUID());if(current())await saveExport(bundle);})}>Export research record</button>
    <button disabled={busy||!analyses.length} onClick={()=>void action(()=>transport.exportArchive(proofId))}>Export with original sources</button>
   </div>
   {feature==='proofshield'&&<div><p>Select one image or video, then mark the private regions. Review the generated derivative before approving it.</p><button disabled={busy||!consented||selected.length!==1||!allowed.includes('proofshield')} onClick={()=>void action(async current=>{const sourceId=selected[0],mapped=snapshot?.sources.find(s=>s.sourceId===sourceId);if(!mapped)throw new Error('Original is unavailable.');const source=await openSource(mapped.evidenceId??sourceId,mapped.legId);if(retain(source,current))setMaskSource({...source,sourceId});})}>Open mask editor</button>
    {maskSource&&selected.length===1&&selected[0]===maskSource.sourceId&&<MaskEditor key={maskSource.url} source={maskSource} disabled={busy||!consented} onSubmit={(masks,kind)=>{const boundId=maskSource.sourceId;void action(async current=>{await transport.derivative(proofId,{evidenceIds:[boundId],parameters:{masks,kind}},crypto.randomUUID());if(current()){setMaskSource(null);await refresh();}});}}/>}
   </div>}
   <p className="rnd-limits">Server permissions, consent, feature controls, and qualified profiles determine which operations are available.</p>
  </details>
  <div className={pinned?"rnd-comparison":""}>
  {preview&&<div className="rnd-preview" role="region" aria-label="Evidence preview"><button onClick={()=>setPreview(null)}>Close source</button><button onClick={()=>setPinned(preview)}>Pin for comparison</button>
   {preview.mimeType.startsWith('video')?<video ref={video} controls src={preview.url} onLoadedMetadata={()=>{if(video.current&&preview.startMs!==undefined)video.current.currentTime=preview.startMs/1000;}}/>:preview.mimeType.startsWith('image')?<img src={preview.url} alt={preview.label}/>:<ArtifactPreview source={preview} onSource={id=>void showSource(id)}/>}
   <p>{preview.label}{preview.startMs!==undefined?` at ${(preview.startMs/1000).toFixed(1)} seconds`:''}.</p>
  </div>}
  {pinned&&<aside className="rnd-preview" aria-label="Pinned comparison source"><button onClick={()=>setPinned(null)}>Unpin source</button><p>{pinned.label} · pinned for comparison</p>{pinned.mimeType.startsWith('image')?<img src={pinned.url} alt="Pinned comparison evidence"/>:pinned.mimeType.startsWith('video')?<video controls src={pinned.url}/>:<ArtifactPreview source={pinned} onSource={id=>void showSource(id)}/>}</aside>}
  </div>
  {snapshot?.limitations.map((limit,i)=><p key={i} className="rnd-limits">{limit}</p>)}
 </section>;
}

function ReviewerNote({result,disabled,onSubmit}:{result:AnalysisEnvelope;disabled:boolean;onSubmit:(input:{analysisId:string;sourceId:string;text:string;interval?:{startMs:number;endMs:number}})=>void}) {
 const [statement,setStatement]=useState(''),[source,setSource]=useState(result.sourceRefs[0]?.sourceId??''),[start,setStart]=useState(''),[end,setEnd]=useState('');
 const hasInterval=start!==''||end!=='',startMs=Number(start)*1000,endMs=Number(end)*1000;
 const valid=statement.trim().length>0&&!!source&&(!hasInterval||(start!==''&&end!==''&&Number.isFinite(startMs)&&Number.isFinite(endMs)&&startMs>=0&&endMs>startMs));
 return <details><summary>Add an attributed reviewer statement</summary><p>Your statement is recorded separately. It does not replace the machine observation or original.</p><label>Supporting source <select value={source} onChange={e=>setSource(e.target.value)}>{result.sourceRefs.map(ref=><option key={ref.sourceId} value={ref.sourceId}>{ref.sourceId}</option>)}</select></label><label>Statement <textarea maxLength={2000} value={statement} onChange={e=>setStatement(e.target.value)}/></label><div className="rnd-actions"><label>Video start (seconds, optional)<input type="number" min={0} value={start} onChange={e=>setStart(e.target.value)}/></label><label>Video end (seconds, optional)<input type="number" min={0} value={end} onChange={e=>setEnd(e.target.value)}/></label></div><button disabled={disabled||!valid} onClick={()=>onSubmit({analysisId:result.analysisId,sourceId:source,text:statement,...(hasInterval?{interval:{startMs,endMs}}:{})})}>Record reviewer statement</button></details>;
}
