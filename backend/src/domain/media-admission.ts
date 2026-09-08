import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore, UploadTarget } from '../s3/object-store.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from './errors.js';

export const MEDIA_MAX_BYTES=250_000_000;
export const MEDIA_UPLOAD_EXPIRY_MS=60*60*1000;
export const MEDIA_RESERVATION_EXPIRY_MS=7*24*60*60*1000;
export const MEDIA_ACTIVE_UPLOADS=2;
const DAILY_ACCOUNT_BYTES=10*1000*1000*1000;
interface AdmissionRow {source_kind:"ROOT"|"STAGE";evidence_id:string;actor_user_id:string;staging_key:string;token_sha256:string;declared_bytes:string|number|null;reserved_bytes:string|number;ingress_bytes:string|number;ingress_limit_bytes:string|number;state:string;expires_at:Date|string;token_expires_at:Date|string;lease_until:Date|string|null;staging_version_id:string|null;}
const allowedTypes=new Set(['video/mp4','video/webm','video/quicktime','image/jpeg','image/png','image/webp','application/pdf','audio/mpeg','audio/mp4','audio/wav']);
export function validateAdmissionMetadata(contentType:string,declaredBytes?:number):void {
  if(!allowedTypes.has(contentType.split(';')[0].trim().toLowerCase()))throw new DomainError('INVALID_CONTENT_TYPE','Choose a supported recording, image, audio file, or PDF',422);
  if(declaredBytes!==undefined&&(!Number.isSafeInteger(declaredBytes)||declaredBytes<1||declaredBytes>MEDIA_MAX_BYTES))throw new DomainError('UPLOAD_TOO_LARGE','Evidence must be between 1 byte and 250 MB',413);
}
/** Called inside the evidence initialization transaction after proof authorization. */
export async function reserveMediaAdmission(tx:Database,clock:Clock,store:ObjectStore,input:{evidenceId:string;actorUserId:string;stagingKey:string;contentType:string;declaredBytes?:number;sourceKind?:"ROOT"|"STAGE"}):Promise<UploadTarget> {
  validateAdmissionMetadata(input.contentType,input.declaredBytes);
  const now=clock.now(),today=now.toISOString().slice(0,10);
  await tx.query('INSERT INTO media_admission_accounts(actor_user_id,reservation_day,reserved_bytes) VALUES($1,$2,0) ON CONFLICT(actor_user_id) DO NOTHING',[input.actorUserId,today]);
  const account=(await tx.query<{reserved_bytes:number|string;reservation_day:string|Date}>('SELECT * FROM media_admission_accounts WHERE actor_user_id=$1 FOR UPDATE',[input.actorUserId])).rows[0];
  const previous=(await tx.query<AdmissionRow>('SELECT * FROM evidence_upload_admissions WHERE evidence_id=$1 FOR UPDATE',[input.evidenceId])).rows[0];
  if(previous){
    if(Number(previous.declared_bytes??0)!==Number(input.declaredBytes??0))throw new DomainError('IDEMPOTENCY_CONFLICT','An upload retry cannot change its reserved size',409);
    if(['COMMITTED','DISCARDED','EXPIRED'].includes(previous.state)||new Date(previous.expires_at).getTime()<=now.getTime())throw new DomainError('UPLOAD_CONTRACT_EXPIRED','This upload reservation expired; preserve the original and begin a fresh upload',409);
    if(previous.lease_until&&new Date(previous.lease_until).getTime()>now.getTime())throw new DomainError('UPLOAD_IN_PROGRESS','This recording is already uploading; check operation status',409);
    // An authenticated recovery can buy another bounded retry allowance from
    // the SAME daily account budget. Charges and evidence identity persist.
    const reserved=Number(previous.reserved_bytes),limit=Number(previous.ingress_limit_bytes);
    if(previous.state!=='RECEIVED'&&limit-Number(previous.ingress_bytes)<reserved) {
      if(limit>=reserved*8)throw new DomainError('UPLOAD_INGRESS_LIMIT','This recording reached its lifetime retry allowance. Keep the original and request an allowance review.',429);
      const sameDay=new Date(account.reservation_day).toISOString().slice(0,10)===today,current=sameDay?Number(account.reserved_bytes):0;
      if(current+reserved>DAILY_ACCOUNT_BYTES)throw new DomainError('UPLOAD_QUOTA_EXCEEDED','This account has reached its daily upload allowance. Keep the original and retry after the allowance renews.',429);
      await tx.query('UPDATE media_admission_accounts SET reservation_day=$2,reserved_bytes=$3 WHERE actor_user_id=$1',[input.actorUserId,today,current+reserved]);
      await tx.query('UPDATE evidence_upload_admissions SET ingress_limit_bytes=$2 WHERE evidence_id=$1',[input.evidenceId,Math.min(reserved*8,limit+reserved*2)]);
    }
  }else{
    const active=(await tx.query<{count:string|number}>("SELECT COUNT(*) AS count FROM evidence_upload_admissions WHERE actor_user_id=$1 AND state IN ('OPEN','RECEIVING','RECEIVED') AND expires_at>$2",[input.actorUserId,now.toISOString()])).rows[0];
    if(Number(active.count)>=MEDIA_ACTIVE_UPLOADS)throw new DomainError('UPLOAD_CONCURRENCY_LIMIT','Two uploads are already active for this account. Finish or discard one before starting another.',429);
    const sameDay=new Date(account.reservation_day).toISOString().slice(0,10)===today,reserved=input.declaredBytes??MEDIA_MAX_BYTES,current=sameDay?Number(account.reserved_bytes):0;
    if(current+reserved>DAILY_ACCOUNT_BYTES)throw new DomainError('UPLOAD_QUOTA_EXCEEDED','This account has reached its daily upload allowance',429);
    await tx.query('UPDATE media_admission_accounts SET reservation_day=$2,reserved_bytes=$3 WHERE actor_user_id=$1',[input.actorUserId,today,current+reserved]);
  }
  const token=randomBytes(32).toString('base64url'),tokenHash=sha256Hex(token),reserved=input.declaredBytes??MEDIA_MAX_BYTES;
  if(previous)await tx.query('UPDATE evidence_upload_admissions SET token_sha256=$2,token_expires_at=$3 WHERE evidence_id=$1',[input.evidenceId,tokenHash,new Date(now.getTime()+MEDIA_UPLOAD_EXPIRY_MS).toISOString()]);
  else await tx.query('INSERT INTO evidence_upload_admissions(evidence_id,actor_user_id,staging_key,token_sha256,declared_bytes,reserved_bytes,ingress_limit_bytes,expires_at,created_at,source_kind,token_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[input.evidenceId,input.actorUserId,input.stagingKey,tokenHash,input.declaredBytes??null,reserved,reserved*2,new Date(now.getTime()+MEDIA_RESERVATION_EXPIRY_MS).toISOString(),now.toISOString(),input.sourceKind??'ROOT',new Date(now.getTime()+MEDIA_UPLOAD_EXPIRY_MS).toISOString()]);
  // Test-only/third party adapters retain their own transport contract. Runtime
  // adapters opt in to the governed gateway and never emit presigned PUT URLs.
  if(!store.boundedUploadGateway)return store.createUploadTarget({key:input.stagingKey,contentType:input.contentType});
  return {method:'PUT',received:previous?.state==='RECEIVED',url:`${(store.gatewayBaseUrl??'').replace(/\/$/,'')}/upload/admission_${token}`,headers:{'Content-Type':input.contentType}};
}
export function requestByteLength(req:Pick<IncomingMessage,'headers'>,maximum:number):number {
  const length=req.headers['content-length'];
  if(typeof length!=='string'||!/^\d+$/.test(length)||req.headers['transfer-encoding'])throw new DomainError('UPLOAD_LENGTH_REQUIRED','A fixed Content-Length is required before admitting upload bytes',411);
  const value=Number(length);if(!Number.isSafeInteger(value)||value<1||value>maximum)throw new DomainError('UPLOAD_TOO_LARGE','Upload exceeds its allowed byte limit',413);return value;
}
export async function reserveMediaIngress(db:Database,clock:Clock,input:{token?:string;evidenceId?:string;actorUserId?:string;byteSize:number;wholeObject:boolean}):Promise<{evidenceId:string;key:string;contentType:string;leaseToken:string}> {
  return db.transaction(async tx=>{
    const row=(await tx.query<AdmissionRow>(`SELECT * FROM evidence_upload_admissions WHERE ${input.token?'token_sha256=$1':'evidence_id=$1'} FOR UPDATE`,[input.token?sha256Hex(input.token):input.evidenceId])).rows[0];
    if(!row||input.actorUserId&&row.actor_user_id!==input.actorUserId)throw new DomainError('UPLOAD_CONTRACT_INVALID','This upload authorization is unavailable',403);
    const evidence=(await tx.query<{content_type:string;validation_status:string}>(row.source_kind==='STAGE'?"SELECT content_type,CASE WHEN committed_at IS NOT NULL THEN 'COMMITTED' WHEN discarded_at IS NOT NULL THEN 'REJECTED' ELSE 'PENDING' END AS validation_status FROM commerce_stage_evidence WHERE id=$1":'SELECT content_type,validation_status FROM evidence WHERE id=$1',[row.evidence_id])).rows[0];
    if(!evidence||evidence.validation_status!=='PENDING'||!['OPEN','RECEIVING'].includes(row.state))throw new DomainError('UPLOAD_CLOSED','This upload has already been received or closed',409);
    const now=clock.now();
    if(new Date(row.expires_at).getTime()<=now.getTime()||(input.token&&new Date(row.token_expires_at).getTime()<=now.getTime()))throw new DomainError('UPLOAD_CONTRACT_EXPIRED','This upload authorization expired. Preserve the original recording.',409);
    if(row.lease_until&&new Date(row.lease_until).getTime()>now.getTime())throw new DomainError('UPLOAD_IN_PROGRESS','A request already owns this upload',409);
    if(input.byteSize>Number(row.reserved_bytes)||(input.wholeObject&&row.declared_bytes!==null&&input.byteSize!==Number(row.declared_bytes)))throw new DomainError('UPLOAD_SIZE_MISMATCH','Upload length does not match the reserved recording',413);
    if(Number(row.ingress_bytes)+input.byteSize>Number(row.ingress_limit_bytes))throw new DomainError('UPLOAD_INGRESS_LIMIT','This upload exhausted its current retry allowance. Keep the original and renew its authorized upload contract.',429);
    const leaseToken=randomUUID();
    // Reserve the ENTIRE body before reading it. Failed, repeated, and abandoned
    // attempts keep their charge; rollback of storage work cannot refund ingress.
    await tx.query("UPDATE evidence_upload_admissions SET state='RECEIVING',ingress_bytes=ingress_bytes+$2,lease_token=$3,lease_until=$4 WHERE evidence_id=$1",[row.evidence_id,input.byteSize,leaseToken,new Date(now.getTime()+10*60*1000).toISOString()]);
    return {evidenceId:row.evidence_id,key:row.staging_key,contentType:evidence.content_type,leaseToken};
  });
}
export async function finishMediaIngress(db:Database,clock:Clock,input:{evidenceId:string;leaseToken:string;received:boolean;versionId?:string|null}):Promise<void>{
  await db.query("UPDATE evidence_upload_admissions SET state=$3,lease_token=NULL,lease_until=NULL,received_at=$4,staging_version_id=COALESCE($5,staging_version_id) WHERE evidence_id=$1 AND lease_token=$2 AND state='RECEIVING'",[input.evidenceId,input.leaseToken,input.received?'RECEIVED':'OPEN',input.received?clock.now().toISOString():null,input.versionId??null]);
}
export async function receiveAdmittedUpload(db:Database,clock:Clock,store:ObjectStore,token:string,req:IncomingMessage):Promise<{key:string;evidenceId:string}> {
  if(!token.startsWith('admission_')||!store.putStream)throw new DomainError('UPLOAD_ADMISSION_REQUIRED','Create a bounded upload reservation before sending bytes',403);
  const byteSize=requestByteLength(req,MEDIA_MAX_BYTES);
  const lease=await reserveMediaIngress(db,clock,{token:token.slice('admission_'.length),byteSize,wholeObject:true});
  let received=false;
  try{
    if((req.headers['content-type']??'').split(';')[0].toLowerCase()!==lease.contentType.split(';')[0].toLowerCase())throw new DomainError('EVIDENCE_METADATA_MISMATCH','Upload content type does not match its reservation',422);
    req.setTimeout(10*60*1000,()=>req.destroy(new Error('Upload timed out')));
    const saved=await store.putStream(lease.key,verifyMediaSignature(req,lease.contentType),lease.contentType,byteSize);received=true;
    await finishMediaIngress(db,clock,{...lease,received:true,versionId:saved.versionId});
    return {key:lease.key,evidenceId:lease.evidenceId};
  }finally{if(!received)await finishMediaIngress(db,clock,{...lease,received:false});}
}
/** Maintenance must use a separate cleanup role; preserved keys are never candidates. */
export async function sweepExpiredMediaAdmissions(db:Database,clock:Clock,store:ObjectStore,limit=25):Promise<{cleaned:number}> {
  if(!store.deleteStaging)return {cleaned:0};let cleaned=0;
  const candidates=await db.query<AdmissionRow>('SELECT * FROM evidence_upload_admissions WHERE expires_at<=$1 AND cleanup_at IS NULL AND (lease_until IS NULL OR lease_until<=$1) ORDER BY expires_at LIMIT $2',[clock.now().toISOString(),Math.min(100,Math.max(1,limit))]);
  for(const row of candidates.rows){await db.transaction(async tx=>{
    const locked=(await tx.query<AdmissionRow>('SELECT * FROM evidence_upload_admissions WHERE evidence_id=$1 FOR UPDATE',[row.evidence_id])).rows[0];
    if(!locked||locked.lease_until&&new Date(locked.lease_until).getTime()>clock.now().getTime())return;
    const reference=(await tx.query<{validation_status:string;object_key:string}>(row.source_kind==='STAGE'?"SELECT object_key,CASE WHEN committed_at IS NOT NULL THEN 'COMMITTED' ELSE 'PENDING' END AS validation_status FROM commerce_stage_evidence WHERE id=$1 FOR UPDATE":'SELECT validation_status,object_key FROM evidence WHERE id=$1 FOR UPDATE',[row.evidence_id])).rows[0];
    // COMMITTED object references and the separately preserved orphan namespace
    // are outside this sweep. Only old staging paths/part versions are removed.
    if(reference?.object_key===row.staging_key&&reference.validation_status==='COMMITTED')return;
    const parts=(await tx.query<{object_key:string;object_version_id:string|null}>('SELECT object_key,object_version_id FROM evidence_upload_parts WHERE evidence_id=$1',[row.evidence_id])).rows;
    for(const part of parts)await store.deleteStaging!(part.object_key,{versionId:part.object_version_id});
    await store.deleteStaging!(row.staging_key,{versionId:row.staging_version_id});
    await tx.query("UPDATE evidence_upload_admissions SET state=CASE WHEN state='COMMITTED' THEN state ELSE 'EXPIRED' END,cleanup_at=$2 WHERE evidence_id=$1",[row.evidence_id,clock.now().toISOString()]);cleaned++;
  });}
  return {cleaned};
}

/** Inspect bounded leading bytes before admitting a MIME label. Full video
 * structural validation still runs at capture commitment in a limited parser. */
export async function* verifyMediaSignature(source:AsyncIterable<Uint8Array>,contentType:string):AsyncGenerator<Uint8Array>{
  let prefix=Buffer.alloc(0),checked=false;const held:Uint8Array[]=[];
  for await(const chunk of source){
    if(checked){yield chunk;continue;}
    held.push(chunk);prefix=Buffer.concat([prefix,Buffer.from(chunk).subarray(0,64-prefix.length)]);
    if(prefix.length>=64){assertMediaSignature(prefix,contentType);checked=true;for(const first of held)yield first;held.length=0;}
  }
  if(!checked){assertMediaSignature(prefix,contentType);for(const first of held)yield first;}
}
export function assertMediaSignature(prefix:Buffer,contentType:string):void{
  const type=contentType.split(';')[0].trim().toLowerCase(),ascii=(a:number,b:number)=>prefix.subarray(a,b).toString('ascii');
  const matches:Record<string,boolean>={
    'video/mp4':ascii(4,8)==='ftyp','video/quicktime':ascii(4,8)==='ftyp','audio/mp4':ascii(4,8)==='ftyp',
    'video/webm':prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])),
    'image/jpeg':prefix.length>=3&&prefix[0]===0xff&&prefix[1]===0xd8&&prefix[2]===0xff,
    'image/png':prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/webp':ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP',
    'application/pdf':ascii(0,5)==='%PDF-',
    'audio/mpeg':ascii(0,3)==='ID3'||prefix.length>=2&&prefix[0]===0xff&&(prefix[1]&0xe0)===0xe0,
    'audio/wav':ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE',
  };
  if(!matches[type])throw new DomainError('EVIDENCE_FORMAT_MISMATCH','Uploaded bytes do not match the declared media format',422);
}
