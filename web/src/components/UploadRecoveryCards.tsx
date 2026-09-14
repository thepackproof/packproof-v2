import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";
import type { CanonicalProof } from "../api/types";
import { discardLocalRecording, listRecoverableRecordings, resumeLocalRecording, type LocalRecordingSummary } from "../capture-queue";
import { uploadRecoveryPresentation } from "../../../mobile/src/capture/upload-recovery";

export function UploadRecoveryCards({api,userId,proof,onReview,onStage}: {api:PackProofApi;userId:string;proof:CanonicalProof;onReview?:()=>void;onStage?:()=>void}) {
  const [items,setItems] = useState<LocalRecordingSummary[] | null>(null);
  const [offline,setOffline] = useState(navigator.onLine === false);
  const [busy,setBusy] = useState<string|null>(null), [error,setError] = useState<{key:string;message:string}|null>(null);
  useEffect(()=>{
    let active=true;
    const update=()=>{setOffline(navigator.onLine===false);void listRecoverableRecordings(userId,api).then(rows=>{if(active)setItems(rows.filter(item=>item.proofId===proof.proofId));}).catch(()=>{if(active)setItems([]);});};
    update();
    for(const event of ["online","offline","packproof:uploads-updated","packproof:records-updated"])window.addEventListener(event,update);
    return()=>{active=false;for(const event of ["online","offline","packproof:uploads-updated","packproof:records-updated"])window.removeEventListener(event,update);};
  },[api,userId,proof.proofId,proof.version]);
  const local=(items??[]).filter(item=>!item.finalized&&!item.submitted);
  const rows=[...local.map(item=>({key:item.key,item,evidenceId:item.evidenceId})),...proof.evidence.filter(row=>row.validationStatus==="PENDING"&&row.submittedBy===userId&&!local.some(item=>item.evidenceId===row.evidenceId)).map(row=>({key:row.evidenceId,item:undefined,evidenceId:row.evidenceId}))];
  async function act(key:string,run:()=>Promise<void>){setBusy(key);setError(null);try{await run();}catch(e){setError({key,message:e instanceof Error?e.message:"Upload recovery was interrupted. Your recording was kept."});}finally{setBusy(null);window.dispatchEvent(new Event("packproof:records-updated"));}}
  return <>{rows.map(({key,item,evidenceId})=>{
    const committed=!!item?.committed||proof.evidence.some(row=>row.evidenceId===evidenceId&&row.validationStatus==="COMMITTED")||!!proof.commerceStages?.some(stage=>stage.evidence.some(row=>row.evidenceId===evidenceId&&row.committedAt));
    const view=uploadRecoveryPresentation({available:items===null?null:!!item?.available,active:!!item?.active,offline,committed,accepted:item?.accepted,failed:item?.retryStopped,discarding:item?.discardRequested});
    return <section key={key} className="upload-recovery-card stack" aria-label="Recording upload recovery">
      <h3 aria-live="polite">{view.title}</h3><p>{view.message}</p>
      {error?.key===key&&<p role="alert">{error.message}</p>}
      <div className="actions">
        {view.resume&&item&&<button className="btn btn-primary" disabled={!!busy||offline} onClick={()=>{
          if(!item.accepted){(item.kind==="stage"?onStage:onReview)?.();return;}
          void act(key,()=>resumeLocalRecording(api,userId,item));
        }}>{view.resume}</button>}
        {view.discard&&<button className="btn btn-secondary" disabled={!!busy} onClick={()=>{
          if(!window.confirm("Discard this incomplete recording? Committed evidence is protected."))return;
          void act(key,()=>item?discardLocalRecording(api,userId,item.key):api.discardIncompleteEvidence(proof.proofId,evidenceId!));
        }}>{view.discard}</button>}
      </div>
    </section>;
  })}</>;
}
