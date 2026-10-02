import { createPublicKey,verify } from 'node:crypto';
import { Router,type Request,type Response,type NextFunction } from 'express';
import { canonicalize,parseStrictJson } from '../../../packages/evidence-contracts/contracts.mjs';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import type { Database } from '../db/database.js';
import { requireRnd } from './config.js';
import { authorized,bad,idempotent,onlyKeys,requireConsent,signedRecord } from './security.js';
import type { RndDeps,Source } from './types.js';

export const SIDECAR_CHUNK_BYTES=262144, SIDECAR_MAX_BYTES=2097216;
const filename=/^(research-acquisition\.json|native-journal\.jsonl|research-frame-[0-5]\.pgm)$/;
const hash=/^[a-f0-9]{64}$/;
type Frame=Record<string,unknown>&{fileName:string;sha256:string;byteLength:number;width:number;height:number;mediaTimeMs:number};
type Stored={canonical_json:string;digest:string;signature:unknown;object_key:string;object_version_id:string;sha256:string;byte_length:number};
export function validateNativeAcquisition(bytes:Buffer):Frame[] {
 const text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes))bad('RND_SIDECAR_METADATA','Acquisition JSON must be valid UTF-8');
 let value:Record<string,unknown>;
 try {value=parseStrictJson(text,SIDECAR_MAX_BYTES) as Record<string,unknown>;}catch{bad('RND_SIDECAR_METADATA','Invalid strict acquisition JSON');}
 if(value.schemaVersion!=='packproof.native-acquisition.v1'||value.mode!=='PASSIVE'||!Array.isArray(value.frames)||value.frames.length>6)bad('RND_SIDECAR_METADATA','Invalid bounded passive acquisition metadata');
 const names=new Set<string>();
 for(const raw of value.frames){
  const f=raw as Frame;
  if(!f||typeof f!=='object'||!/^research-frame-[0-5]\.pgm$/.test(f.fileName)||names.has(f.fileName)||!hash.test(f.sha256)||!Number.isSafeInteger(f.byteLength)||f.byteLength<1||f.byteLength>SIDECAR_MAX_BYTES||!Number.isSafeInteger(f.width)||!Number.isSafeInteger(f.height)||f.width<2||f.height<2||f.width*f.height>2097152||!Number.isSafeInteger(f.mediaTimeMs)||f.mediaTimeMs<0||f.mediaTimeMs>86400000||f.relationship!=='CONCURRENT_CAPTURED_SIDECAR'||f.transform!=='NATIVE_LUMA_PLANE_PGM_NO_RESIZE')bad('RND_SIDECAR_METADATA','Invalid bounded native frame commitment');
  names.add(f.fileName);
 }
 return value.frames as Frame[];
}
export function validateSidecarChunk(input:unknown) {
 onlyKeys(input,['partIndex','partCount','byteLength','sha256','dataBase64']);
 const {partIndex,partCount,byteLength,sha256,dataBase64}=input;
 if(typeof byteLength!=='number'||!Number.isSafeInteger(byteLength)||byteLength<1||byteLength>SIDECAR_MAX_BYTES||typeof partIndex!=='number'||!Number.isInteger(partIndex)||partIndex<0||partCount!==Math.ceil(byteLength/SIDECAR_CHUNK_BYTES)||partIndex>=Number(partCount)||typeof sha256!=='string'||!hash.test(sha256)||typeof dataBase64!=='string'||dataBase64.length>349528||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64))bad('RND_SIDECAR_INPUT','Invalid bounded sidecar chunk');
 const bytes=Buffer.from(dataBase64,'base64'),expected=Math.min(SIDECAR_CHUNK_BYTES,byteLength-partIndex*SIDECAR_CHUNK_BYTES);
 if(bytes.length!==expected||bytes.toString('base64')!==dataBase64)bad('RND_SIDECAR_INPUT','Chunk size or base64 encoding does not match');
 return {partIndex,partCount:Number(partCount),byteLength,sha256,bytes};
}
async function sealedBinding(deps:RndDeps,db:Database,actor:string,proofId:string,intentId:string) {
 const row=(await db.query<{canonical_json:string;digest:string;actor_id:string;client_public_key_pem:string}>(`SELECT r.canonical_json,r.digest,i.actor_id,s.client_public_key_pem FROM rnd_session_receipts r JOIN rnd_intents i ON i.id=r.intent_id JOIN rnd_session_starts s ON s.intent_id=i.id WHERE i.id=$1 AND i.proof_id=$2 AND i.actor_id=$3`,[intentId,proofId,actor])).rows[0];
 if(!row)bad('RND_SIDECAR_PARENT_REQUIRED','A sealed native receipt belonging to this actor is required',403);
 const receipt=JSON.parse(row.canonical_json),client=receipt.clientInventory;
 if(!client||client.publicKeyPem!==row.client_public_key_pem)bad('RND_SIDECAR_SIGNATURE_REQUIRED','Native sidecars require the original bound signing key',409);
 let inventory:Record<string,unknown>;
 try{
  inventory=parseStrictJson(client.canonicalJson,32768) as Record<string,unknown>;
  const key=createPublicKey(row.client_public_key_pem);
  if(key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||canonicalize(inventory)!==client.canonicalJson||!verify('sha256',Buffer.from(client.canonicalJson),key,Buffer.from(client.signatureBase64,'base64')))throw Error('signature');
 }catch{bad('RND_SIDECAR_SIGNATURE_INVALID','Invalid original native inventory signature');}
 const parent=receipt.sources?.[0] as Source;
 if(receipt.sources?.length!==1||!parent||inventory.schemaVersion!=='packproof.native-final-file.v1'||inventory.intentId!==intentId||inventory.proofId!==proofId||inventory.captureSessionId!==receipt.captureSessionId||inventory.mediaSha256!==parent.sha256||inventory.mediaByteLength!==parent.byteLength)bad('RND_SIDECAR_BINDING','Native inventory does not bind the original recording');
 return {receipt,parent,inventory,nativeInventoryDigest:sha256Hex(client.canonicalJson),parentReceiptDigest:row.digest};
}
function unpack(row:Stored){return {sidecar:JSON.parse(row.canonical_json),canonicalJson:row.canonical_json,digest:row.digest,signature:row.signature};}
export async function uploadCaptureSidecar(deps:RndDeps,actor:string,proofId:string,intentId:string,name:string,key:unknown,input:unknown) {
 requireRnd(deps.rnd,'verifiedcapture','collection');requireRnd(deps.rnd,'proofpilot','collection');
 if(!filename.test(name))bad('RND_SIDECAR_FILENAME','Unknown native sidecar filename');
 const chunk=validateSidecarChunk(input);
 // Withdrawal/kill switch takes effect even for a repeated previously accepted request.
 await authorized(deps.db,proofId,actor);await requireConsent(deps.db,proofId,actor);
 return idempotent(deps,proofId,actor,`sidecar:${intentId}:${name}:${chunk.partIndex}`,key,input,async db=>{
  await requireConsent(db,proofId,actor);
  const binding=await sealedBinding(deps,db,actor,proofId,intentId);
  let frame:Frame|null=null,expectedHash:unknown;
  if(name==='research-acquisition.json')expectedHash=binding.inventory.acquisitionSha256;
  else if(name==='native-journal.jsonl')expectedHash=binding.inventory.journalSha256;
  else{
   const metadata=(await db.query<Stored>(`SELECT * FROM rnd_capture_sidecars WHERE intent_id=$1 AND file_name='research-acquisition.json'`,[intentId])).rows[0];
   if(!metadata)bad('RND_SIDECAR_ACQUISITION_REQUIRED','Receive the signed acquisition metadata before its frames',409);
   const object=await deps.objectStore.get(metadata.object_key,{versionId:metadata.object_version_id});
   if(!object||sha256Hex(object.body)!==metadata.sha256)bad('RND_SIDECAR_INTEGRITY','Acquisition metadata is unavailable or corrupt',409);
   frame=validateNativeAcquisition(object.body).find(f=>f.fileName===name)??null;
   if(!frame||frame.byteLength!==chunk.byteLength)bad('RND_SIDECAR_UNCOMMITTED','Frame is absent from the signed acquisition inventory',409);
   expectedHash=frame.sha256;
  }
  if(typeof expectedHash!=='string'||expectedHash!==chunk.sha256)bad('RND_SIDECAR_UNCOMMITTED','Sidecar hash differs from the signed native inventory',409);
  const complete=(await db.query<Stored>('SELECT * FROM rnd_capture_sidecars WHERE intent_id=$1 AND file_name=$2',[intentId,name])).rows[0];
  if(complete){if(complete.sha256!==chunk.sha256||Number(complete.byte_length)!==chunk.byteLength)bad('RND_SIDECAR_SEALED','Received sidecars cannot be replaced',409);return {state:'RECEIVED',...unpack(complete)};}
  const mimeType=frame?'image/x-portable-graymap':name.endsWith('jsonl')?'application/x-ndjson':'application/json';
  const prior=(await db.query<Record<string,unknown>>('SELECT * FROM rnd_capture_sidecar_parts WHERE intent_id=$1 AND file_name=$2 ORDER BY part_index',[intentId,name])).rows;
  if(prior.some(p=>p.file_sha256!==chunk.sha256||Number(p.file_byte_length)!==chunk.byteLength||Number(p.part_count)!==chunk.partCount))bad('RND_SIDECAR_SEALED','Sidecar chunk inventory cannot be replaced',409);
  const part=prior.find(p=>Number(p.part_index)===chunk.partIndex),partHash=sha256Hex(chunk.bytes);
  if(part&&part.part_sha256!==partHash)bad('RND_SIDECAR_SEALED','An accepted chunk cannot be replaced',409);
  if(!part){
   const staging=`rnd-sidecar-staging/${newId('part')}`;await deps.objectStore.put(staging,chunk.bytes,mimeType);
   const committed=await deps.objectStore.commitUpload(staging,{sha256:partHash,byteSize:chunk.bytes.length,contentType:mimeType,maxBytes:SIDECAR_CHUNK_BYTES});
   if(!committed)bad('RND_SIDECAR_STORAGE','Cannot commit sidecar chunk',503);
   await db.query('INSERT INTO rnd_capture_sidecar_parts(intent_id,file_name,part_index,part_count,file_sha256,file_byte_length,part_sha256,part_byte_length,object_key,object_version_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[intentId,name,chunk.partIndex,chunk.partCount,chunk.sha256,chunk.byteLength,partHash,chunk.bytes.length,committed.key,committed.versionId??`content-addressed:${partHash}`,deps.clock.now().toISOString()]);
  }
  const parts=(await db.query<Record<string,unknown>>('SELECT * FROM rnd_capture_sidecar_parts WHERE intent_id=$1 AND file_name=$2 ORDER BY part_index',[intentId,name])).rows;
  if(parts.length!==chunk.partCount)return {state:'PART_RECEIVED',partIndex:chunk.partIndex};
  const arrays:Buffer[]=[];
  for(const p of parts){const item=await deps.objectStore.get(String(p.object_key),{versionId:String(p.object_version_id)});if(!item||sha256Hex(item.body)!==p.part_sha256||item.body.length!==Number(p.part_byte_length))bad('RND_SIDECAR_INTEGRITY','Stored chunk failed verification',409);arrays.push(item.body);}
  const bytes=Buffer.concat(arrays);
  if(bytes.length!==chunk.byteLength||sha256Hex(bytes)!==chunk.sha256)bad('RND_SIDECAR_INTEGRITY','Final sidecar bytes differ from signed commitment',409);
  if(name==='research-acquisition.json')validateNativeAcquisition(bytes);
  if(frame){const header=Buffer.from(`P5\n${frame.width} ${frame.height}\n255\n`);if(!bytes.subarray(0,header.length).equals(header)||bytes.length!==header.length+frame.width*frame.height)bad('RND_SIDECAR_PIXELS','Native luma dimensions do not match exact bytes');}
  const staging=`rnd-sidecar-staging/${newId('file')}`;await deps.objectStore.put(staging,bytes,mimeType);
  const committed=await deps.objectStore.commitUpload(staging,{sha256:chunk.sha256,byteSize:bytes.length,contentType:mimeType,maxBytes:SIDECAR_MAX_BYTES});
  if(!committed)bad('RND_SIDECAR_STORAGE','Cannot commit final sidecar',503);
  const id=newId('rnd_sidecar'),parent=binding.parent,createdAt=deps.clock.now().toISOString();
  const source={...parent,sourceId:`rnd_source_${id}`,evidenceId:id,objectKey:committed.key,objectVersionId:committed.versionId??`content-addressed:${chunk.sha256}`,sha256:chunk.sha256,byteLength:bytes.length,mimeType,relationship:frame?'CONCURRENT_SIDECAR':'CAPTURE_METADATA'};
  const sidecar={schemaVersion:'packproof.capture-sidecar-receipt.v1',id,intentId,proofId,tenantId:parent.tenantId,captureSessionId:parent.captureSessionId,parentEvidenceId:parent.evidenceId,parentSourceSha256:parent.sha256,nativeInventoryDigest:binding.nativeInventoryDigest,parentReceiptDigest:binding.parentReceiptDigest,fileName:name,source,relationship:source.relationship,frameReference:frame,receivedAt:createdAt,assurance:{byteReceipt:'SIGNED_BYTES_RECEIVED',association:'CLIENT_SIGNED_ACQUISITION_COMMITMENT',pixelEquivalence:'NOT_ASSERTED',sensorAttestation:'UNSUPPORTED'}};
  const record=await signedRecord(deps,proofId,id,sidecar);
  await db.query('INSERT INTO rnd_capture_sidecars(id,proof_id,tenant_id,subject_id,intent_id,actor_id,capture_session_id,parent_evidence_id,file_name,object_key,object_version_id,sha256,byte_length,mime_type,frame_reference,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',[id,proofId,parent.tenantId,parent.subjectId,intentId,actor,parent.captureSessionId,parent.evidenceId,name,source.objectKey,source.objectVersionId,source.sha256,bytes.length,mimeType,frame?JSON.stringify(frame):null,record.canonicalJson,record.digest,JSON.stringify(record.signature),createdAt]);
  if(frame)await db.query('INSERT INTO rnd_sources(id,proof_id,tenant_id,subject_id,evidence_id,leg_id,capture_session_id,object_key,object_version_id,sha256,byte_length,mime_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[source.sourceId,proofId,parent.tenantId,parent.subjectId,id,parent.legId,parent.captureSessionId,source.objectKey,source.objectVersionId,source.sha256,bytes.length,mimeType,createdAt]);
  return {state:'RECEIVED',sidecar,...record};
 });
}
export async function listCaptureSidecars(deps:RndDeps,actor:string,proofId:string) {
 await authorized(deps.db,proofId,actor);requireRnd(deps.rnd,'verifiedcapture','internalDisplay');
 return (await deps.db.query<Stored>('SELECT * FROM rnd_capture_sidecars WHERE proof_id=$1 ORDER BY created_at,id',[proofId])).rows.map(unpack);
}
export function rndCaptureSidecarsRouter(deps:RndDeps){
 const router=Router(),base='/proofs/:id/rnd/capture-intents/:intent/sidecars';
 const route=(fn:(r:Request,s:Response)=>Promise<unknown>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(n);};
 router.post(`${base}/:name`,route(async(r,s)=>s.json(await uploadCaptureSidecar(deps,r.packproofUserId??bad('UNAUTHENTICATED','Authentication required',401),r.params.id,r.params.intent,r.params.name,r.header('Idempotency-Key'),r.body))));
 return router;
}
