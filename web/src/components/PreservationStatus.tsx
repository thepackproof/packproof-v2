import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";
import { requiresDurableReceipts } from "../capture-preflight";

export type RecoveryView = {
  proofId:string;
  evidence:Array<{evidenceId:string;status:string;receipt:unknown}>;
  declarations:Array<{attestationId:string;status:string;receipt:unknown}>;
  stages?:Array<{stageId:string;status:string;receipt:unknown}>;
  finalization:{status:string;receipt:unknown};
};

export function preservationMessage(view:RecoveryView|null, durableReceiptsRequired=true, submitted=false):string {
  if (!view?.finalization || !Array.isArray(view.evidence)) return "Preservation status is unavailable. Keep your local recording until it is confirmed.";
  if (view.finalization.status === "PRESERVED" && view.finalization.receipt) return "Proof finalized and available.";
  if (view.evidence.some(e=>e.status === "FAILED")) return "Preservation needs attention. Keep your local recording and retry.";
  if (!durableReceiptsRequired && submitted) return "Proof submitted. Keep your local original until preservation is confirmed.";
  if (view.evidence.length && view.evidence.every(e=>e.status === "PRESERVED" && e.receipt)) return "Recording preserved. Confirmation or finalization is still needed.";
  if (view.evidence.length) return "Recording received. Preservation in progress.";
  return "No recording has been received yet.";
}

export function PreservationStatus({api,proofId}:{api:PackProofApi;proofId:string}) {
  const [view,setView] = useState<RecoveryView|null>(null);
  const [required,setRequired] = useState(true),[submitted,setSubmitted] = useState(false);
  useEffect(()=>{
    let active=true,running=false;
    const load=async()=>{
      if(running)return;
      running=true;
      try {
        const [value,strict,proof]=await Promise.all([api.getRecoveryStatus(proofId),requiresDurableReceipts(api),Promise.resolve().then(()=>api.getProof(proofId)).catch(()=>null)]);
        if(active){setView(value);setRequired(strict);setSubmitted(proof?.proofId===proofId&&proof.status==="FINALIZED");}
      }
      catch { if(active)setView(null); }
      finally{running=false;}
    };
    void load(); const timer=window.setInterval(load,15000);
    return ()=>{active=false;window.clearInterval(timer);};
  },[api,proofId]);
  return <p className="preservation-status" role="status">{preservationMessage(view,required,submitted)}</p>;
}
