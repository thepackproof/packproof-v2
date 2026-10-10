import { presentationForProof } from '../copy/proof-list';
import { isGradingWorkflow, nextActionNeedsCapture } from '../copy/custody';
import type { ProofView } from '../v2-api';
/** Only call with a freshly authorized response. No cached list action is an input. */
export function freshProofDestination(proof:ProofView,userId:string): {route:'capture'|'finalize'|'proof'|'receipt';notice?:string} {
  const role=proof.participants.find(p=>p.userId===userId)?.role;
  const presentation=presentationForProof(proof,role);
  if(proof.status==='FINALIZED' && role && presentation.canContribute && !presentation.diagnostic && presentation.nextAction.type==='WORKFLOW_ACTION')return {route:'receipt'};
  if(proof.status==='FINALIZED')return {route:'proof',notice:'This Proof has already been finalized. The current record is open.'};
  if(!role || presentation.diagnostic || !presentation.canContribute)return {route:'proof',notice:'The available next step changed. Review the current Proof.'};
  if(presentation.nextAction.type==='RECORD_PACKING')return {route:'capture'};
  if(presentation.nextAction.type==='REVIEW_CONFIRM')return {route:'finalize'};
  return {route:'proof'};
}

/** A local original permits playback, but only fresh canonical permission permits resuming its workflow. */
export function savedCaptureDestination(proof:ProofView|null,userId:string): {route:'capture'|'finalize'|'proof'|'receipt';allowResume:boolean;reviewOnly:boolean;notice:string|null} {
  if(!proof)return {route:'capture',allowResume:false,reviewOnly:true,notice:'Offline review only. Your original remains on this device. Reconnect to check the current Proof before submitting or recording again.'};
  const role=proof.participants.find(p=>p.userId===userId)?.role;
  const presentation=presentationForProof(proof,role);
  if(proof.status!=='FINALIZED' && role && isGradingWorkflow(proof.workflowType) && presentation.canContribute && !presentation.diagnostic && nextActionNeedsCapture(proof.nextAction?.type))
    return {route:'capture',allowResume:true,reviewOnly:false,notice:null};
  const destination=freshProofDestination(proof,userId);
  if(destination.route==='capture')return {route:'capture',allowResume:true,reviewOnly:false,notice:null};
  return {...destination,allowResume:false,reviewOnly:false,notice:`${destination.notice??'The next step for this Proof changed.'} Your local recording is retained in Activity.`};
}
