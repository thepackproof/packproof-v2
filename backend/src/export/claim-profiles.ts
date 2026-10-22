import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {DomainError} from '../domain/errors.js';
import {getClaimCase,type ClaimSnapshot} from '../domain/claim-cases.js';
import type {SignatureCasePreview} from '../domain/signature.js';
import {recipientProfile,type RecipientProfile} from './recipient-profiles.js';
import {requireDurableOperation} from '../domain/recovery-journal.js';

const fail=(code:string,message:string)=>new DomainError(code,message,409);
export interface ClaimExportBinding {
 claimCaseId:string;snapshotSha256:string;snapshot:ClaimSnapshot;
 action:'EXPORT_FOR_MERCHANT_REVIEW';providerSubmission:'UNAVAILABLE';
 evidenceProfile:{id:string;version:string;provider:'stripe';apiVersion:'MANUAL_PORTAL';reasonCode:string;network:string;recipientProfileId:string;requiredFacts:string[]};
}
const REQUIREMENTS:Record<string,string[]>={
 product_not_received:['transaction and affected items','carrier-reported delivery and destination match','customer communications','selected packing observations and coverage limitations'],
 product_unacceptable:['transaction description and affected items','condition and item identifiers in preserved sources','return or inspection observations, including contrary observations','customer communications and applicable policy'],
};
function eligible(s:ClaimSnapshot,clock:Clock){
 if(s.region!=='US'||s.paymentMethod!=='CARD')throw fail('CLAIM_PROFILE_UNSUPPORTED','This case has no reviewed region and payment method.');
 if(!['needs_response','warning_needs_response'].includes(s.lifecycleStatus)||!s.allowedActions.includes('RESPOND'))throw fail('CLAIM_ACTION_UNAVAILABLE','The reported case does not currently allow a response.');
 if(!s.providerDeadline||Date.parse(s.providerDeadline)<=clock.now().getTime())throw fail('CLAIM_DEADLINE_PASSED','Record the actual future provider deadline before preparing or approving a packet.');
 const age=clock.now().getTime()-Date.parse(s.retrievedAt);
 if(age<0||age>86400000)throw fail('CLAIM_REFRESH_REQUIRED','Check the current portal and record a case observation within the past 24 hours.');
}
export async function bindClaimExport(db:Database,clock:Clock,actor:string,proofId:string,input:Record<string,unknown>,profile:RecipientProfile):Promise<ClaimExportBinding>{
 if(typeof input.claimCaseId!=='string'||typeof input.claimSnapshotSha256!=='string')throw fail('CLAIM_BINDING_REQUIRED','Select the exact current dispute case revision.');
 const c=await getClaimCase(db,actor,proofId,input.claimCaseId),s=c.snapshot;
 if(c.snapshotSha256!==input.claimSnapshotSha256)throw fail('CLAIM_REVISION_CHANGED','Review the current case revision before preparing files.');
 eligible(s,clock);
 if(s.provider!=='stripe'||!REQUIREMENTS[s.reasonCode]||s.network==='UNKNOWN')throw fail('CLAIM_PROFILE_UNSUPPORTED','This provider, reason or unknown card network has no reviewed claim profile.');
 const expected=recipientProfile(`stripe-dispute-us-${s.network==='MASTERCARD'?'mastercard':'other'}-v2`,clock.now());
 if(profile.id!==expected.id)throw fail('CLAIM_PROFILE_MISMATCH','Choose the current recipient profile for this case provider and card network.');
 if(typeof input.destinationDeadline!=='string'||Date.parse(input.destinationDeadline)!==Date.parse(s.providerDeadline!))throw fail('CLAIM_DEADLINE_MISMATCH','The packet deadline must match the selected case revision.');
 return {claimCaseId:c.claimCaseId,snapshotSha256:c.snapshotSha256,snapshot:s,action:'EXPORT_FOR_MERCHANT_REVIEW',providerSubmission:'UNAVAILABLE',evidenceProfile:{id:`stripe-manual-physical-${s.reasonCode}-${s.network.toLowerCase()}-2026-10-22.1`,version:'2026-10-22.1',provider:'stripe',apiVersion:'MANUAL_PORTAL',reasonCode:s.reasonCode,network:s.network,recipientProfileId:expected.id,requiredFacts:[...REQUIREMENTS[s.reasonCode]]}};
}
/** Hold this row lock within the caller's short commit transaction. Rendering
 * and object reads happen outside it; a revision cannot race final approval. */
