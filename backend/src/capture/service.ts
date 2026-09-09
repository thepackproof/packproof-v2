import { attestationContext } from "../domain/attestation-context.js";
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from '../domain/errors.js';
import { loadProof, requireParticipant, assertNotFinalized } from '../domain/proof-access.js';
import { createCaptureSession, loadCaptureSession, captureSessionView } from '../domain/capture-sessions.js';
import { loadTransactionView } from '../domain/transactions.js';
import { appendAudit } from '../domain/audit.js';
import { CAPTURE_SCHEMA, CORE_VERSION, POLICY, canonical, createManifest, manifestDigest, validateCapabilities, validateObservation, check, CaptureError, type CapabilitySnapshot, type CaptureContext, type CaptureManifest, type Observation, type MediaSegment, type Surface } from './core.js';
const hash=async(value:string)=>sha256Hex(value);
const TTL=10*60_000;
interface IntentRow {id:string;proof_id:string;actor_user_id:string;token_sha256:string;context_json:Omit<CaptureContext,'captureId'|'capabilities'>;surfaces:Surface[];expires_at:string|Date;consumed_at:string|Date|null;session_id:string|null;}
export interface EngineRow {session_id:string;proof_id:string;actor_user_id:string;context_json:CaptureContext;context_sha256:string;manifest_json:CaptureManifest|null;manifest_sha256:string|null;}
export async function engineRow(db:Database,sessionId:string,lock=false) {return (await db.query<EngineRow>(`SELECT * FROM capture_engine_sessions WHERE session_id=$1${lock?' FOR UPDATE':''}`,[sessionId])).rows[0]??null;}
function fields(v:unknown,names:string[]):asserts v is Record<string,unknown> { check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>names.includes(k)),'CAPTURE_SCHEMA_INVALID','Only documented capture fields are accepted'); }
export async function issueIntent(db:Database,clock:Clock,actor:string,proofId:string,allowed:Surface[]=['ANDROID','IOS','WEB','WAREHOUSE']) {
  check(Array.isArray(allowed)&&allowed.length>0&&allowed.length<=4&&allowed.every(x=>['ANDROID','IOS','WEB','WAREHOUSE'].includes(x)),'CAPTURE_SURFACE_INVALID','Choose a supported capture surface');
  return db.transaction(async tx=>{
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
    const proof=await loadProof(tx,proofId,true);await requireParticipant(tx,proofId,actor,'SELLER');assertNotFinalized(proof);
    const count=(await tx.query<{n:string}>('SELECT COUNT(*) AS n FROM capture_intents WHERE actor_user_id=$1 AND consumed_at IS NULL AND expires_at>$2',[actor,clock.now().toISOString()])).rows[0];
    check(Number(count.n)<20,'CAPTURE_INTENT_LIMIT','Finish a pending capture before starting another');
    const transaction=await loadTransactionView(tx,proof.transaction_id);
    const id=newId('intent');const token=randomBytes(32).toString('base64url');const expiresAt=new Date(clock.now().getTime()+TTL).toISOString();
    const snapshot=await attestationContext(tx,proof.transaction_id);
    const expected:CaptureContext['expected']=[];
    for(const item of transaction.items??[]) { if(item.sku) expected.push({kind:'ITEM_BARCODE',value:item.sku.slice(0,128),source:transaction.provenance?.source??'OPERATOR',version:snapshot.contextSha256}); }
    if(transaction.quantity!=null)expected.push({kind:'QUANTITY',value:String(transaction.quantity),source:transaction.provenance?.source??'OPERATOR',version:snapshot.contextSha256});
    const tracking=transaction.shipping?.trackingNumber?.replace(/[\s-]/g,'').toUpperCase();
    if(tracking&&/^[A-Z0-9]{10,64}$/.test(tracking)) expected.push({kind:'TRACKING',value:tracking,source:transaction.provenance?.source??'OPERATOR',version:sha256Hex(canonical({tracking,transactionId:proof.transaction_id}))});
    const context:IntentRow['context_json']={schema:CAPTURE_SCHEMA,intentId:id,proofId,transactionId:proof.transaction_id,transactionDigest:snapshot.contextSha256,actorId:actor,expected,policy:{...POLICY}};
    await tx.query('INSERT INTO capture_intents(id,proof_id,actor_user_id,token_sha256,context_json,surfaces,created_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)',[id,proofId,actor,sha256Hex(token),JSON.stringify(context),JSON.stringify(allowed),clock.now().toISOString(),expiresAt]);
    await appendAudit(tx,{proofId,actorUserId:actor,eventType:'CAPTURE_INTENT_CREATED',eventData:{intentId:id,schema:CAPTURE_SCHEMA},at:clock.now()});
    // Fragment tokens avoid access-log/referrer/query-string propagation. No order PII in URLs.
    return {intentId:id,launchToken:`${id}.${token}`,expiresAt,schema:CAPTURE_SCHEMA,allowedSurfaces:allowed,launchPath:`/capture#intent=${id}.${token}`,nativePath:`packproof://capture#intent=${id}.${token}`};
  });
}
export async function bindIntent(db:Database,clock:Clock,actor:string,value:unknown) {
  fields(value,['launchToken','capabilities']);const token=value.launchToken;const capabilities=value.capabilities as unknown as CapabilitySnapshot;
  check(typeof token==='string'&&token.length<=256,'CAPTURE_INTENT_INVALID','Open the original capture link');validateCapabilities(capabilities);
  check(!capabilities.audio,'CAPTURE_AUDIO_NOT_ALLOWED','Audio is disabled for this capture policy');
  const [id,secret,...extra]=(token as string).split('.');check(id&&secret&&extra.length===0,'CAPTURE_INTENT_INVALID','Open the original capture link');
  return db.transaction(async tx=>{
    // Preserve actor -> intent -> Proof lock order for parallel token redemption.
    await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
    const row=(await tx.query<IntentRow>('SELECT * FROM capture_intents WHERE id=$1 AND actor_user_id=$2 FOR UPDATE',[id,actor])).rows[0];
    check(row&&timingSafeEqual(Buffer.from(sha256Hex(secret)),Buffer.from(row.token_sha256)),'CAPTURE_INTENT_INVALID','This capture link is unavailable for your account');
    check(!row.consumed_at,'CAPTURE_INTENT_USED','This link has already opened a recording. Recover that recording from its original order');
    check(new Date(row.expires_at).getTime()>clock.now().getTime(),'CAPTURE_INTENT_EXPIRED','This capture link has expired. Open a new link from the order');
    check(row.surfaces.includes(capabilities.surface),'CAPTURE_SURFACE_INVALID','This link does not allow that capture surface');
    const currentSnapshot=await attestationContext(tx,row.context_json.transactionId);
    check(currentSnapshot.contextSha256===row.context_json.transactionDigest,"CAPTURE_CONTEXT_CHANGED","The order changed. Open a fresh capture link from the order");
    const session=await createCaptureSession(tx,clock,actor,row.proof_id,{client:capabilities.surface==='WEB'?'WEB_CAMERA':'NATIVE_CAMERA',idempotencyKey:`intent:${id}`});
    const context:CaptureContext={...row.context_json,captureId:session.id,capabilities};
    await tx.query('INSERT INTO capture_engine_sessions(session_id,intent_id,proof_id,actor_user_id,context_json,context_sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[session.id,id,row.proof_id,actor,JSON.stringify(context),sha256Hex(canonical(context))]);
    await tx.query('UPDATE capture_intents SET consumed_at=$2,session_id=$3 WHERE id=$1',[id,clock.now().toISOString(),session.id]);
    return {session,context,contextSha256:sha256Hex(canonical(context)),coreVersion:CORE_VERSION};
  });
}
async function access(db:Database,actor:string,sessionId:string,lock=false) {
  const row=await engineRow(db,sessionId,lock);check(row&&row.actor_user_id===actor,'CAPTURE_SESSION_NOT_FOUND','Open this recording in its original account');await requireParticipant(db,row.proof_id,actor,'SELLER');return row;
}
export async function receiveBatch(db:Database,clock:Clock,actor:string,sessionId:string,value:unknown) {
  fields(value,['sequence','observations','segments']);
  const sequence=value.sequence;const observations=value.observations as Observation[];const segments=value.segments as MediaSegment[];
  check(Number.isSafeInteger(sequence)&&Number(sequence)>=0&&Number(sequence)<4096&&Array.isArray(observations)&&observations.length<=128&&Array.isArray(segments)&&segments.length<=64,'CAPTURE_BATCH_INVALID','Invalid evidence journal batch');
  return db.transaction(async tx=>{
    const row=await access(tx,actor,sessionId,true);const body={sequence,observations,segments};const digest=sha256Hex(canonical(body));
    const old=(await tx.query<{batch_sha256:string}>('SELECT batch_sha256 FROM capture_engine_batches WHERE session_id=$1 AND sequence=$2',[sessionId,sequence])).rows[0];
    if(old){check(old.batch_sha256===digest,'CAPTURE_BATCH_CONFLICT','A retry cannot change a journal batch');return {sequence,sha256:digest,validation:'DECLARED_PENDING_SOURCE_VALIDATION'};}
    check(!row.manifest_json,'CAPTURE_SEALED','Sealed capture cannot accept new events');
    const session=await loadCaptureSession(tx,actor,row.proof_id,sessionId);check(session.state!=='CANCELLED','CAPTURE_SESSION_CANCELLED','This capture was cancelled');
    const count=(await tx.query<{n:string;observations:string;segments:string}>("SELECT COUNT(*) AS n,COALESCE(SUM(jsonb_array_length(body_json->'observations')),0) AS observations,COALESCE(SUM(jsonb_array_length(body_json->'segments')),0) AS segments FROM capture_engine_batches WHERE session_id=$1",[sessionId])).rows[0];
    check(Number(count.observations)+observations.length<=4096&&Number(count.segments)+segments.length<=2048,'CAPTURE_LIMIT','Capture journal exceeds its bounded limits');
    check(Number(count.n)===sequence,'CAPTURE_BATCH_SEQUENCE','Send missing journal batches before this batch');
    for(const o of observations) validateObservation(o,row.context_json,300000);
    for(const segment of segments){
      fields(segment,['sequence','offsetBytes','byteSize','sha256','previous','commitment','startMs','endMs','timing']);
      check([segment.sequence,segment.offsetBytes,segment.byteSize,segment.startMs,segment.endMs].every(n=>Number.isSafeInteger(n)&&n>=0)&&segment.byteSize>0&&segment.byteSize<=250000000&&segment.endMs<=300000&&segment.endMs>=segment.startMs&&/^[a-f0-9]{64}$/.test(segment.sha256)&&/^[a-f0-9]{64}$/.test(segment.commitment)&&(segment.previous===null||/^[a-f0-9]{64}$/.test(segment.previous))&&['MEDIA_RANGE','CHUNK_ARRIVAL_APPROXIMATE','WHOLE_RECORDING'].includes(segment.timing),'CAPTURE_SEGMENT_INVALID','Only documented segment commitments are accepted');
    }
    check(Buffer.byteLength(canonical(body))<=131072,'CAPTURE_BATCH_LIMIT','Journal batch is too large');
    await tx.query('INSERT INTO capture_engine_batches(session_id,sequence,batch_sha256,body_json,created_at) VALUES($1,$2,$3,$4::jsonb,$5)',[sessionId,sequence,digest,JSON.stringify(body),clock.now().toISOString()]);
    return {sequence,sha256:digest,validation:'DECLARED_PENDING_SOURCE_VALIDATION'};
  });
}
export async function sealCapture(db:Database,clock:Clock,actor:string,sessionId:string,value:unknown) {
  fields(value,['source','segments','observations','derived','sha256']);
  return db.transaction(async tx=>{
    const row=await access(tx,actor,sessionId,true);
    const manifest=await createManifest(row.context_json,value.source as CaptureManifest['source'],value.segments as MediaSegment[],value.observations as Observation[],hash,[]);
    // Only the server's derivative pipeline can register derived bytes; never accept unverified client artifacts.
    check(!value.derived||(Array.isArray(value.derived)&&value.derived.length===0),'CAPTURE_DERIVATION_UNVERIFIED','Register derived media through the original evidence pipeline');
    for(const o of manifest.observations) if(o.model) check(o.type==='LABEL'&&['mlkit-barcode','browser-barcode','apple-vision-barcode'].includes(o.model.id)&&o.model.calibration==='NOT_CALIBRATED','CAPTURE_MODEL_NOT_RELEASED','This detector has not passed production evaluation');
    const digest=await manifestDigest(manifest,hash);check(value.sha256===digest,'CAPTURE_MANIFEST_MISMATCH','The capture manifest does not match its digest');
    if(row.manifest_json){check(row.manifest_sha256===digest,'CAPTURE_SEALED','A sealed recording cannot be changed');return {captureId:sessionId,sha256:digest,state:'SEALED_WITHOUT_ATTESTATION'};}
    const session=await loadCaptureSession(tx,actor,row.proof_id,sessionId,true);
    check(['RECORDED','UPLOADING'].includes(session.state)&&session.expected_sha256===manifest.source.sha256&&Number(session.expected_byte_size)===manifest.source.byteSize&&session.content_type===manifest.source.contentType,'CAPTURE_SOURCE_MISMATCH','Seal only this session’s registered original');
    const batches=(await tx.query<{body_json:{observations:Observation[];segments:MediaSegment[]}}>('SELECT body_json FROM capture_engine_batches WHERE session_id=$1 ORDER BY sequence',[sessionId])).rows;
    const priorObservations=batches.flatMap(b=>b.body_json.observations),priorSegments=batches.flatMap(b=>b.body_json.segments);
    check(canonical(manifest.observations.slice(0,priorObservations.length))===canonical(priorObservations)&&canonical(manifest.segments.slice(0,priorSegments.length))===canonical(priorSegments),'CAPTURE_JOURNAL_CONFLICT','Sealing cannot replace previously received journal entries');
    await tx.query('UPDATE capture_engine_sessions SET manifest_json=$2::jsonb,manifest_sha256=$3,sealed_at=$4 WHERE session_id=$1',[sessionId,JSON.stringify(manifest),digest,clock.now().toISOString()]);
    await appendAudit(tx,{proofId:row.proof_id,actorUserId:actor,eventType:'CAPTURE_MANIFEST_SEALED',eventData:{sessionId,manifestSha256:digest},at:clock.now()});
    return {captureId:sessionId,sha256:digest,state:'SEALED_WITHOUT_ATTESTATION'};
  });
}
/** Streaming independent verifier. Bounded memory even for a maximum-size recording. */
export async function* inspectSegmentStream(manifest:CaptureManifest,stream:AsyncIterable<Uint8Array>):AsyncGenerator<Uint8Array> {
  let sequence=0,seen=0;let current=createHash('sha256');const full=createHash('sha256');let total=0;
  for await(const part of stream){ const bytes=Buffer.from(part);full.update(bytes);total+=bytes.length;let position=0;
    while(position<bytes.length){ const segment=manifest.segments[sequence];check(segment,'CAPTURE_SEGMENT_MISMATCH','Source contains undeclared bytes');const n=Math.min(segment.byteSize-seen,bytes.length-position);current.update(bytes.subarray(position,position+n));position+=n;seen+=n;
      if(seen===segment.byteSize){check(current.digest('hex')===segment.sha256,'CAPTURE_SEGMENT_MISMATCH','Source segment digest mismatch');sequence++;seen=0;current=createHash('sha256');}
    }
    yield bytes;
  }
  check(sequence===manifest.segments.length&&seen===0&&total===manifest.source.byteSize&&full.digest('hex')===manifest.source.sha256,'CAPTURE_SEGMENT_MISMATCH','Source bytes do not match the complete capture journal');
}
export async function captureStatus(db:Database,actor:string,sessionId:string) {
  const row=await access(db,actor,sessionId);const session=await loadCaptureSession(db,actor,row.proof_id,sessionId);const proof=await loadProof(db,row.proof_id);
  return {captureId:sessionId,proofId:row.proof_id,state:session.state==='COMMITTED'?(proof.status==='FINALIZED'?'FINALIZED':'COMMITTED'):session.state==='CANCELLED'?'CANCELLED':row.manifest_json?'SEALED_WITHOUT_ATTESTATION':'BOUND',manifestSha256:row.manifest_sha256,capabilities:row.context_json.capabilities};
}
export async function captureCapsules(db:Database,actor:string,proofId:string) {
  await requireParticipant(db,proofId,actor);
  const rows=(await db.query<EngineRow&{evidence_id:string}>(`SELECT ce.*,c.evidence_id FROM capture_engine_sessions ce JOIN capture_sessions c ON c.id=ce.session_id WHERE ce.proof_id=$1 AND c.state='COMMITTED' AND ce.manifest_json IS NOT NULL ORDER BY ce.session_id`,[proofId])).rows;
  return {captures:rows.map(r=>({captureId:r.session_id,evidenceId:r.evidence_id,sha256:r.manifest_sha256,capabilities:r.context_json.capabilities,events:r.manifest_json!.events,requirements:r.manifest_json!.requirements,assurance:'Observations and source capabilities are client reported. Byte commitments are independently checked; depicted events are not adjudicated.'}))};
}
export function asDomainError(error:unknown):unknown { return error instanceof CaptureError?new DomainError(error.code,error.message,409):error; }

export async function verifySegmentStream(manifest:CaptureManifest,stream:AsyncIterable<Uint8Array>):Promise<void> { for await (const _ of inspectSegmentStream(manifest,stream)) { /* Validate every byte. */ } }

/** Lost-bind-response recovery is an authenticated read, never a second token redemption. */
export async function recoverIntentContext(db:Database,clock:Clock,actor:string,intentId:string){
  const intent=(await db.query<IntentRow>('SELECT * FROM capture_intents WHERE id=$1 AND actor_user_id=$2',[intentId,actor])).rows[0];
  check(intent&&intent.session_id,'CAPTURE_INTENT_NOT_BOUND','This link has not opened a recording for your account');
  const row=await access(db,actor,intent.session_id);const session=await loadCaptureSession(db,actor,row.proof_id,intent.session_id);
  assertNotFinalized(await loadProof(db,row.proof_id));
  check(session.state==='ISSUED'&&new Date(session.expires_at).getTime()>clock.now().getTime(),'CAPTURE_ALREADY_STARTED','Recover the existing recording from its original device and order');
  return {session:captureSessionView(session),context:row.context_json,contextSha256:row.context_sha256};
}
