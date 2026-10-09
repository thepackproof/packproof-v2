import { presentationForProof } from '../copy/proof-list';
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
