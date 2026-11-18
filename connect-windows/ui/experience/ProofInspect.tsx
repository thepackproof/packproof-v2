import {useEffect,useRef,useState,type ReactNode} from "react";
import {Icon} from "./Icon";
import {originalFocusRange} from "./ProofOriginal";
import {dateLabel,human,scalar,text,type Row,type Source} from "./ProofModel";

export type OriginalPreview={
  kind:"original"|"derived_excerpt";originalText?:string;mediaType?:string;reason?:string;verified?:boolean;truncated?:boolean;
  fields?:Row;fieldLineage?:Record<string,string>;lines?:Row[];profileVersion?:string;
  artifact?:{receiptId:string;fileName:string;mediaType:string;originalSha256:string;bytesBase64:string};
};
export type ReadOriginal=(proofId:string,revision:number,eventKey:string)=>Promise<OriginalPreview>;
export type FocusLine={id:string;quantityKey?:string};
export function Dialog({title,subtitle,icon,back,close,children}:{title:string;subtitle?:string;icon:string;back?:()=>void;close:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const d=ref.current;if(!d)return;
    const old=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    if(typeof d.showModal==="function")d.showModal();else d.setAttribute("open","");
    return ()=>{if(typeof d.close==="function")d.close();old?.focus();};
  },[]);
  return <dialog ref={ref} className="pf-dialog" aria-labelledby="proof-dialog-title" onCancel={e=>{e.preventDefault();close();}}
    onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}}}>
    <div className="pf-dialog-head"><span className="pf-iconbox"><Icon name={icon} size={36}/></span><div><h2 id="proof-dialog-title">{title}</h2>{subtitle&&<p>{subtitle}</p>}</div>
    <div className="pf-dialog-nav">{back&&<button className="pf-link" onClick={back}>Back</button>}<button className="pf-control" onClick={close}>Close</button></div></div>{children}</dialog>;
}
export function Facts({pairs}:{pairs:[string,string][]}){
  return <dl className="pf-facts">{pairs.map(([k,v],i)=><div key={i}><dt>{k}</dt><dd>{v||"Not reported"}</dd></div>)}</dl>;
}
export function SourceDetails({source:s}:{source:Source}){
  return <><Facts pairs={[["Source",s.origin],["File",s.fileName],["Source revision",s.version],["Source location",s.locator],["Event time",dateLabel(s.eventTime)],
    ["Received by PackProof",dateLabel(s.received)],["Receipt",s.receipt],["SHA-256 fingerprint",s.hash],["Source profile",text(s.row,"profileVersion")]]}/>
    {!!s.refs.length&&<section className="pf-inset"><h3>Linked references</h3><ul>{s.refs.map(r=><li key={JSON.stringify(r)}>{human(r.type)} {r.id} · {r.namespace}</li>)}</ul></section>}
    {!!Object.keys(s.fieldLineage).length&&<section className="pf-inset"><h3>Field locations</h3><Facts pairs={Object.entries(s.fieldLineage).map(([k,v])=>[human(k),scalar(v)])}/></section>}</>;
}
const explanations:Record<string,string>={
  record_excerpt:"This record is available as a field excerpt. Its source location is listed in Source details.",
  original_scope_unavailable:"Access to this source has changed. Its original is unavailable for this connection.",
  shared_or_reassigned_record:"This source also belongs to another order or has been reassigned. Its original is unavailable in this Proof.",
  format_unqualified:"This file format has no inline original preview."
};
export function SourceInspector({source,focus,proofId,revision,readOriginal,onDetails}:{source:Source;focus?:FocusLine;proofId:string;revision:number;readOriginal?:ReadOriginal;onDetails:(s:Source)=>void}){
  const [result,setResult]=useState<OriginalPreview>(),[error,setError]=useState(""),[attempt,setAttempt]=useState(0);
  const eventKey=text(source.row,"eventKey");
  useEffect(()=>{
    let live=true;setResult(undefined);setError("");
    if(readOriginal&&eventKey)readOriginal(proofId,revision,eventKey).then(v=>{if(live)setResult(v);}).catch(e=>{if(live)setError(e instanceof Error?e.message:"The original could not be read.");});
    return ()=>{live=false;};
  },[readOriginal,proofId,revision,eventKey,attempt]);
  const restricted=["original_scope_unavailable","shared_or_reassigned_record"].includes(result?.reason||"");
  const full={...source,fields:result?.fields??source.fields,fieldLineage:result?.fieldLineage??source.fieldLineage,lines:restricted?[]:result?.lines??source.lines,
    row:{...source.row,...(result?.profileVersion?{profileVersion:result.profileVersion}:{})}};
  const fields=Object.entries(full.fields), raw=result?.kind==="original"?result.originalText:undefined;
  const loc=focus?.quantityKey?scalar(full.fieldLineage[focus.quantityKey])||source.locator:source.locator;
  const range=raw===undefined?null:originalFocusRange(raw,result?.mediaType||"",focus?.id||"",focus?.quantityKey||"",loc);
  const artifact=result?.artifact;
  return <><div className="pf-chips"><span className="pf-tag">{source.origin}</span>{focus&&<span className="pf-tag neutral">{focus.id} in focus</span>}{text(source.row,"associationScope")==="shared"&&<span className="pf-tag neutral">Shared record</span>}</div>
    <div className="pf-inspect-grid"><section className="pf-inset"><h3>Recorded fields</h3>
      {full.lines.map((l,i)=><div className={"pf-line-fields"+(focus?.id===text(l,"lineId")?" is-focus":"")} key={i}><strong>{[text(l,"lineId"),text(l,"sku")].filter(Boolean).join(" · ")||"Line item"}</strong>
        {Object.entries(l).filter(([k])=>k.endsWith("Quantity")).map(([k,v])=><div className={focus?.id===text(l,"lineId")&&focus.quantityKey===k?"pf-emphasis":""} key={k}>{human(k).replace(/ quantity$/i,"")} · {scalar(v)||"Not recorded"} {text(l,"unit")}</div>)}</div>)}
      {!!fields.length&&<Facts pairs={fields.map(([k,v])=>[human(k),scalar(v)])}/>}
      {!fields.length&&!full.lines.length&&<p>This revision has no recorded fields available to display.</p>}</section>
      <section className="pf-inset"><h3>{result?.kind==="original"?"Original content":"Source content"}</h3>
      {error?<><p role="alert">{error}</p><button className="pf-link" onClick={()=>setAttempt(a=>a+1)}>Try again</button></>
        :raw!==undefined?<>{loc&&<small>{loc}</small>}<pre>{range?<>{raw.slice(0,range[0])}<mark>{raw.slice(...range)}</mark>{raw.slice(range[1])}</>:raw}</pre>{result?.truncated&&<p>Showing the available preview of this original.</p>}</>
        :!result&&readOriginal&&eventKey?<p role="status">Loading source content…</p>
        :<p>{explanations[result?.reason||""]||"An original preview is unavailable for this record."}</p>}
      {(!readOriginal||!eventKey||result?.kind==="derived_excerpt")&&!!fields.length&&<details><summary>View recorded excerpt</summary><pre>{JSON.stringify(full.fields,null,2)}</pre></details>}</section></div>
    {artifact&&<section className="pf-inset"><h3>Linked original · {artifact.fileName}</h3>
      {/^(image\/(?:png|jpeg|webp|gif))$/i.test(artifact.mediaType)?<img className="pf-original-image" alt={artifact.fileName} src={"data:"+artifact.mediaType+";base64,"+artifact.bytesBase64}/>:
       artifact.mediaType==="application/zpl"?<pre>{new TextDecoder().decode(Uint8Array.from(atob(artifact.bytesBase64),c=>c.charCodeAt(0)))}</pre>:<p>{artifact.mediaType} · Inline preview unavailable.</p>}
      <Facts pairs={[["Attachment SHA-256",artifact.originalSha256],["Attachment receipt",artifact.receiptId]]}/></section>}
    <Facts pairs={[["Event time",dateLabel(source.eventTime)],["Received by PackProof",dateLabel(source.received)],["Source revision",source.version],["Integrity",result?.verified?"Verified":source.hash?"Fingerprint recorded":"Not checked"]]}/>
    <button className="pf-link" onClick={()=>onDetails(full)}>Source details</button></>;
}
