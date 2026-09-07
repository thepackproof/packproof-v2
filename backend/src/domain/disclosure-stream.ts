import { Readable } from "node:stream";
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import { resolveDisclosureContext, assertDisclosureMedia } from './disclosure.js';
import { readCommittedEvidenceStream, streamPreservedObject, type EvidenceStreamView } from './evidence.js';
import { requireCommerceAccess } from './commerce-lifecycle.js';
import { DomainError } from './errors.js';
interface SourceRow{id:string;object_key:string;object_version_id?:string|null;content_type:string;sha256:string;byte_size:string|number;}
/** Scope is checked before storage access and again before a response can start. */
export async function readDisclosedMediaStream(db:Database,clock:Clock,store:ObjectStore,token:string,evidenceId:string,rangeHeader?:string):Promise<EvidenceStreamView>{
  const context=await resolveDisclosureContext(db,clock,{token}),media=assertDisclosureMedia(context,evidenceId);
  let result:EvidenceStreamView;
  if(media.representation==='ORIGINAL'){
    const creator=(await db.query<{user_id:string}>('SELECT pp.user_id FROM proof_access_links l JOIN proof_participants pp ON pp.id=l.created_by_participant_id WHERE l.id=$1',[context.grantId])).rows[0];
    if(!creator)throw unavailable();
    const root=(await db.query("SELECT 1 FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status='COMMITTED'",[evidenceId,context.proofId])).rows[0];
    if(root)result=await readCommittedEvidenceStream(db,store,creator.user_id,context.proofId,evidenceId,rangeHeader);
    else{
      if(context.purpose!=='SHARED_PROOF')throw unavailable();
      await requireCommerceAccess(db,context.proofId,creator.user_id);
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

/** An already-open response cannot become a permanent revocation bypass. Storage
 * and HTTP backpressure bound the remaining already-admitted bytes after revoke. */
export function guardDisclosureStream(source:Readable,authorize:()=>Promise<void>,options:{maximumBytesBetweenChecks?:number;maximumMsBetweenChecks?:number;maximumLifetimeMs?:number;now?:()=>number}={}):Readable {
  const maximumBytes=options.maximumBytesBetweenChecks??1024*1024,maximumMs=options.maximumMsBetweenChecks??1000,maximumLifetime=options.maximumLifetimeMs??10*60*1000,now=options.now??Date.now;
  const started=now();let checkedAt:number|null=null,bytesSinceCheck=0;
  async function* guarded(){
    try{
      for await(const chunk of source){
        const bytes=Buffer.from(chunk);
        for(let offset=0;offset<bytes.length;){
          if(now()-started>=maximumLifetime)throw new DomainError('ACCESS_RESPONSE_EXPIRED','Open the recording again to continue',403);
          if(checkedAt===null||bytesSinceCheck>=maximumBytes||now()-checkedAt>=maximumMs){await authorize();checkedAt=now();bytesSinceCheck=0;}
          const end=Math.min(bytes.length,offset+Math.min(64*1024,maximumBytes-bytesSinceCheck));
          const part=bytes.subarray(offset,end);bytesSinceCheck+=part.length;offset=end;yield part;
        }
      }
    }finally{source.destroy();}
  }
  return Readable.from(guarded(),{objectMode:false,highWaterMark:64*1024});
}
