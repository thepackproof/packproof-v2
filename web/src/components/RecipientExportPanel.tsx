import { randomId } from "../random-id";
import { useEffect, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";

type Profile = { id:string; destination:"EBAY_PAYMENT_DISPUTE"|"STRIPE_DISPUTE"; network:string; region:string; version:string; reviewRequired:boolean };
type FileInfo = { name:string; contentType:string; byteSize:number; sha256:string };
type Approval = { artifactSha256:string; actorUserId:string; approvedAt:string };
type Job = { jobId:string; proofId:string; caseId:string; state:string; artifactSha256:string|null; failureCode:string|null; approval?:Approval|null; artifact?:{files:FileInfo[];approvedNarrative:string;gaps:string[]}|null };
const states=new Set(["QUEUED","RENDERING","READY","FAILED"]),hash=/^[a-f0-9]{64}$/;
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==="object"&&!Array.isArray(v);
function profilesFrom(value:unknown):Profile[]{
  if(!object(value)||!Array.isArray(value.profiles)||value.profiles.length>20)throw new Error("Submission formats could not be read. Reload formats to try again.");
  const profiles=value.profiles;
  if(profiles.some(p=>!object(p)||typeof p.id!=="string"||!p.id||typeof p.version!=="string"||typeof p.reviewRequired!=="boolean"||!["EBAY_PAYMENT_DISPUTE","STRIPE_DISPUTE"].includes(String(p.destination))||typeof p.network!=="string"||typeof p.region!=="string")||new Set(profiles.map(p=>p.id)).size!==profiles.length)throw new Error("Submission formats could not be read. Reload formats to try again.");
  return profiles as Profile[];
}
function jobFrom(value:unknown,proofId:string,caseId:string):Job{
  const invalid=()=>new Error("The saved preparation response could not be read. Check preparation again; your case remains available.");
  if(!object(value)||typeof value.jobId!=="string"||!/^[A-Za-z0-9_-]{1,200}$/.test(value.jobId)||value.proofId!==proofId||value.caseId!==caseId||!states.has(String(value.state)))throw invalid();
  if(value.state==="READY"){
    const a=value.artifact;
    if(typeof value.artifactSha256!=="string"||!hash.test(value.artifactSha256)||!object(a)||!Array.isArray(a.files)||a.files.length<1||a.files.length>5||typeof a.approvedNarrative!=="string"||!Array.isArray(a.gaps)||a.gaps.some(g=>typeof g!=="string"))throw invalid();
    if(a.files.some(f=>!object(f)||typeof f.name!=="string"||!/^[A-Za-z0-9_-]+\.(pdf|jpg|jpeg|png)$/.test(f.name)||!["application/pdf","image/jpeg","image/png"].includes(String(f.contentType))||!Number.isSafeInteger(f.byteSize)||Number(f.byteSize)<1||Number(f.byteSize)>4500000||typeof f.sha256!=="string"||!hash.test(f.sha256))||new Set(a.files.map(f=>f.name)).size!==a.files.length)throw invalid();
    if(value.approval!=null&&(!object(value.approval)||value.approval.artifactSha256!==value.artifactSha256||typeof value.approval.actorUserId!=="string"||typeof value.approval.approvedAt!=="string"))throw invalid();
  }else if(value.approval!=null)throw invalid();
  return value as Job;
}
async function verifyPreview(blob:Blob,file:FileInfo){
  if(blob.size!==file.byteSize||!globalThis.crypto?.subtle)throw new Error("The preview could not be verified against the exact prepared file. Check preparation again.");
  const digest=await crypto.subtle.digest("SHA-256",await blob.arrayBuffer());
  const actual=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
  if(actual!==file.sha256)throw new Error("The preview does not match the prepared file. Check preparation again before approving.");
}
function failureMessage(code:string|null){
  if(code==="EXPORT_SOURCE_RESOLUTION")return "The source frame is too small for readable submission files. Choose a higher-resolution recording.";
  if(["EXPORT_BYTE_LIMIT","EXPORT_PAGE_LIMIT","EXPORT_FILE_COUNT_LIMIT","EXPORT_RELEVANCE_REQUIRED"].includes(code??""))return "This selection cannot fit the destination limits legibly. Choose fewer relevant frames or shorter text.";
  if(code==="EXPORT_PROFILE_STALE")return "The destination format needs an updated review before another packet can be prepared.";
  return "The files could not be prepared. Review the source selection or try again when preparation is available.";
}

export function RecipientExportPanel({api,userId,proofId,caseId,sources}:{api:PackProofApi;userId:string;proofId:string;caseId:string;sources:Array<{evidenceId:string;contentType:string}>}){
  const savedJobKey=`packproof.export.${api.recoveryScope}.${userId}.${proofId}.${caseId}`;
  const [profiles,setProfiles]=useState<Profile[]>([]),[profileId,setProfileId]=useState("");
  const [frames,setFrames]=useState<Array<{evidenceId:string;seconds:string;label:string}>>([]);
  const [narrative,setNarrative]=useState(""),[deadline,setDeadline]=useState(""),[reviewed,setReviewed]=useState(false);
  const [savedJob,setSavedJob]=useState<{scope:string;value:Job}|null>(null),[retryJobId,setRetryJobId]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[legible,setLegible]=useState(false),[previews,setPreviews]=useState<string[]>([]),[profileReload,setProfileReload]=useState(0),[previewReload,setPreviewReload]=useState(0);
  const epoch=useRef(0),scope=useRef(savedJobKey),requestKey=useRef(randomId());
  const job=savedJob?.scope===savedJobKey?savedJob.value:null;
  const path="recipient-exports",recordings=sources.filter(s=>s.contentType.startsWith("video/"));
  function publish(value:Job,version:number){if(version!==epoch.current||scope.current!==savedJobKey)return;setSavedJob({scope:savedJobKey,value});setRetryJobId(value.jobId);try{sessionStorage.setItem(savedJobKey,value.jobId);}catch{}}
  useEffect(()=>{
    scope.current=savedJobKey;epoch.current++;const version=epoch.current;
    setSavedJob(null);setRetryJobId(null);setError(null);setBusy(false);setLegible(false);setFrames([]);setNarrative("");setDeadline("");setReviewed(false);requestKey.current=randomId();
    let active=true;
    try{const id=sessionStorage.getItem(savedJobKey);if(id&&/^[A-Za-z0-9_-]{1,200}$/.test(id)){setRetryJobId(id);void api.featureRequest<unknown>(proofId,`${path}/${encodeURIComponent(id)}`).then(value=>{const parsed=jobFrom(value,proofId,caseId);if(active)publish(parsed,version);}).catch(e=>{if(active&&epoch.current===version)setError(e instanceof Error?e.message:"The saved preparation could not be reopened. Check preparation again.");});}}catch{}
    return()=>{active=false;epoch.current++;};
  },[api,proofId,caseId,savedJobKey]);
  useEffect(()=>{
    let active=true;setProfiles([]);setProfileId("");
    void api.featureRequest<unknown>(proofId,`${path}/profiles`).then(result=>{const parsed=profilesFrom(result);if(active){setProfiles(parsed);setProfileId(parsed.find(p=>!p.reviewRequired)?.id??"");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:"Submission formats are temporarily unavailable. Reload formats to try again.");});
    return()=>{active=false;};
  },[api,proofId,profileReload]);
  useEffect(()=>{
    if(!job||!["QUEUED","RENDERING"].includes(job.state))return;
    let active=true,running=false;const version=epoch.current;
    const timer=window.setInterval(async()=>{if(running)return;running=true;try{const parsed=jobFrom(await api.featureRequest<unknown>(proofId,`${path}/${encodeURIComponent(job.jobId)}`),proofId,caseId);if(active)publish(parsed,version);}catch(e){if(active)setError(e instanceof Error?e.message:"Preparation status is temporarily unavailable. Check preparation again.");}finally{running=false;}},3000);
    return()=>{active=false;clearInterval(timer);};
  },[api,proofId,caseId,job?.jobId,job?.state]);
  useEffect(()=>{
    let active=true;const urls:string[]=[];setPreviews([]);setLegible(false);
    if(job?.state==="READY"&&job.artifact)void Promise.all(job.artifact.files.map(async(file,index)=>{
      const blob=await api.featureDownload(proofId,`${path}/${encodeURIComponent(job.jobId)}/files/${index}?preview=true`);await verifyPreview(blob,file);
      if(!active)return "";const url=URL.createObjectURL(blob);urls.push(url);return url;
    })).then(values=>{if(active)setPreviews(values);}).catch(e=>{urls.forEach(URL.revokeObjectURL);if(active){active=false;setPreviews([]);setError(e instanceof Error?e.message:"The exact files could not be opened. Check preparation again.");}});
    return()=>{active=false;urls.forEach(URL.revokeObjectURL);};
  },[api,proofId,job?.jobId,job?.state,job?.artifactSha256,previewReload]);
  function changed(){epoch.current++;try{sessionStorage.removeItem(savedJobKey);}catch{}setSavedJob(null);setRetryJobId(null);setLegible(false);requestKey.current=randomId();setError(null);}
  async function run(action:(version:number)=>Promise<void>){if(busy)return;const version=epoch.current;setBusy(true);setError(null);try{await action(version);}catch(e){if(epoch.current===version)setError(e instanceof Error?e.message:"This action could not finish. Retry shortly.");}finally{if(epoch.current===version)setBusy(false);}}
  const canPrepare=reviewed&&Number.isFinite(Date.parse(deadline))&&Date.parse(deadline)>Date.now()&&profileId&&frames.length&&frames.every(f=>f.label.trim()&&f.seconds!==""&&Number.isFinite(Number(f.seconds))&&Number(f.seconds)>=0&&Number(f.seconds)<=21600);
  return <section className="recipient-export-panel stack" aria-label="Submission files">
    <h4>Prepare submission files</h4>
    <p>Choose the format required by your actual case. Select the source moments that show relevant facts, then review the finished files.</p>
    {error&&<p role="alert">{error}</p>}
    {!profiles.length&&<button className="btn btn-secondary" disabled={busy} onClick={()=>{setError(null);setProfileReload(n=>n+1);}}>Reload submission formats</button>}
    <fieldset disabled={busy} className="stack">
      <legend>Source selection and destination</legend>
      <label className="field"><span>Destination</span><select value={profileId} onChange={e=>{changed();setProfileId(e.target.value);}}><option value="">Choose a format</option>{profiles.map(p=><option key={p.id} value={p.id} disabled={p.reviewRequired}>{p.destination==="EBAY_PAYMENT_DISPUTE"?"eBay payment dispute · images":`Stripe dispute · ${p.network==="MASTERCARD"?"Mastercard":"other networks"} · PDF`} · {p.region}{p.reviewRequired?" · requires updated review":""}</option>)}</select></label>
      <label className="field"><span>Submission deadline from your case</span><input type="datetime-local" value={deadline} onChange={e=>{changed();setDeadline(e.target.value);}}/></label>
      <label className="row"><input type="checkbox" checked={reviewed} onChange={e=>{changed();setReviewed(e.target.checked);}}/>I checked the current instructions and deadline for this case.</label>
      {frames.map((frame,index)=><fieldset key={index}><legend>Frame {index+1}</legend>
        <label className="field"><span>Recording</span><select value={frame.evidenceId} onChange={e=>{changed();setFrames(old=>old.map((f,i)=>i===index?{...f,evidenceId:e.target.value}:f));}}>{recordings.map((r,i)=><option key={r.evidenceId} value={r.evidenceId}>Recording {i+1}</option>)}</select></label>
        <label className="field"><span>Time in recording (seconds)</span><input type="number" min="0" max="21600" step="0.001" value={frame.seconds} onChange={e=>{changed();setFrames(old=>old.map((f,i)=>i===index?{...f,seconds:e.target.value}:f));}}/></label>
        <label className="field"><span>Factual label</span><input maxLength={120} value={frame.label} onChange={e=>{changed();setFrames(old=>old.map((f,i)=>i===index?{...f,label:e.target.value}:f));}}/></label>
        <button className="btn btn-secondary" onClick={()=>{changed();setFrames(old=>old.filter((_,i)=>i!==index));}}>Remove frame</button>
      </fieldset>)}
      <button className="btn btn-secondary" disabled={!recordings.length||frames.length>=4} onClick={()=>{changed();setFrames(old=>[...old,{evidenceId:recordings[0].evidenceId,seconds:"0",label:""}]);}}>Add a source frame</button>
      <label className="field"><span>Supporting text · your statement</span><textarea maxLength={2000} value={narrative} onChange={e=>{changed();setNarrative(e.target.value);}}/></label>
      <button className="btn" disabled={!canPrepare} onClick={()=>void run(async version=>{const parsed=jobFrom(await api.featureRequest<unknown>(proofId,path,"POST",{caseId,profileId,frames:frames.map(f=>({evidenceId:f.evidenceId,offsetMs:Math.round(Number(f.seconds)*1000),label:f.label})),narrative,destinationDeadline:new Date(deadline).toISOString(),destinationInstructionsReviewed:true,idempotencyKey:requestKey.current}),proofId,caseId);publish(parsed,version);})}>Prepare exact files</button>
    </fieldset>
    {job&&["QUEUED","RENDERING"].includes(job.state)&&<p role="status">Your files are being prepared. The original recording stays unchanged.</p>}
    {retryJobId&&<button className="btn btn-secondary" disabled={busy} onClick={()=>void run(async version=>{const parsed=jobFrom(await api.featureRequest<unknown>(proofId,`${path}/${encodeURIComponent(retryJobId)}`),proofId,caseId);publish(parsed,version);setPreviewReload(n=>n+1);})}>Check preparation again</button>}
    {job?.state==="FAILED"&&<p role="alert">{failureMessage(job.failureCode)}</p>}
    {job?.state==="READY"&&job.artifact&&<div className="stack">
      <h4>Exact files for approval</h4>
      {job.artifact.files.map((file,index)=><figure key={`${index}-${file.name}`}><figcaption>{file.name} · {(file.byteSize/1000).toFixed(0)} KB</figcaption>{previews[index]&&(file.contentType==="application/pdf"?<iframe title={`Preview ${file.name}`} src={previews[index]} style={{width:"100%",height:"32rem"}}/>:<img src={previews[index]} alt={`Submission file ${index+1}: ${file.name}`} style={{maxWidth:"100%",height:"auto"}}/>)}</figure>)}
      <p>{job.artifact.approvedNarrative}</p><ul>{job.artifact.gaps.map((gap,i)=><li key={i}>{gap}</li>)}</ul>
      {!job.approval&&<label className="row"><input type="checkbox" checked={legible} onChange={e=>setLegible(e.target.checked)}/>I reviewed these exact files and text; the relevant details are readable.</label>}
      <button className="btn" disabled={busy||(!job.approval&&(!legible||previews.length!==job.artifact.files.length))} onClick={()=>void run(async version=>{
        if(!job.approval){const approved=jobFrom(await api.featureRequest<unknown>(proofId,`${path}/${encodeURIComponent(job.jobId)}/approve`,"POST",{artifactSha256:job.artifactSha256,legibilityConfirmed:true}),proofId,caseId);if(!approved.approval||approved.artifactSha256!==job.artifactSha256)throw new Error("Approval was not confirmed for these exact files. Check preparation again.");publish(approved,version);}
        const blob=await api.featureDownload(proofId,`${path}/${encodeURIComponent(job.jobId)}/download`);if(version!==epoch.current)return;const url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download="packproof-submission-files.zip";anchor.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
      })}>{job.approval?"Download approved files again":"Approve and download files"}</button>
      <p className="note">Upload the files in the submission folder to your case. PackProof has not submitted a dispute or confirmed portal acceptance.</p>
    </div>}
  </section>;
}