export async function assertClaimExportCurrent(db:Database,clock:Clock,actor:string,proofId:string,b:ClaimExportBinding){
 await db.query('SELECT id FROM claim_cases WHERE id=$1 AND proof_id=$2 FOR SHARE',[b.claimCaseId,proofId]);
 const current=await getClaimCase(db,actor,proofId,b.claimCaseId);
 if(current.snapshotSha256!==b.snapshotSha256||sha256Hex(canonicalize(b.snapshot))!==b.snapshotSha256)throw fail('CLAIM_REVISION_CHANGED','Case details changed. Prepare and approve a new packet for the current revision.');
 eligible(current.snapshot,clock);
 await requireDurableOperation(db,`claim-revision:${current.revisionId}`);
 if(b.action!=='EXPORT_FOR_MERCHANT_REVIEW'||b.providerSubmission!=='UNAVAILABLE')throw fail('CLAIM_ACTION_UNAVAILABLE','Provider submission is not enabled.');
 recipientProfile(b.evidenceProfile.recipientProfileId,clock.now());
}
/** References identify where a reviewer can inspect support. They do not infer
 * scene truth, delivery, address match or an assertion from a selected frame. */
export function claimEvidenceSelection(p:SignatureCasePreview,b:ClaimExportBinding,frames:Array<{evidenceId:string;offsetMs:number;label:string}>){
 const refs:Array<{kind:string;reference:string;sha256:string;timestampMs?:number;attribution:string}>=[];
 if(p.order)refs.push({kind:'TRANSACTION_SNAPSHOT',reference:`${p.snapshotId}#/order`,sha256:p.snapshotSha256,attribution:p.order.source});
 for(const event of p.shipping?.events??[])if(event.sourceHash)refs.push({kind:'SHIPPING_OBSERVATION',reference:event.eventId,sha256:event.sourceHash,attribution:`${event.source}; ${event.provider??'none'}; ${event.providerEnvironment??'unknown'}`});
 for(const frame of frames){const source=p.evidence.find(e=>e.evidenceId===frame.evidenceId);if(!source)throw fail('CLAIM_SOURCE_SCOPE','A selected frame is outside the frozen review scope.');refs.push({kind:'SELECTED_FRAME',reference:source.evidenceId,sha256:source.sha256,timestampMs:frame.offsetMs,attribution:'USER_SELECTED_OBSERVATION_NOT_VERIFIED_ASSERTION'});}
 for(const observation of p.observations??[])refs.push({kind:'COMPARISON_OBSERVATION',reference:observation.comparisonId,sha256:p.snapshotSha256,attribution:observation.source});
 return {profileId:b.evidenceProfile.id,sourceSnapshotSha256:p.snapshotSha256,references:refs,requirements:b.evidenceProfile.requiredFacts,
  gaps:[...p.gaps,'Provider case details and allowed actions are merchant-reported and have not been retrieved by PackProof.','The provider dispute opening time is unavailable; this export does not establish pre-dispute preservation.','Customer communications and applicable policy documents are not included by this export.','Address match, delivery to the cardholder and truth of recorded scenes are not established.',...(!b.snapshot.orderLineIds.length?['Payment-only scope; no allocation to individual order lines is declared.']:[]),...(!p.shipping?.events.length?['No shipping observation is included.']:[]),...(!p.observations?.length?['No return/comparison observation is included; absence is not evidence that none exists.']:[])],
  contraryObservations:p.observations??[],scope:p.scope,selection:'EXPLICIT_REVIEWER_SELECTION' as const};
}
