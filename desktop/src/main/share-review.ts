import type { PublicProofView } from '../../../web/src/api/types';
import type { SharedProofPreview } from '../shared/contracts';

interface Scope { accountId:string; epoch:number }
interface Review extends Scope { preview:SharedProofPreview; expires:number }
const expired='Review the latest sharing preview before creating a link.';

/** Native-only review state: a renderer cannot supply a new hash, account, or media path. */
export class ShareReviews {
  private readonly reviews=new Map<string,Review>();
  clear(){this.reviews.clear();}
  issue(scope:Scope,proofId:string,value:PublicProofView & Pick<SharedProofPreview,'tracker'|'chronology'|'recordTracking'>):SharedProofPreview {
    const d=value.disclosure;
    if(value.proofId!==proofId||!d?.liveProof||!/^[a-f0-9]{64}$/.test(d.viewHash))throw new Error('PackProof did not return a valid sharing preview. Try again.');
    // Explicitly project public preview fields; never forward grant/authentication tokens.
    const preview:SharedProofPreview={proofId:value.proofId,status:value.status,fulfillmentScope:value.fulfillmentScope,
      tracker:value.tracker?{itemTitle:value.tracker.itemTitle,headline:value.tracker.headline,shipment:value.tracker.shipment?{carrier:value.tracker.shipment.carrier}:null,milestones:value.tracker.milestones.map(m=>({code:m.code,label:m.label,occurredAt:m.occurredAt,state:m.state}))}:undefined,
      chronology:value.chronology?.map(e=>({id:e.id,occurredAt:e.occurredAt,title:e.title,category:e.category,source:e.source,provider:e.provider,eventType:e.eventType})),
      recordTracking:value.recordTracking?{carrier:value.recordTracking.carrier,status:value.recordTracking.status,lastUpdatedAt:value.recordTracking.lastUpdatedAt,source:value.recordTracking.source,syncState:value.recordTracking.syncState,events:value.recordTracking.events.map(e=>({id:e.id,eventType:e.eventType,occurredAt:e.occurredAt,source:e.source,provider:e.provider}))}:undefined,
      integrity:value.integrity?{result:value.integrity.result,scope:value.integrity.scope}:undefined,
      evidence:value.evidence?.map(e=>({evidenceId:e.evidenceId,stageId:e.stageId,slot:e.slot,committed:e.committed,contentType:e.contentType,representation:e.representation,derivativeId:e.derivativeId,label:e.label})),
      evidenceState:value.evidenceState?{code:value.evidenceState.code,message:value.evidenceState.message}:undefined,
      statements:value.statements?.map(s=>({attestationId:s.attestationId,relatedEvidenceId:s.relatedEvidenceId,statement:s.statement,attributedTo:s.attributedTo,createdAt:s.createdAt,method:s.method,signatureVerification:s.signatureVerification,biometricPolicy:s.biometricPolicy,hardwareOriginVerified:s.hardwareOriginVerified,legalIdentityVerified:s.legalIdentityVerified})),
      recordAsOf:value.recordAsOf?{supplementSequence:value.recordAsOf.supplementSequence,supplementSha256:value.recordAsOf.supplementSha256,scopeStatement:value.recordAsOf.scopeStatement}:undefined,
      disclosure:{viewHash:d.viewHash,scopeVersion:d.scopeVersion,revocationNotice:d.revocationNotice,fields:[...d.fields],liveProof:d.liveProof,sharingNotice:d.sharingNotice}};
    for(const [key,review]of this.reviews)if(review.expires<=Date.now())this.reviews.delete(key);
    this.reviews.delete(proofId);
    if(this.reviews.size>=20)this.reviews.delete(this.reviews.keys().next().value!);
    this.reviews.set(proofId,{...scope,preview,expires:Date.now()+10*60_000});
    return preview;
  }
  private require(scope:Scope,proofId:string,hash:string):Review {
    const review=this.reviews.get(proofId);
    if(!review||review.accountId!==scope.accountId||review.epoch!==scope.epoch||review.expires<=Date.now()||review.preview.disclosure.viewHash!==hash)throw new Error(expired);
    return review;
  }
  consume(scope:Scope,proofId:string,hash:string){this.require(scope,proofId,hash);this.reviews.delete(proofId);}
  media(scope:Scope,proofId:string,hash:string,evidenceId:string){
    const item=this.require(scope,proofId,hash).preview.evidence?.find(e=>e.evidenceId===evidenceId&&e.committed&&e.representation==='ORIGINAL');
    if(!item)throw new Error('This recording is not in the current sharing preview.');
    return {stageId:item.stageId??undefined};
  }
}
