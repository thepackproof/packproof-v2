import { useEffect, useState } from "react";
import {flushStudyTimings} from '../analytics/study-capture';
import type { PackProofApi } from "../api/client";
import { listRecoverableRecordings, removePreservedLocalRecording, resumeLocalRecordings } from "../capture-queue";

export function LocalRecordingRecovery({api, userId, onOpen}: {api:PackProofApi;userId:string;onOpen:(id:string)=>void}) {
  const [items,setItems] = useState<Awaited<ReturnType<typeof listRecoverableRecordings>>>([]);
  const [error,setError] = useState<string|null>(null);
  useEffect(() => {
    let active = true, running = false;
    const update = async () => {
      if (running || !active) return;
      running = true;
      try {
        if(navigator.onLine!==false)void flushStudyTimings(api,userId).catch(()=>{});
        const before = await listRecoverableRecordings(userId,api);
        if (active) setItems(before);
        if (navigator.onLine !== false) await resumeLocalRecordings(api, userId, () => active);
        const after = await listRecoverableRecordings(userId,api);
        if (active) setItems(after);
      } catch { /* Capture reports unavailable IndexedDB before accepting local bytes. */ }
      finally { running = false; }
    };
    void update();
    const timer = window.setInterval(() => void update(), 15_000);
    window.addEventListener("online",update);
    window.addEventListener("focus",update);
    return () => { active=false; clearInterval(timer); window.removeEventListener("online",update); window.removeEventListener("focus",update); };
  },[api,userId]);
  if (!items.length) return null;
  return <aside className="local-recovery-panel" aria-label="Saved recordings">
    <details>
      <summary>{items.some(item=>!item.finalized && !item.submitted) ? "Recordings need attention" : "Saved originals on this device"} · {items.length}</summary>
      <p>Saved originals use {(items.reduce((sum,item)=>sum+item.file.size,0)/1_000_000).toFixed(1)} MB. Clearing browser data or losing this device can remove local-only work.</p>
      {error && <p role="alert">{error}</p>}
      <ul>{items.map(item=><li key={item.key}>
        <span>{item.finalized && item.preserved ? "Proof finalized and available" : item.submitted ? "Proof submitted. Local original kept until preservation is confirmed." : item.preserved ? "Recording preserved. Confirmation or finalization needed." : item.committed ? "Recording received. Preservation in progress." : item.accepted ? "Saved on this device. Upload pending." : "Saved on this device. Review and confirmation needed."} · {(item.file.size/1_000_000).toFixed(1)} MB</span>
        {item.errorMessage && <span>{item.errorMessage}</span>}
        {item.kind === "station" ? <a className="btn btn-secondary" href="/station">Review station recording</a> : <button className="btn btn-secondary" onClick={()=>onOpen(item.proofId)}>Open Proof</button>}
        <button className="btn btn-secondary" onClick={()=>{
          const url=URL.createObjectURL(item.file);const link=document.createElement("a");
          link.href=url;link.download=`packproof-local-recording.${item.file.type.includes("mp4")?"mp4":"webm"}`;link.click();
          window.setTimeout(()=>URL.revokeObjectURL(url),1000);
        }}>Export local original</button>
        {item.preserved && item.finalized && <button className="btn btn-secondary" onClick={async()=>{
          try { await removePreservedLocalRecording(userId,item.key,api); setItems(await listRecoverableRecordings(userId,api)); }
          catch(e) { setError(e instanceof Error?e.message:"Local copy could not be removed."); }
        }}>Remove completed local copy</button>}
      </li>)}</ul>
    </details>
  </aside>;
}
