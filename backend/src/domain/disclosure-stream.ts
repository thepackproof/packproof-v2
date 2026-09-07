import { guardAuthorizedStream as guardDisclosureStream } from "./authorized-stream.js";
export { guardDisclosureStream };
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import { resolveDisclosureContext, assertDisclosureMedia } from './disclosure.js';
import { streamPreservedObject, type EvidenceStreamView } from './evidence.js';
import { DomainError } from './errors.js';
interface SourceRow{id:string;object_key:string;object_version_id?:string|null;content_type:string;sha256:string;byte_size:string|number;}
/** Scope is checked before storage access and again before a response can start. */
export async function readDisclosedMediaStream(db:Database,clock:Clock,store:ObjectStore,token:string,evidenceId:string,rangeHeader?:string):Promise<EvidenceStreamView>{
  const context=await resolveDisclosureContext(db,clock,{token}),media=assertDisclosureMedia(context,evidenceId);
  let result:EvidenceStreamView;
  if(media.representation==='ORIGINAL'){
    // The checked bearer grant is this reader's authority. Its historical
    // creator's current sign-in or billing status is not an additional grant.
    const root=(await db.query<SourceRow>("SELECT * FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status='COMMITTED'",[evidenceId,context.proofId])).rows[0];
    if(root)result=await streamPreservedObject(store,root,rangeHeader);
    else{
      if(context.purpose!=='SHARED_PROOF')throw unavailable();
      const stage=(await db.query<SourceRow>('SELECT e.* FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE e.id=$1 AND s.proof_id=$2 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL',[evidenceId,context.proofId])).rows[0];
      if(!stage)throw unavailable();result=await streamPreservedObject(store,stage,rangeHeader);
    }
  }else{
    const derivative=(await db.query<SourceRow>("SELECT d.* FROM proof_media_derivatives d JOIN evidence e ON e.id=d.evidence_id AND e.proof_id=d.proof_id AND e.sha256=d.source_sha256 WHERE d.id=$1 AND d.proof_id=$2 AND d.evidence_id=$3 AND d.status='REVIEWED'",[media.derivativeId,context.proofId,evidenceId])).rows[0];
    if(!derivative)throw unavailable();result=await streamPreservedObject(store,{...derivative,id:evidenceId},rangeHeader);
  }
  try{
    const current=await resolveDisclosureContext(db,clock,{token});
    if(current.scopeVersion!==context.scopeVersion||current.scopeIdentity!==context.scopeIdentity)throw unavailable();
    assertDisclosureMedia(current,evidenceId,media.derivativeId);
    if(result.body) {
      const source=result.body;
      result.body=guardDisclosureStream(source,async()=>{
        const active=await resolveDisclosureContext(db,clock,{token});
        if(active.scopeVersion!==context.scopeVersion||active.scopeIdentity!==context.scopeIdentity)throw unavailable();
        assertDisclosureMedia(active,evidenceId,media.derivativeId);
      });
    }
    return result;
  }catch(error){result.body?.destroy();throw error;}
}
function unavailable(){return new DomainError('INSUFFICIENT_SCOPE','This view does not include that source',403);}
