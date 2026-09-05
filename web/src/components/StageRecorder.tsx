import {useEffect,useRef,useState} from "react";
import type {PackProofApi} from "../api/client";
import {ReturnAngleGuide} from "./ReturnAngleGuide";
import {CaptureCoach,type CaptureBookmark} from "./CaptureCoach";
import {clearStageCapture,recoverStageCapture,saveStageCapture,stageCaptureKey,type PendingStageCapture} from "../capture-queue";
export function StageRecorder({api,userId,proofId,stageType,stageId,onSaved}:{api:PackProofApi;userId:string;proofId:string;stageType:string;stageId?:string;onSaved:()=>Promise<void>}){
  const [guide,setGuide]=useState<string|null>(null);
  const [pending,setPending]=useState<PendingStageCapture|null>(null),[recording,setRecording]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[url,setUrl]=useState<string|null>(null),[marks,setMarks]=useState<CaptureBookmark[]>([]);
  const video=useRef<HTMLVideoElement>(null),stream=useRef<MediaStream|null>(null),recorder=useRef<MediaRecorder|null>(null),started=useRef(0),marksRef=useRef(marks),journal=useRef(Promise.resolve()),base=useRef<Omit<PendingStageCapture,"file">|null>(null);
  const key=stageCaptureKey(userId,proofId,stageType);marksRef.current=marks;
  useEffect(()=>{let active=true;void recoverStageCapture(key).then(p=>{if(active)setPending(p);}).catch(e=>setError(e.message));return()=>{active=false;if(recorder.current?.state==="recording")recorder.current.stop();stream.current?.getTracks().forEach(t=>t.stop());};},[key]);
  useEffect(()=>{if(!pending){setUrl(null);return;}const next=URL.createObjectURL(pending.file);setUrl(next);return()=>URL.revokeObjectURL(next);},[pending]);
  useEffect(()=>{if(recording&&video.current)video.current.srcObject=stream.current;},[recording]);
  async function start(){if(busy||recording||pending)return;setBusy(true);setError(null);try{
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==="undefined")throw new Error("Use a supported camera browser or the PackProof mobile app to record this stage.");
    stream.current=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280}},audio:false});
    const stage=stageId?{stageId}:await api.lifecycleRequest<{stageId:string}>(proofId,"/stages","POST",{type:stageType});
    const session=await api.createCaptureSession(proofId,crypto.randomUUID(),stage.stageId);
    const mime=["video/webm;codecs=vp8","video/mp4","video/webm"].find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw new Error("This browser cannot produce a supported camera recording.");
    const rec=new MediaRecorder(stream.current,{mimeType:mime,videoBitsPerSecond:2_000_000}),chunks:BlobPart[]=[];recorder.current=rec;started.current=performance.now();setMarks([]);
    base.current={key,stageId:stage.stageId,captureSessionId:session.id,uploadKey:crypto.randomUUID(),interrupted:true,bookmarks:[]};
    rec.ondataavailable=e=>{if(!e.data.size||!base.current)return;chunks.push(e.data);const file=new Blob(chunks,{type:mime.split(";")[0]});const saved={...base.current,file,bookmarks:marksRef.current.map(m=>({label:m.label,startMs:m.startMs,sourceType:m.sourceType,recipeVersion:m.recipeVersion}))};journal.current=journal.current.then(()=>saveStageCapture(saved)).catch(e=>{setError(e.message);if(rec.state==="recording")rec.stop();});if(file.size>190*1024*1024||performance.now()-started.current>29*60*1000)rec.stop();};
    rec.onstop=()=>{stream.current?.getTracks().forEach(t=>t.stop());setRecording(false);void journal.current.then(async()=>{const saved=await recoverStageCapture(key);setPending(saved);});};
    rec.onerror=()=>setError("Camera interrupted. Any recoverable segment stays attached to this stage; missing footage cannot be restored.");rec.start(2000);setRecording(true);
  }catch(e){stream.current?.getTracks().forEach(t=>t.stop());setError(e instanceof Error?e.message:"Camera unavailable.");}finally{setBusy(false);}}
  function stop(){if(base.current)base.current.interrupted=false;if(recorder.current?.state==="recording")recorder.current.stop();}
  async function save(){if(!pending||busy)return;setBusy(true);setError(null);try{
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await pending.file.arrayBuffer())),v=>v.toString(16).padStart(2,"0")).join("");
    await api.completeCaptureSession(proofId,pending.captureSessionId,{sha256:digest,byteSize:pending.file.size,contentType:pending.file.type,interrupted:pending.interrupted});
    const init=await api.lifecycleRequest<{evidenceId:string;upload:Parameters<PackProofApi["uploadObject"]>[0]}>(proofId,`/stages/${pending.stageId}/evidence`,"POST",{contentType:pending.file.type,idempotencyKey:pending.uploadKey,captureSessionId:pending.captureSessionId});
    const current=await api.lifecycleRequest<{stages:Array<{stageId:string;evidence:Array<{evidenceId:string;committedAt:string|null}>}>}>(proofId,"");
    if(!current.stages.find(s=>s.stageId===pending.stageId)?.evidence.some(e=>e.evidenceId===init.evidenceId&&e.committedAt)){
      await api.uploadObject(init.upload,pending.file,pending.file.type);await api.lifecycleRequest(proofId,`/stages/${pending.stageId}/evidence/${init.evidenceId}/commit`,"POST",{});
    }
    for(const [i,m]of pending.bookmarks.entries())try{await api.featureRequest(proofId,"signature/anchors","POST",{evidenceId:init.evidenceId,stageId:pending.stageId,startMs:m.startMs,endMs:m.startMs+1,label:m.label,sourceType:m.sourceType||"USER_MARKED",recipeVersion:m.recipeVersion,idempotencyKey:`${pending.uploadKey}-chapter-${i}`});}catch{/* The committed original remains usable without optional chapters. */}
    await clearStageCapture(key);setPending(null);await onSaved();
  }catch(e){setError(e instanceof Error?e.message:"Could not save. The local original is retained for retry.");}finally{setBusy(false);}}
  return <div className="stack">{!pending&&<ReturnAngleGuide api={api} proofId={proofId} onGuide={setGuide}/>} {error&&<p className="banner banner-error" role="alert">{error}</p>}{recording?<><div className="camera-live-frame"><video ref={video} muted autoPlay playsInline aria-label="Live stage camera"/><div className="camera-guide" aria-hidden="true"/>{guide&&<img src={guide} alt="Positioning overlay only" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"contain",opacity:.25,pointerEvents:"none"}}/>}</div><CaptureCoach video={video} recording startedAt={started.current} bookmarks={marks} onBookmark={m=>setMarks(v=>[...v,m])}/><button className="btn btn-danger" onClick={stop}>Stop recording and review</button></>:pending?<><video src={url||undefined} controls playsInline aria-label="Review captured stage recording"/>{pending.interrupted&&<p className="banner banner-warning">Recovered segment from an interrupted recording. Review what is visible; the record does not establish missing footage.</p>}<p className="note">This local original is bound to the same account, Proof and stage. Keep this browser’s data until saving succeeds.</p><button className="btn" disabled={busy} onClick={()=>void save()}>{busy?"Preserving original…":"Save this stage recording"}</button></>:<><p className="note">Keep the package, label and item in view. Capture front, reverse, identifier and condition at comparable angles. Camera guidance is advisory and is not evidence.</p><button className="btn" disabled={busy} onClick={()=>void start()}>{busy?"Preparing camera…":"Record with this camera"}</button></>}</div>;
}
