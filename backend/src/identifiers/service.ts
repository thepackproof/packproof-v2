import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {DomainError} from '../domain/errors.js';
import {loadProof,requireParticipant} from '../domain/proof-access.js';
import {lockTransactionContext} from '../domain/transactions.js';
import {loadCaptureSession,type CaptureSessionRow} from '../domain/capture-sessions.js';
import {shippingBarcode} from '../domain/capture-shipping.js';
import {appendAudit} from '../domain/audit.js';
import {enqueueRecoveryEvent,buildProofRecoverySnapshot} from '../domain/recovery-journal.js';
import {appendProofSupplementInTransaction} from '../domain/proof-supplements.js';
import type {ManifestSigner} from '../domain/manifest-signing.js';
import {classifyIdentifier,normalizeGtin,sanitizeIdentifierPayload} from './core.js';
import type {IdentifierObservation,IdentifierResolution,IdentifierReview,IdentifierPolicy,ParsedIdentifier} from './types.js';
import {findIdentifierAliases,distinctProductAliases,type AliasRow} from './catalog.js';
const fail=(code:string,message:string,status=409):never=>{throw new DomainError(code,message,status);};
const text=(v:unknown,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max;
const int=(v:unknown,max=1_800_000)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
interface StoredObservation {id:string;sequence:number;client_event_id:string;request_sha256:string;observation_json:IdentifierObservation;resolution_json:IdentifierResolution;supplemental:boolean;}
interface Checkpoint {id:string;revision:number;last_sequence:number;coverage:IdentifierReview['coverage'];omitted_events:number;sha256:string;canonical_json:string;request_sha256:string;client_event_id:string;}
interface ExpectedItem {title:string|null;sku?:string|null;gtin?:string|null;barcode?:string|null;externalItemId?:string|null;variant?:string|null;}
async function scopeFor(db:Database,actor:string,proofId:string,session?:CaptureSessionRow) {
 const row=(await db.query<{id:string;digest:string;context:{tenantKey:string;items:ExpectedItem[]};connection_id:string;status:string|null;owner_user_id:string|null}>(`SELECT s.*,o.connection_id,c.status,c.owner_user_id FROM intake_order_snapshots s JOIN intake_source_observations o ON o.id=s.observation_id LEFT JOIN integration_connections c ON c.id=o.connection_id WHERE s.id=COALESCE($2,(SELECT approved_snapshot_id FROM proof_order_contexts WHERE proof_id=$1)) AND s.proof_id=$1`,[proofId,session?.order_snapshot_id??null])).rows[0];
 return row?{actor,tenantKey:row.context.tenantKey,connectionId:row.connection_id,snapshotId:row.id,revision:row.digest,items:row.context.items,active:row.status==='ACTIVE'&&row.owner_user_id===actor}:null;
}
function expectedView(scope:Awaited<ReturnType<typeof scopeFor>>):IdentifierResolution['expected'] {return scope?.items.map((i,n)=>({title:i.title??'Item',sku:i.sku??null,gtin:normalizeGtin(i.gtin??i.barcode??''),sourceRef:`${scope.snapshotId}:${n+1}`,sourceRevision:scope.revision}))??[];}
function validateEvent(v:unknown,sessionId:string):IdentifierObservation {
 if(!v||typeof v!=='object'||Array.isArray(v))fail('IDENTIFIER_OBSERVATION_INVALID','A barcode observation is required.',400);
 const e=v as IdentifierObservation;
 const fields=['schemaVersion','clientEventId','captureSessionId','sequence','rawText','rawBytes','decoderEncoding','symbology','symbologyIdentifier','source','mediaTimeMs','timestampOrigin','timestampUncertaintyMs','recordingRef','adapterVersion','decoderVersion','capabilityProfile','frameWidth','frameHeight','coordinateSpace','bounds','firstSeenMs','lastSeenMs','sightings'];
 if(Object.keys(e).some(k=>!fields.includes(k))||e.schemaVersion!==1||!text(e.clientEventId)||e.captureSessionId!==sessionId||!int(e.sequence,1000000)||e.sequence===0||!text(e.rawText,4096)||Buffer.byteLength(e.rawText)>4096||!text(e.symbology,80)||!text(e.adapterVersion,100)||!text(e.decoderVersion,100)||!text(e.capabilityProfile,200)||e.recordingRef!==sessionId)fail('IDENTIFIER_OBSERVATION_INVALID','Use a versioned barcode observation tied to the original recording.',400);
 if(!['LIVE_CAMERA_ANALYSIS','ENCODED_VIDEO_FRAME'].includes(e.source)||!['MONOTONIC_APPROXIMATE','ENCODED_MEDIA'].includes(e.timestampOrigin)||!int(e.mediaTimeMs)||!int(e.firstSeenMs)||!int(e.lastSeenMs)||e.firstSeenMs>e.lastSeenMs||e.mediaTimeMs<e.firstSeenMs||e.mediaTimeMs>e.lastSeenMs||!int(e.sightings,1000000)||e.sightings<1||(e.timestampUncertaintyMs!=null&&!int(e.timestampUncertaintyMs))||(e.source==='LIVE_CAMERA_ANALYSIS'&&e.timestampOrigin==='ENCODED_MEDIA'))fail('IDENTIFIER_OBSERVATION_INVALID','The barcode timing or source is invalid.',400);
 for(const key of ['rawBytes','decoderEncoding','symbologyIdentifier','coordinateSpace'] as const)if(e[key]!=null&&!text(e[key],key==='rawBytes'?8192:200))fail('IDENTIFIER_OBSERVATION_INVALID','Invalid decoder metadata.',400);
 for(const key of ['frameWidth','frameHeight'] as const)if(e[key]!=null&&(!int(e[key],20000)||e[key]===0))fail('IDENTIFIER_OBSERVATION_INVALID','Invalid frame dimensions.',400);
 if(e.bounds!=null&&(!e.bounds||typeof e.bounds!=='object'||Object.keys(e.bounds).some(k=>!['x','y','width','height'].includes(k))||![e.bounds.x,e.bounds.y,e.bounds.width,e.bounds.height].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=20000)))fail('IDENTIFIER_OBSERVATION_INVALID','Invalid barcode coordinates.',400);
 return e;
}
async function resolve(db:Database,actor:string,proofId:string,session:CaptureSessionRow,e:IdentifierObservation):Promise<Omit<IdentifierResolution,'observationId'|'receivedAt'|'observation'|'supplemental'>> {
 const parsed=classifyIdentifier(e),scope=await scopeFor(db,actor,proofId,session),expected=expectedView(scope);
 const base={clientEventId:e.clientEventId,sequence:e.sequence,identifiers:parsed.identifiers,reasonCodes:parsed.reasonCodes,product:null,expected,reviewRequired:false,decision:null};
 if(parsed.kind==='UNSUPPORTED')return {...base,route:'UNKNOWN',state:'UNSUPPORTED',identifiers:[]};
 const productCodes=parsed.identifiers.filter(i=>i.type==='GTIN'&&i.validationResult==='VALID'&&i.normalizedValue);
 const policy=session.identifier_policy;
 let aliases:AliasRow[]=[];
 if(scope?.active){
   for(const id of productCodes)aliases.push(...await findIdentifierAliases(db,scope,'GTIN',id.normalizedValue!));
   if(parsed.kind==='OPAQUE')aliases.push(...await findIdentifierAliases(db,scope,'SKU',e.rawText));
 }
 const tracking=parsed.kind==='OPAQUE'?shippingBarcode(e.rawText):null;
 const shipping=(await db.query<{tracking_number:string|null}>(`SELECT s.tracking_number FROM transaction_shipping s JOIN proofs p ON p.transaction_id=s.transaction_id WHERE p.id=$1`,[proofId])).rows[0]?.tracking_number;
 const approvedShipping=Boolean(tracking&&(tracking.distinctive||tracking.trackingNumber===shipping?.replace(/[\s-]/g,'').toUpperCase()));
 if(tracking&&aliases.length)return {...base,route:'AMBIGUOUS',state:'AMBIGUOUS',reasonCodes:[...base.reasonCodes,'SKU_TRACKING_OVERLAP']};
 if(approvedShipping)return {...base,route:'SHIPPING',state:'UNKNOWN',reasonCodes:['EXISTING_SHIPPING_PARSER'],identifiers:[]};
 if(!policy?.autofillEnabled)return {...base,route:parsed.kind==='PRODUCT'||parsed.kind==='STRUCTURED'?'PRODUCT':'UNKNOWN',state:'UNKNOWN',reasonCodes:[...base.reasonCodes,'AUTOFILL_DISABLED']};
 if(!scope)return {...base,route:'UNKNOWN',state:'UNKNOWN',reasonCodes:[...base.reasonCodes,'ORDER_SOURCE_UNAVAILABLE']};
 if(!scope.active)return {...base,route:'UNKNOWN',state:'FORBIDDEN',reasonCodes:[...base.reasonCodes,'SOURCE_DISCONNECTED']};
 const products=distinctProductAliases(aliases);
 if(products.size>1||aliases.length>=201)return {...base,route:'AMBIGUOUS',state:'AMBIGUOUS',reasonCodes:[...base.reasonCodes,'DUPLICATE_PRODUCT_ALIAS']};
 if(!aliases.length){
   const stale=(await db.query(`SELECT 1 FROM identifier_aliases WHERE owner_user_id=$1 AND tenant_key=$2 AND connection_id=$3 AND ((identifier_type='SKU' AND normalized_value=$4) OR (identifier_type='GTIN' AND normalized_value=ANY($5::text[]))) LIMIT 1`,[actor,scope.tenantKey,scope.connectionId,parsed.kind==='OPAQUE'?e.rawText:'',productCodes.map(i=>i.normalizedValue)])).rows.length>0;
   return {...base,route:parsed.kind==='PRODUCT'||parsed.kind==='STRUCTURED'?'PRODUCT':'UNKNOWN',state:stale?'STALE':'UNKNOWN',reasonCodes:[...base.reasonCodes,stale?'SOURCE_REVISION_STALE':'NO_EXACT_AUTHORIZED_MAPPING']};
 }
 const a=products.values().next().value!,p=a.product_json;
 // Compare the pinned order only. A source mapping never changes the frozen line.
 const matched=scope.items.some((item,n)=>a.source_ref===`${scope.snapshotId}:${n+1}`||Boolean(item.sku&&p.sku&&item.sku===p.sku)||Boolean(normalizeGtin(item.gtin??item.barcode??'')&&normalizeGtin(item.gtin??item.barcode??'')===p.gtin));
 const identifiers:ParsedIdentifier[]=parsed.kind==='OPAQUE'?[{type:'SKU',value:e.rawText,normalizedValue:e.rawText,namespace:`${scope.tenantKey}:${scope.connectionId}`,validationResult:'VALID',parserVersion:'packproof.exact-source/1'}]:parsed.identifiers;
 const state=matched?'MATCH':scope.items.length?'CONFLICT':'RESOLVED_PRODUCT';
 return {...base,identifiers,route:'PRODUCT',state,product:p.title?{title:p.title,variant:p.variant,sku:p.sku,imageUrl:p.imageUrl,sourceRef:a.source_ref,sourceRevision:a.source_revision,sourceKind:'ORDER_SNAPSHOT'}:null,reasonCodes:[...base.reasonCodes,matched?'EXACT_PINNED_ORDER_IDENTIFIER':'EXACT_SOURCE_ITEM_NOT_IN_PINNED_ORDER'],reviewRequired:state==='CONFLICT'&&policy.reviewEnabled};
}
async function stored(db:Database,sessionId:string) {return (await db.query<StoredObservation>('SELECT * FROM capture_identifier_observations WHERE session_id=$1 ORDER BY sequence',[sessionId])).rows;}
async function checkpointRow(db:Database,sessionId:string) {return (await db.query<Checkpoint>('SELECT * FROM capture_identifier_checkpoints WHERE session_id=$1',[sessionId])).rows[0]??null;}
async function review(db:Database,session:CaptureSessionRow):Promise<IdentifierReview> {
 const rows=await stored(db,session.id);
 const decisions=(await db.query<{observation_id:string;decision:'NOT_THIS_SHIPMENT'|'ACKNOWLEDGE_MISMATCH';reason:string;actor_user_id:string;created_at:string|Date}>('SELECT * FROM capture_identifier_decisions WHERE session_id=$1',[session.id])).rows;
 const observations=rows.map(row=>{const d=decisions.find(x=>x.observation_id===row.id);return {...row.resolution_json,observationId:row.id,observation:row.observation_json,supplemental:row.supplemental,decision:d?{decision:d.decision,reason:d.reason,actorId:d.actor_user_id,createdAt:new Date(d.created_at).toISOString()}:null};});
 const checkpoint=await checkpointRow(db,session.id);const sequenceSet=new Set(rows.map(r=>r.sequence));let acknowledgedSequence=0;while(sequenceSet.has(acknowledgedSequence+1))acknowledgedSequence++;
 return {schemaVersion:1,enabled:session.identifier_policy?.captureEnabled===true,policy:session.identifier_policy??null,revision:rows.length+decisions.length,acceptedEventIds:rows.map(r=>r.client_event_id),acknowledgedSequence,coverage:checkpoint?.coverage??(session.identifier_policy?.captureEnabled?'PARTIAL':'UNAVAILABLE'),omittedEvents:checkpoint?.omitted_events??0,reviewRequired:observations.some(o=>o.reviewRequired&&!o.decision&&!o.supplemental),observations,checkpoint:checkpoint?{id:checkpoint.id,revision:checkpoint.revision,sha256:checkpoint.sha256,coverage:checkpoint.coverage}:null};
}
async function writable(db:Database,clock:Clock,actor:string,proofId:string,sessionId:string) {
 await requireParticipant(db,proofId,actor,'SELLER');const proof=await loadProof(db,proofId);await lockTransactionContext(db,proof.transaction_id);const session=await loadCaptureSession(db,actor,proofId,sessionId,true);
 if(session.stage_id||session.workflow_step!=='PACKING'||session.state==='CANCELLED')fail('IDENTIFIER_SESSION_UNAVAILABLE','Use the original packing recording.');
 if(!session.identifier_policy?.captureEnabled)fail('IDENTIFIER_DISABLED','Barcode enrichment is not enabled for this recording.',422);
 if(clock.now().getTime()>new Date(session.recover_until).getTime())fail('IDENTIFIER_RECOVERY_EXPIRED','This recording is outside its recovery window.');
 return session;
}
export async function getIdentifierReview(db:Database,actor:string,proofId:string,sessionId:string) {await requireParticipant(db,proofId,actor,'SELLER');return review(db,await loadCaptureSession(db,actor,proofId,sessionId));}
export async function appendIdentifierObservations(db:Database,clock:Clock,actor:string,proofId:string,sessionId:string,input:unknown,signer?:ManifestSigner) {
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='events'))fail('IDENTIFIER_BATCH_INVALID','Provide a bounded observation batch.',400);
 const events=(input as {events:unknown}).events;
 if(!Array.isArray(events)||events.length>50||events.length<1||Buffer.byteLength(canonicalize(input))>131072)fail('IDENTIFIER_BATCH_LIMIT','Send at most 50 barcode observations and 128 KiB.',413);
 const parsed=(events as unknown[]).map(e=>validateEvent(e,sessionId));
 return db.transaction(async tx=>{
  const session=await writable(tx,clock,actor,proofId,sessionId),prior=await stored(tx,sessionId),checkpoint=await checkpointRow(tx,sessionId);
  const frozen=(await tx.query('SELECT 1 FROM final_manifests WHERE proof_id=$1',[proofId])).rows.length>0;
  const supplemental=Boolean(checkpoint||frozen),accepted:string[]=[];
  for(const event of parsed){
   const digest=sha256Hex(canonicalize(event));const old=prior.find(r=>r.client_event_id===event.clientEventId);
   if(old){if(old.request_sha256!==digest)fail('IDENTIFIER_EVENT_CONFLICT','An observation retry cannot change its contents.');continue;}
   if(prior.some(r=>r.sequence===event.sequence))fail('IDENTIFIER_SEQUENCE_CONFLICT','A sequence number already belongs to another observation.');
   if(session.client_reported_context?.recordedDurationMs!=null&&event.lastSeenMs>session.client_reported_context.recordedDurationMs)fail('IDENTIFIER_TIME_INVALID','The barcode falls outside the recorded duration.',400);
   const resolved=await resolve(tx,actor,proofId,session,event);
   if(prior.length>=512||(prior.length>=496&&resolved.route!=='SHIPPING'&&!resolved.reasonCodes.includes('SKU_TRACKING_OVERLAP')))fail('IDENTIFIER_SESSION_LIMIT','Barcode analysis reached its limit; preserve the video and mark incomplete coverage.',413);
   const id=newId('identifier'),receivedAt=clock.now().toISOString();
   const observation=sanitizeIdentifierPayload(event);
   const result:IdentifierResolution={...resolved,observationId:id,receivedAt,observation,supplemental};
   await tx.query(`INSERT INTO capture_identifier_observations(id,proof_id,session_id,actor_user_id,client_event_id,sequence,request_sha256,observation_json,resolution_json,supplemental,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,[id,proofId,sessionId,actor,event.clientEventId,event.sequence,digest,JSON.stringify(observation),JSON.stringify(result),supplemental,receivedAt]);
   prior.push({id,sequence:event.sequence,client_event_id:event.clientEventId,request_sha256:digest,observation_json:observation,resolution_json:result,supplemental});accepted.push(id);
  }
  if(accepted.length){
   await appendAudit(tx,{proofId,actorUserId:actor,eventType:'IDENTIFIER_OBSERVATIONS_RECORDED',eventData:{sessionId,observationIds:accepted,supplemental},at:clock.now()});
   if(supplemental){
    const finalized=(await loadProof(tx,proofId)).status==='FINALIZED';
    if(finalized&&signer)await appendProofSupplementInTransaction(tx,clock,signer,actor,proofId,{operationId:`identifiers:${sha256Hex(accepted.join(':'))}`,kind:'CORRECTION',facts:{schemaVersion:1,kind:'SUPPLEMENTAL_IDENTIFIER_OBSERVATIONS',captureSessionId:sessionId,observationIds:accepted,assurance:'Later interpretation; original manifest and attestation unchanged.'}});
    else await enqueueRecoveryEvent(tx,clock,{operationId:`identifiers:${sha256Hex(accepted.join(':'))}`,kind:'SOURCE_OBSERVED',proofId,actorUserId:actor,payload:await buildProofRecoverySnapshot(tx,proofId)});
   }
  }
  return review(tx,session);
 });
}
export async function decideIdentifier(db:Database,clock:Clock,actor:string,proofId:string,sessionId:string,input:unknown) {
 const v=input as {clientEventId:string;observationId:string;revision:number;decision:'NOT_THIS_SHIPMENT'|'ACKNOWLEDGE_MISMATCH';reason:string};
 if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['clientEventId','observationId','revision','decision','reason'].includes(k))||!text(v.clientEventId)||!text(v.observationId)||!int(v.revision,2048)||!['NOT_THIS_SHIPMENT','ACKNOWLEDGE_MISMATCH'].includes(v.decision)||!text(v.reason,500)||!v.reason.trim())fail('IDENTIFIER_DECISION_INVALID','Explain the item-code review decision.',400);
 return db.transaction(async tx=>{
  const session=await writable(tx,clock,actor,proofId,sessionId),digest=sha256Hex(canonicalize(v));
  const replay=(await tx.query<{request_sha256:string}>('SELECT request_sha256 FROM capture_identifier_decisions WHERE session_id=$1 AND client_event_id=$2',[sessionId,v.clientEventId])).rows[0];
  if(replay){if(replay.request_sha256!==digest)fail('IDENTIFIER_DECISION_CONFLICT','A review decision retry cannot change its contents.');return review(tx,session);}
  const current=await review(tx,session);if(current.revision!==v.revision)fail('IDENTIFIER_REVIEW_STALE','Item-code review changed. Refresh it before deciding.');
  const observation=current.observations.find(o=>o.observationId===v.observationId);if(!observation)fail('IDENTIFIER_OBSERVATION_NOT_FOUND','This barcode does not belong to this recording.',404);
  if(observation!.decision||(!observation!.reviewRequired&&observation!.state!=='AMBIGUOUS'))fail('IDENTIFIER_DECISION_CONFLICT','This code has no unresolved material review.');
  if(current.checkpoint&&!observation!.supplemental)fail('IDENTIFIER_CHECKPOINT_SEALED','The original barcode review is already sealed.');
  const id=newId('identifier_decision');await tx.query(`INSERT INTO capture_identifier_decisions(id,proof_id,session_id,actor_user_id,observation_id,client_event_id,request_sha256,revision,decision,reason,supplemental,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,proofId,sessionId,actor,v.observationId,v.clientEventId,digest,v.revision,v.decision,v.reason,observation!.supplemental,clock.now().toISOString()]);
  await appendAudit(tx,{proofId,actorUserId:actor,eventType:'IDENTIFIER_REVIEW_RECORDED',eventData:{sessionId,observationId:v.observationId,decisionId:id,decision:v.decision},at:clock.now()});
  if(observation!.supplemental)await enqueueRecoveryEvent(tx,clock,{operationId:`identifier-decision:${id}`,kind:'SOURCE_OBSERVED',proofId,actorUserId:actor,payload:await buildProofRecoverySnapshot(tx,proofId)});
  return review(tx,session);
 });
}
type CheckpointInput={clientEventId:string;revision:number;lastSequence:number;coverage:IdentifierReview['coverage'];omittedEvents:number};
async function makeCheckpoint(tx:Database,clock:Clock,actor:string,proofId:string,session:CaptureSessionRow,input:CheckpointInput) {
 const current=await review(tx,session),digest=sha256Hex(canonicalize(input));const old=await checkpointRow(tx,session.id);
 if(old){if(old.client_event_id!==input.clientEventId||old.request_sha256!==digest)fail('IDENTIFIER_CHECKPOINT_CONFLICT','This recording already has a different barcode checkpoint.');return current;}
 if(current.revision!==input.revision)fail('IDENTIFIER_REVIEW_STALE','The barcode review changed; refresh before confirming.');
 if(current.reviewRequired)fail('IDENTIFIER_REVIEW_REQUIRED','Review the item code that does not match this order before confirming.');
 if(input.lastSequence<Math.max(0,...current.observations.map(o=>o.sequence)))fail('IDENTIFIER_CHECKPOINT_INVALID','The checkpoint omits acknowledged barcode events.');
 if(input.coverage==='COMPLETE'&&(input.omittedEvents!==0||current.acknowledgedSequence!==input.lastSequence))fail('IDENTIFIER_COVERAGE_INCOMPLETE','Unacknowledged barcode events require partial coverage.');
 const id=newId('identifier_checkpoint'),at=clock.now().toISOString();
 const canonical=canonicalize({schemaVersion:1,proofId,captureSessionId:session.id,policy:session.identifier_policy,revision:input.revision,lastSequence:input.lastSequence,coverage:input.coverage,omittedEvents:input.omittedEvents,observations:current.observations.filter(o=>!o.supplemental),createdAt:at});
 await tx.query(`INSERT INTO capture_identifier_checkpoints(id,proof_id,session_id,actor_user_id,client_event_id,request_sha256,revision,last_sequence,coverage,omitted_events,canonical_json,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,proofId,session.id,actor,input.clientEventId,digest,input.revision,input.lastSequence,input.coverage,input.omittedEvents,canonical,sha256Hex(canonical),at]);
 await enqueueRecoveryEvent(tx,clock,{operationId:`identifier-checkpoint:${id}`,kind:'SOURCE_OBSERVED',proofId,actorUserId:actor,payload:await buildProofRecoverySnapshot(tx,proofId)});
 return review(tx,session);
}
export async function checkpointIdentifiers(db:Database,clock:Clock,actor:string,proofId:string,sessionId:string,input:unknown) {
 const v=input as CheckpointInput;
 if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['clientEventId','revision','lastSequence','coverage','omittedEvents'].includes(k))||!text(v.clientEventId)||!int(v.revision,2048)||!int(v.lastSequence,1000000)||!int(v.omittedEvents,1000000)||!['COMPLETE','PARTIAL','UNAVAILABLE'].includes(v.coverage))fail('IDENTIFIER_CHECKPOINT_INVALID','Provide the barcode acknowledgment and coverage checkpoint.',400);
 return db.transaction(async tx=>makeCheckpoint(tx,clock,actor,proofId,await writable(tx,clock,actor,proofId,sessionId),v));
}
/** Existing attestation/finalization transactions already own the Proof lock. */
export async function ensureIdentifierBarrier(db:Database,clock:Clock,proofId:string,sessionId:string) {
 const session=(await db.query<CaptureSessionRow>('SELECT * FROM capture_sessions WHERE id=$1 AND proof_id=$2 FOR UPDATE',[sessionId,proofId])).rows[0];
 if(!session?.identifier_policy?.captureEnabled)return;
 const current=await review(db,session);if(current.reviewRequired)fail('IDENTIFIER_REVIEW_REQUIRED','Review the item code that does not match this order before confirming.');
 const checkpoint=await checkpointRow(db,sessionId);
 if(checkpoint){if(sha256Hex(checkpoint.canonical_json)!==checkpoint.sha256)fail('IDENTIFIER_CHECKPOINT_CORRUPT','The recorded barcode checkpoint failed its integrity check.',500);return;}
 // Optional enrichment outage never loses the recording or bypasses known conflict review.
 await makeCheckpoint(db,clock,session.actor_user_id,proofId,session,{clientEventId:'server-unavailable-checkpoint-v1',revision:current.revision,lastSequence:Math.max(0,...current.observations.map(o=>o.sequence)),coverage:current.observations.length?'PARTIAL':'UNAVAILABLE',omittedEvents:0});
}
export async function identifierAttestationContext(db:Database,transactionId:string) {
 const rows=(await db.query<{session_id:string;sha256:string}>(`SELECT c.session_id,c.sha256 FROM capture_identifier_checkpoints c JOIN proofs p ON p.id=c.proof_id WHERE p.transaction_id=$1 ORDER BY c.session_id`,[transactionId])).rows;
 return rows.length?rows.map(row=>({captureSessionId:row.session_id,sha256:row.sha256})):undefined;
}
export async function sealedIdentifiers(db:Database,proofId:string) {
 const rows=(await db.query<Checkpoint>('SELECT * FROM capture_identifier_checkpoints WHERE proof_id=$1 ORDER BY session_id',[proofId])).rows;
 return rows.length?{schemaVersion:1,checkpoints:rows.map(row=>({checkpointId:row.id,sha256:row.sha256,...JSON.parse(row.canonical_json)}))}:undefined;
}
export async function identifierProjection(db:Database,proofId:string,includeRaw=false) {
 const sessions=(await db.query<CaptureSessionRow>(`SELECT * FROM capture_sessions WHERE proof_id=$1 AND identifier_policy IS NOT NULL ORDER BY created_at,id`,[proofId])).rows;
 const reviews=await Promise.all(sessions.filter(s=>s.identifier_policy?.captureEnabled).map(s=>review(db,s)));
 if(!reviews.length)return undefined;
 return {schemaVersion:1,coverage:reviews.some(r=>r.coverage==='PARTIAL')?'PARTIAL':reviews.every(r=>r.coverage==='COMPLETE')?'COMPLETE':'UNAVAILABLE',reviewRequired:reviews.some(r=>r.reviewRequired),observations:reviews.flatMap(r=>r.observations).map(o=>({...o,evidenceId:sessions.find(s=>s.id===o.observation.captureSessionId)?.evidence_id??null,...(includeRaw?{}:{observation:{...o.observation,rawText:'',rawBytes:null},decision:o.decision?{...o.decision,reason:'',actorId:''}:null})}))};
}
export async function identifierCandidates(db:Database,actor:string,input:unknown) {
 const v=input as {integrationAccountId:string;rawText:string;symbology:string;symbologyIdentifier?:string};
 if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['integrationAccountId','rawText','symbology','symbologyIdentifier'].includes(k))||!text(v.integrationAccountId)||!text(v.rawText,4096)||Buffer.byteLength(v.rawText)>4096||!text(v.symbology,80))fail('IDENTIFIER_CANDIDATE_INVALID','Choose a connected store and supported barcode.',400);
 const connection=(await db.query<{status:string}>('SELECT status FROM integration_connections WHERE id=$1 AND owner_user_id=$2',[v.integrationAccountId,actor])).rows[0];
 if(!connection)fail('IDENTIFIER_SOURCE_FORBIDDEN','The connected store belongs to another account.',403);
 if(connection.status!=='ACTIVE')return {state:'FORBIDDEN',products:[],orders:[],reasonCodes:['SOURCE_DISCONNECTED']};
 const parsed=classifyIdentifier(v);if(parsed.kind==='UNSUPPORTED')return {state:'UNSUPPORTED',products:[],orders:[],reasonCodes:parsed.reasonCodes};
 const tenants=(await db.query<{tenant_key:string}>('SELECT DISTINCT tenant_key FROM identifier_aliases WHERE connection_id=$1 AND owner_user_id=$2',[v.integrationAccountId,actor])).rows;
 const aliases:AliasRow[]=[];
 for(const t of tenants){const scope={actor,tenantKey:t.tenant_key,connectionId:v.integrationAccountId};for(const id of parsed.identifiers)if(id.type==='GTIN'&&id.validationResult==='VALID'&&id.normalizedValue)aliases.push(...await findIdentifierAliases(db,scope,'GTIN',id.normalizedValue));if(parsed.kind==='OPAQUE')aliases.push(...await findIdentifierAliases(db,scope,'SKU',v.rawText));}
 const products=[...distinctProductAliases(aliases).values()].map(a=>({...a.product_json,sourceRef:a.source_ref,sourceRevision:a.source_revision,sourceKind:'ORDER_SNAPSHOT'}));
 const orders=(await db.query<{proofId:string;transactionId:string;snapshotId:string;orderReference:string}>(`SELECT DISTINCT p.id AS "proofId",p.transaction_id AS "transactionId",s.id AS "snapshotId",s.context->>'orderReference' AS "orderReference" FROM proofs p JOIN transactions t ON t.id=p.transaction_id JOIN proof_order_contexts c ON c.proof_id=p.id JOIN intake_order_snapshots s ON s.id=c.approved_snapshot_id JOIN intake_source_observations o ON o.id=s.observation_id LEFT JOIN commerce_order_records r ON r.transaction_id=p.transaction_id WHERE t.created_by=$1 AND o.connection_id=$2 AND p.status IN ('READY_FOR_EVIDENCE','OPEN') AND c.material_conflict=false AND p.transaction_id=ANY($3::text[]) AND (r.id IS NULL OR r.eligibility='FULFILLMENT_ELIGIBLE') ORDER BY p.id LIMIT 50`,[actor,v.integrationAccountId,[...new Set(aliases.flatMap(a=>a.transaction_id?[a.transaction_id]:[]))]])).rows;
 return {state:products.length>1?'AMBIGUOUS':products.length?'RESOLVED_PRODUCT':'UNKNOWN',products,orders,reasonCodes:[products.length?'EXPLICIT_ORDER_SELECTION_REQUIRED':'NO_EXACT_AUTHORIZED_MAPPING']};
}
