import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { createPublicKey,verify } from 'node:crypto';
import { canonicalize,parseStrictJson } from '../../../packages/evidence-contracts/contracts.mjs';
import { requireRnd,requireConsentAdmission,CAPTURE_RECEIPT_PROFILE } from './config.js';
import { authorized,bad,boundedId,digest,idempotent,nonce,onlyKeys,requireConsent,resolveSources,signedRecord,subjectFor } from './security.js';
import type { RndDeps } from './types.js';

/** Account/Proof-scoped readback; absence is never opt-in, and withdrawal stays observable after disable. */
export async function currentConsents(deps:RndDeps,actor:string,proofId:string) {
 await authorized(deps.db,proofId,actor);
 const rows=(await deps.db.query<{purpose:string;version:string;granted:boolean;created_at:Date|string}>(`SELECT DISTINCT ON (purpose) purpose,version,granted,created_at FROM rnd_consents WHERE proof_id=$1 AND actor_id=$2 ORDER BY purpose,created_at DESC,id DESC`,[proofId,actor])).rows;
 const purposes=['EXPERIMENTAL_ANALYSIS','LEARNING'] as const;
 const allowedPurposes=purposes.filter(purpose=>{try{requireConsentAdmission(deps.rnd,purpose);return true;}catch{return false;}});
 return {proofId,allowedPurposes,consents:purposes.map(purpose=>{const row=rows.find(item=>item.purpose===purpose);return {purpose,version:row?.version??'packproof.research-consent.v1',granted:row?.granted===true,recordedAt:row?new Date(row.created_at).toISOString():null};})};
}
export async function captureReceipts(deps:RndDeps,actor:string,proofId:string) {
 requireRnd(deps.rnd,'verifiedcapture','internalDisplay');await authorized(deps.db,proofId,actor);
 const rows=(await deps.db.query<{canonical_json:string;digest:string;signature:unknown}>(`SELECT r.canonical_json,r.digest,r.signature FROM rnd_session_receipts r JOIN rnd_intents i ON i.id=r.intent_id WHERE i.proof_id=$1 ORDER BY r.created_at,i.id LIMIT 100`,[proofId])).rows;
 return {proofId,captureReceipts:rows.map(row=>({receipt:JSON.parse(row.canonical_json),canonicalJson:row.canonical_json,digest:row.digest,signature:row.signature})),qualification:'DIGITAL_RECEIPTS_ONLY',limitations:['A signed final-file receipt binds submitted bytes to a server-recorded session; it does not authenticate the physical scene, camera sensor or incremental recording continuity.']};
}
export async function recordConsent(deps:RndDeps,actor:string,proofId:string,key:unknown,input:unknown) {
 onlyKeys(input,['purpose','version','granted']);
 if(input.version!=='packproof.research-consent.v1'||!['EXPERIMENTAL_ANALYSIS','LEARNING'].includes(String(input.purpose))||typeof input.granted!=='boolean')bad('RND_INVALID_CONSENT','Use the explicit versioned research consent');
 // Withdrawal remains available after the collection kill switch is activated.
 if(input.granted)requireConsentAdmission(deps.rnd,input.purpose as 'EXPERIMENTAL_ANALYSIS'|'LEARNING');
 return idempotent(deps,proofId,actor,'consent',key,input,async tx=>{
  // idempotent() holds the Proof row lock. Keep consent order deterministic even
  // for opposite decisions in the same clock millisecond or after clock rollback.
  const previous=(await tx.query<{created_at:Date|string}>('SELECT created_at FROM rnd_consents WHERE proof_id=$1 AND actor_id=$2 AND purpose=$3 ORDER BY created_at DESC,id DESC LIMIT 1',[proofId,actor,input.purpose])).rows[0];
  const id=newId('rnd_consent'),createdAt=new Date(Math.max(deps.clock.now().getTime(),previous?new Date(previous.created_at).getTime()+1:0)).toISOString();
  await tx.query('INSERT INTO rnd_consents(id,proof_id,actor_id,purpose,version,granted,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,proofId,actor,input.purpose,input.version,input.granted,createdAt]);
  return {id,proofId,actorId:actor,...input,createdAt,notice:deps.rnd?.profile===CAPTURE_RECEIPT_PROFILE?'Withdrawal stops future optional receipt collection; previously committed signed records remain part of the Proof history.':'Withdrawal stops future participation; already aggregated updates cannot automatically be unlearned.'};
 });
}
export async function issueIntent(deps:RndDeps,actor:string,proofId:string,key:unknown,input:unknown) {
 requireRnd(deps.rnd,'verifiedcapture','collection');
 onlyKeys(input,['legId','acquisitionMode','profileId']);
 const legId=boundedId(input.legId??'OUTBOUND','leg'),profileId=boundedId(input.profileId??'unqualified-final-file-v1','profile');
 if(deps.rnd?.profile===CAPTURE_RECEIPT_PROFILE&&profileId!=='native-final-file-v1')bad('RND_CAPTURE_PROFILE_UNSUPPORTED','The supported product profile is native final-file receipts only');
 if(!['ONLINE','OFFLINE'].includes(String(input.acquisitionMode)))bad('RND_INVALID_MODE','Choose explicit ONLINE or OFFLINE acquisition');
 return idempotent(deps,proofId,actor,'intent',key,input,async tx=>{
  await requireConsent(tx,proofId,actor);
  const subject=await subjectFor(deps,tx,proofId,actor,legId,true),id=newId('rnd_intent'),rawNonce=nonce();
  const issuedAt=deps.clock.now().toISOString(),expiresAt=new Date(deps.clock.now().getTime()+5*60_000).toISOString();
  const intent={schemaVersion:'packproof.capture-intent.v1',id,tenantId:subject.tenantId,proofId,subject,actorId:actor,
   nonce:rawNonce,issuedAt,expiresAt,acquisitionMode:input.acquisitionMode,profileId,coverageMode:'FINAL_FILE_ONLY',
   requestBindingDigest:digest({proofId,subject,actorId:actor,profileId,nonce:rawNonce,acquisitionMode:input.acquisitionMode})};
  const record=await signedRecord(deps,proofId,id,intent);
  await tx.query('INSERT INTO rnd_intents(id,proof_id,tenant_id,subject_id,actor_id,nonce_hash,canonical_json,digest,signature,acquisition_mode,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,proofId,subject.tenantId,subject.id,actor,sha256Hex(rawNonce),record.canonicalJson,record.digest,JSON.stringify(record.signature),input.acquisitionMode,expiresAt,issuedAt]);
  return {intent,...record};
 });
}
export async function startIntent(deps:RndDeps,actor:string,proofId:string,intentId:string,key:unknown,input:unknown) {
 requireRnd(deps.rnd,'verifiedcapture','collection');onlyKeys(input,['nonce','captureSessionId','clientPublicKeyPem']);
 if(deps.rnd?.profile===CAPTURE_RECEIPT_PROFILE&&typeof input.clientPublicKeyPem!=='string')bad('RND_CLIENT_KEY_REQUIRED','Native final-file receipts require a session signing key bound before recording');
 const captureSessionId=boundedId(input.captureSessionId,'capture session');
 if(typeof input.nonce!=='string'||input.nonce.length>128)bad('RND_INVALID_NONCE','Invalid challenge nonce');
 return idempotent(deps,proofId,actor,`start:${intentId}`,key,input,async tx=>{
  await requireConsent(tx,proofId,actor);
  const row=(await tx.query<{nonce_hash:string;expires_at:Date|string;canonical_json:string;acquisition_mode:string}>('SELECT * FROM rnd_intents WHERE id=$1 AND proof_id=$2 AND actor_id=$3',[intentId,proofId,actor])).rows[0];
  if(!row||row.nonce_hash!==sha256Hex(input.nonce as string))bad('RND_INTENT_FORBIDDEN','Intent binding does not match',403);
  const previous=(await tx.query<{capture_session_id:string;request_digest:string}>('SELECT * FROM rnd_session_starts WHERE intent_id=$1',[intentId])).rows[0];
  if(previous){if(previous.capture_session_id!==captureSessionId||previous.request_digest!==digest(input))bad('RND_NONCE_REPLAY','Intent has already been consumed for a different start',409);return {intentId,captureSessionId,state:'STARTED'};}
  if(new Date(row.expires_at).getTime()<=deps.clock.now().getTime())bad('RND_INTENT_EXPIRED','Intent expired before start',409);
  const intent=JSON.parse(row.canonical_json);
  let publicKey:string|null=null;
  if(input.clientPublicKeyPem!==undefined){
   if(typeof input.clientPublicKeyPem!=='string'||input.clientPublicKeyPem.length>4096||input.clientPublicKeyPem.includes('PRIVATE'))bad('RND_INVALID_CLIENT_KEY','Expected a public P-256 SPKI key');
   try {const parsed=createPublicKey(input.clientPublicKeyPem);if(parsed.asymmetricKeyType!=='ec'||parsed.asymmetricKeyDetails?.namedCurve!=='prime256v1')bad('RND_INVALID_CLIENT_KEY','Only P-256 session signing keys are supported');publicKey=parsed.export({type:'spki',format:'pem'}).toString();}catch{bad('RND_INVALID_CLIENT_KEY','Invalid P-256 session public key');}
  }
  const capture=(await tx.query<{created_at:Date|string;stage_id:string|null;state:string}>('SELECT created_at,stage_id,state FROM capture_sessions WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3',[captureSessionId,proofId,actor])).rows[0];
  if(!capture||(capture.stage_id??'OUTBOUND')!==intent.subject.legId||capture.state!=='ISSUED'||new Date(capture.created_at).getTime()<Date.parse(intent.issuedAt))bad('RND_CAPTURE_BINDING','Start requires a fresh, issued capture bound to this intent subject',409);
  await tx.query('INSERT INTO rnd_session_starts(intent_id,capture_session_id,request_digest,client_public_key_pem,created_at) VALUES($1,$2,$3,$4,$5)',[intentId,captureSessionId,digest(input),publicKey,deps.clock.now().toISOString()]);
  return {intentId,captureSessionId,state:'STARTED'};
 });
}
export async function closeIntent(deps:RndDeps,actor:string,proofId:string,intentId:string,key:unknown,input:unknown) {
 requireRnd(deps.rnd,'verifiedcapture','collection');onlyKeys(input,['evidenceIds','clientCanonicalJson','clientSignatureBase64']);
 if(deps.rnd?.profile===CAPTURE_RECEIPT_PROFILE&&(!Array.isArray(input.evidenceIds)||input.evidenceIds.length!==1))bad('RND_INVALID_SOURCES','A final-file receipt binds exactly one committed original recording');
 return idempotent(deps,proofId,actor,`close:${intentId}`,key,input,async tx=>{
  await requireConsent(tx,proofId,actor);
  const intent=(await tx.query<{canonical_json:string;acquisition_mode:string;digest:string}>('SELECT * FROM rnd_intents WHERE id=$1 AND proof_id=$2 AND actor_id=$3',[intentId,proofId,actor])).rows[0];
  if(!intent)bad('RND_INTENT_FORBIDDEN','Intent not available',403);
  const start=(await tx.query<{capture_session_id:string;client_public_key_pem:string|null}>('SELECT capture_session_id,client_public_key_pem FROM rnd_session_starts WHERE intent_id=$1',[intentId])).rows[0];
  if(!start)bad('RND_START_REQUIRED','A bound start declaration is required',409);
  const sources=await resolveSources(deps,tx,proofId,actor,input.evidenceIds);
  if(sources.some(s=>s.captureSessionId!==start.capture_session_id))bad('RND_SOURCE_REBIND','Every source must belong to the original capture session',409);
  let clientInventory:unknown=null;
  if(start.client_public_key_pem){
   if(typeof input.clientCanonicalJson!=='string'||typeof input.clientSignatureBase64!=='string'||input.clientSignatureBase64.length>1024)bad('RND_CLIENT_SIGNATURE_REQUIRED','The bound capture key must sign the final inventory');
   try{
    const value=parseStrictJson(input.clientCanonicalJson,32768) as Record<string,unknown>;
    if(canonicalize(value)!==input.clientCanonicalJson||value.schemaVersion!=='packproof.native-final-file.v1'||value.intentId!==intentId||value.proofId!==proofId||value.captureSessionId!==start.capture_session_id||value.chainCoverage!=='FINAL_FILE_ONLY'||sources.length!==1||value.mediaSha256!==sources[0].sha256||value.mediaByteLength!==sources[0].byteLength||!verify('sha256',Buffer.from(input.clientCanonicalJson),start.client_public_key_pem,Buffer.from(input.clientSignatureBase64,'base64')))bad('RND_CLIENT_SIGNATURE_INVALID','Client inventory signature or source binding is invalid');
    clientInventory={canonicalJson:input.clientCanonicalJson,signatureBase64:input.clientSignatureBase64,publicKeyPem:start.client_public_key_pem,keyProtection:'UNVERIFIED',sidecarStatus:'UNRECEIVED_SIDECAR_COMMITMENTS'};
   }catch{bad('RND_CLIENT_SIGNATURE_INVALID','Client inventory signature or source binding is invalid');}
  }else if(input.clientCanonicalJson!==undefined||input.clientSignatureBase64!==undefined)bad('RND_CLIENT_KEY_NOT_BOUND','Client key must be bound before recording');
  const platformAssurances=clientInventory&&deps.rnd?.profile!==CAPTURE_RECEIPT_PROFILE?(await tx.query<{canonical_json:string;digest:string;signature:unknown}>(`SELECT r.canonical_json,r.digest,r.signature FROM rnd_platform_results r JOIN rnd_platform_challenges c ON c.id=r.challenge_id WHERE c.intent_id=$1 AND c.actor_id=$2 AND c.purpose='CLOSE_INVENTORY' AND c.inventory_digest=$3 AND r.state='VALIDATED' ORDER BY r.created_at DESC`,[intentId,actor,sha256Hex(input.clientCanonicalJson as string)])).rows.map(r=>({canonicalJson:r.canonical_json,digest:r.digest,signature:r.signature})):[];
  const inventoryDigest=digest(sources),prior=(await tx.query<{canonical_json:string;digest:string;signature:unknown}>('SELECT * FROM rnd_session_receipts WHERE intent_id=$1',[intentId])).rows[0];
  if(prior){if(JSON.parse(prior.canonical_json).sourceInventoryDigest!==inventoryDigest)bad('RND_INVENTORY_SEALED','A sealed source inventory cannot be replaced',409);return {receipt:JSON.parse(prior.canonical_json),canonicalJson:prior.canonical_json,digest:prior.digest,signature:prior.signature};}
  const receipt={schemaVersion:'packproof.capture-receipt.v1',intentId,intentDigest:intent.digest,proofId,captureSessionId:start.capture_session_id,
   tenantId:sources[0].tenantId,subject:JSON.parse(intent.canonical_json).subject,sources,sourceInventoryDigest:inventoryDigest,clientInventory,platformAssurances,receivedAt:deps.clock.now().toISOString(),
   assurance:{acquisitionMode:intent.acquisition_mode,appAttestation:platformAssurances.length?'APP_REQUEST_VALIDATED':'UNSUPPORTED',keyProtection:'UNKNOWN',challengeFreshness:intent.acquisition_mode==='ONLINE'?'ONLINE_START_BOUND':'OFFLINE_NOT_FRESH',chainCoverage:'FINAL_FILE_ONLY',serverReceipt:'SIGNED_BYTES_RECEIVED',signatureVerification:clientInventory?'BOUND_CLIENT_AND_SERVER_SIGNATURES':'SERVER_SIGNATURE_ONLY',sensorAttestation:'UNSUPPORTED'},
   limitations:['Server start binding does not authenticate the photographed scene.',...(clientInventory?['Client signing key protection is unverified; sidecar commitments do not prove receipt of sidecar bytes.']:['Client media signature is unavailable in this profile.']),...(platformAssurances.length?['A validated app assertion binds the submitted inventory, not the camera sensor or physical scene.']:['Platform app assertions are unavailable in this profile.']),'No incremental camera byte chain is claimed.']};
  const record=await signedRecord(deps,proofId,intentId,receipt);
  await tx.query('INSERT INTO rnd_session_receipts(intent_id,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5)',[intentId,record.canonicalJson,record.digest,JSON.stringify(record.signature),receipt.receivedAt]);
  return {receipt,...record};
 });
}
export async function issueLiveChallenge(deps:RndDeps,actor:string,proofId:string,key:unknown,input:unknown) {
 requireRnd(deps.rnd,'prooflive','collection');onlyKeys(input,['intentId','mode']);
 const intentId=boundedId(input.intentId,'intent');
 if(input.mode!=='PASSIVE_LAB')bad('RND_SAFETY_PROFILE_UNQUALIFIED','Active illumination requires a completed device safety qualification; only passive laboratory challenges are enabled',409);
 return idempotent(deps,proofId,actor,'live-challenge',key,input,async tx=>{
  await requireConsent(tx,proofId,actor);
  const intent=(await tx.query<{canonical_json:string;acquisition_mode:string;expires_at:Date|string}>(`SELECT i.* FROM rnd_intents i JOIN rnd_session_starts s ON s.intent_id=i.id JOIN capture_sessions c ON c.id=s.capture_session_id WHERE i.id=$1 AND i.proof_id=$2 AND i.actor_id=$3 AND c.state='ISSUED'`,[intentId,proofId,actor])).rows[0];
  if(!intent||intent.acquisition_mode!=='ONLINE'||new Date(intent.expires_at).getTime()<=deps.clock.now().getTime())bad('RND_CHALLENGE_PRECONDITION','Fresh online recording intent is required',409);
  const count=(await tx.query<{n:string}>('SELECT count(*) AS n FROM rnd_live_challenges WHERE intent_id=$1',[intentId])).rows[0];
  if(Number(count.n)>=3)bad('RND_CHALLENGE_LIMIT','Challenge attempts are bounded per capture',429);
  const id=newId('rnd_live'),rawNonce=nonce(),issuedAtMs=deps.clock.now().getTime(),expiresAtMs=issuedAtMs+120_000;
  const challenge={schemaVersion:'packproof.live-challenge.v1',challengeId:id,intentId,proofId,subject:JSON.parse(intent.canonical_json).subject,nonce:rawNonce,nonceDigest:sha256Hex(rawNonce),issuedAtMs,expiresAtMs,mode:'PASSIVE_LAB',commands:[],activeIlluminationEnabled:false};
  const record=await signedRecord(deps,proofId,id,challenge);
  await tx.query('INSERT INTO rnd_live_challenges(id,intent_id,proof_id,actor_id,canonical_json,digest,signature,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,intentId,proofId,actor,record.canonicalJson,record.digest,JSON.stringify(record.signature),new Date(expiresAtMs).toISOString(),new Date(issuedAtMs).toISOString()]);
  return {challenge,...record};
 });
}
