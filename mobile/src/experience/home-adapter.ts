import type { LocalCapture } from '../capture';
import type { FulfillmentQueueItem, ProofCollectionItem, InvitationInboxView } from '../v2-api';
import { mergeProofInvitations, presentationForProof } from '../copy/proof-list';
import { orderPresentation } from '../copy/orders';
import type { HomeInput } from './task-home';

export function nativeHomeInput(input:{proofs:ProofCollectionItem[];invitations:InvitationInboxView[];captures:LocalCapture[];orders:FulfillmentQueueItem[];progress:Record<string,number|null>;userId:string;apiBaseUrl:string;online:boolean;reconciled:boolean;selection?:string|null;interactions?:Record<string,number>}):HomeInput {
  const rows=mergeProofInvitations(input.proofs,input.invitations);
  const captures=[...new Map(input.captures.filter(c=>c.captureUserId===input.userId && c.recovery?.apiBaseUrl.replace(/\/+$/,'')===input.apiBaseUrl.replace(/\/+$/,'')).map(c=>[c.captureSessionId || c.uri,c])).values()].filter(c=>!['FINALIZED','SUBMITTED'].includes(c.recovery?.phase ?? ''));
  return {
    ...input,
    proofs:rows.map(row=>{
      const p=presentationForProof(row,row.role);
      return {id:row.proofId,title:row.transaction.itemTitle||'Shipment Proof',status:row.status,authorized:Boolean(row.role || row.invitationId || row.accessKind==='RECEIVER'),createdAt:row.createdAt,updatedAt:row.updatedAt,completed:p.completed,continuationAfterFinalization:p.canContribute===true&&p.nextAction.type==='WORKFLOW_ACTION',
        action:p.diagnostic?'unknown':p.nextAction.type==='ACCEPT_INVITATION'?'continue':!p.canContribute?'view':p.nextAction.type==='RECORD_PACKING'?'capture':p.nextAction.type==='REVIEW_CONFIRM'?'finalize':p.nextAction.type==='WORKFLOW_ACTION'?'continue':'view'};
    }),
    captures:captures.map(c=>({id:c.captureSessionId||c.uri,proofId:c.captureProofId!,authorized:true,usable:c.localFileAvailable!==false && c.encodedInspection?.playable!==false && c.recovery?.phase!=='RECORDING' && Number(c.byteSize)>0 && Number(c.durationMs)>0,
      interrupted:c.recovery?.phase==='RECORDING',needsReview:c.recovery?.phase==='LOCAL_ONLY' || c.recovery?.phase==='CONFIRMATION_NEEDED' || (!c.recovery?.submitRequested && c.recovery?.phase!=='RECORDING')})),
    jobs:captures.filter(c=>c.recovery?.submitRequested || ['NEEDS_ATTENTION','NEEDS_SIGN_IN','RECORDING','DISCARD_PENDING'].includes(c.recovery?.phase??'')).map(c=>({id:c.captureSessionId||c.uri,proofId:c.captureProofId!,authorized:true,
      active:c.recovery?.phase==='UPLOADING' && typeof input.progress[c.captureProofId!]==='number' && input.progress[c.captureProofId!]!<100 && input.online,
      waiting:!input.online && Boolean(c.recovery?.submitRequested),
      intervention:['NEEDS_SIGN_IN','NEEDS_ATTENTION','RECORDING'].includes(c.recovery?.phase??'') || Boolean(c.recovery?.lastError && !c.recovery.lastError.retryable),
      reason:c.recovery?.phase==='RECORDING'?'This interrupted recording did not finish saving a playable video.':c.recovery?.lastError?.message})),
    orders:input.orders.map(o=>({id:o.transactionId,proofId:o.proofId,title:o.itemSummary,ready:orderPresentation(o).state==='ready',authorized:rows.some(p=>p.proofId===o.proofId&&p.role==='SELLER'),createdAt:o.orderedAt||''})),
  };
}
