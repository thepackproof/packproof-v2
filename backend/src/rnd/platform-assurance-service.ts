import { createHash, verify } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { canonicalize, parseStrictJson } from '../../../packages/evidence-contracts/contracts.mjs';
import { newId } from '../ids.js';
import { requireRnd } from './config.js';
import { authorized, bad, boundedId, digest, idempotent, nonce, onlyKeys, requireConsent, signedRecord } from './security.js';
import { createGooglePlayIntegrityDecoder, verifyAppAttestAssertion, verifyAppAttestAttestation, verifyPlayIntegrity, verifyAndroidKeyAttestationChain, type AppAttestKeyRecord, type PlatformAssuranceResult } from './platform-assurance.js';
import { assertAndroidKeyPolicy } from './android-key-policy.js';
import type { RndConfig, RndDeps } from './types.js';

type PlatformConfiguration = NonNullable<RndConfig['platform']>;
type ChallengeRow = { id:string;intent_id:string;proof_id:string;actor_id:string;tenant_id:string;purpose:'REGISTER_KEY'|'CLOSE_INVENTORY';inventory_digest:string|null;expected_hash:string;created_at:string|Date;expires_at:string|Date; };
type ResultRow = { canonical_json:string;digest:string;signature:unknown;request_digest:string; };
const fromRow = (row:ResultRow) => ({ assurance:JSON.parse(row.canonical_json),canonicalJson:row.canonical_json,digest:row.digest,signature:row.signature });

function privateFile(path:string,maximum:number,secret=false) {
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>maximum||secret&&process.platform!=='win32'&&(info.mode&0o077)!==0)throw new Error('R&D platform configuration must be a bounded regular file; tokens require owner-only permissions');
  return readFileSync(path,'utf8');
}
/** Server-only configuration. No roots, app identity or OAuth token are accepted from clients. */
export function loadPlatformAssuranceConfig(env:NodeJS.ProcessEnv=process.env):PlatformConfiguration|undefined {
  if(!env.PACKPROOF_RND_PLATFORM_POLICY_FILE)return undefined;
  if(env.PACKPROOF_ENV!=='research'||env.PACKPROOF_RND_ENABLED!=='1')throw new Error('Platform assurance policy requires explicit isolated research mode');
  const document=parseStrictJson(privateFile(env.PACKPROOF_RND_PLATFORM_POLICY_FILE,262144)) as Record<string,any>;
  if(document.schemaVersion!=='packproof.platform-policy.v1')throw new Error('Unsupported R&D platform policy');
  const config:PlatformConfiguration={};
  if(document.apple){
    const policy=document.apple;
    if(typeof policy.appId!=='string'||!policy.appId.endsWith('.com.packproof.mobile.research')||policy.environment!=='development'||typeof policy.trustPolicyId!=='string'||!Array.isArray(policy.trustedRootCertificatesPem)||policy.trustedRootCertificatesPem.length>8||!policy.trustedRootCertificatesPem.every((v:unknown)=>typeof v==='string')||!Number.isSafeInteger(policy.trustPolicyExpiresAt)||!Array.isArray(policy.allowedValidationCategories)||policy.allowedValidationCategories.some((v:unknown)=>v!==3)||!Array.isArray(policy.allowedBundleVersions)||!policy.allowedBundleVersions.every((v:unknown)=>typeof v==='string'))throw new Error('Invalid development App Attest policy');
    config.apple={appId:policy.appId,environment:'development',trustedRootCertificatesPem:policy.trustedRootCertificatesPem,trustPolicyId:policy.trustPolicyId,trustPolicyExpiresAt:policy.trustPolicyExpiresAt,allowedValidationCategories:policy.allowedValidationCategories,allowedBundleVersions:policy.allowedBundleVersions,allowLegacyWithoutExtensions:policy.allowLegacyWithoutExtensions===true,revokedKeyIds:Array.isArray(policy.revokedKeyIds)?policy.revokedKeyIds:[]};
  }
  if(document.android){
    const policy=document.android;
    if(policy.packageName!=='com.packproof.mobile.research'||!Array.isArray(policy.certificateSha256Digests)||!policy.certificateSha256Digests.every((v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v))||typeof policy.minimumVersionCode!=='string'||!Array.isArray(policy.requiredDeviceVerdicts)||!policy.requiredDeviceVerdicts.every((v:unknown)=>typeof v==='string')||typeof policy.requireLicensed!=='boolean'||!Number.isSafeInteger(policy.maxTokenAgeMs))throw new Error('Invalid development Play Integrity policy');
    config.android={packageName:policy.packageName,certificateSha256Digests:policy.certificateSha256Digests,minimumVersionCode:policy.minimumVersionCode,requiredDeviceVerdicts:policy.requiredDeviceVerdicts,requireLicensed:policy.requireLicensed,maxTokenAgeMs:policy.maxTokenAgeMs};
    if(env.PACKPROOF_RND_GOOGLE_ACCESS_TOKEN_FILE){
      const tokenFile=env.PACKPROOF_RND_GOOGLE_ACCESS_TOKEN_FILE;
      config.android.decodeToken=createGooglePlayIntegrityDecoder({packageName:policy.packageName,getAccessToken:async()=>privateFile(tokenFile,8192,true).trim()});
    }
  }
  if(document.androidKey){
    const policy=document.androidKey;
    if(typeof policy.trustPolicyId!=='string'||!policy.trustPolicyId||!Array.isArray(policy.trustedRootCertificatesPem)||policy.trustedRootCertificatesPem.length>8||!policy.trustedRootCertificatesPem.every((v:unknown)=>typeof v==='string')||!Number.isSafeInteger(policy.trustPolicyExpiresAt)||!Number.isSafeInteger(policy.revocationValidUntil)||!policy.revocationEntries||typeof policy.revocationEntries!=='object'||Array.isArray(policy.revocationEntries)||Object.entries(policy.revocationEntries).some(([serial,value]:[string,any])=>!/^[a-fA-F0-9]{1,64}$/.test(serial)||!value||typeof value.status!=='string')||policy.authorization?.packageName!=='com.packproof.mobile.research')throw new Error('Invalid research Android key policy');
    assertAndroidKeyPolicy(policy.authorization);
    config.androidKey={trustedRootCertificatesPem:policy.trustedRootCertificatesPem,trustPolicyId:policy.trustPolicyId,trustPolicyExpiresAt:policy.trustPolicyExpiresAt,revocationEntries:policy.revocationEntries,revocationValidUntil:policy.revocationValidUntil,authorization:policy.authorization};
  }
  return config;
}

export async function issuePlatformChallenge(deps:RndDeps,actor:string,proofId:string,key:unknown,input:unknown) {
  requireRnd(deps.rnd,'verifiedcapture','collection');onlyKeys(input,['intentId','purpose','inventoryDigest']);
  const intentId=boundedId(input.intentId,'intent');
  if(!['REGISTER_KEY','CLOSE_INVENTORY'].includes(String(input.purpose)))bad('RND_PLATFORM_PURPOSE','Unsupported platform assertion purpose');
  const purpose=String(input.purpose);
  const inventoryDigest=purpose==='CLOSE_INVENTORY'?String(input.inventoryDigest??''):null;
  if(purpose==='CLOSE_INVENTORY'&&!/^[a-f0-9]{64}$/.test(inventoryDigest!)||purpose==='REGISTER_KEY'&&input.inventoryDigest!==undefined)bad('RND_PLATFORM_INVENTORY','Close assertions must bind the exact client canonical inventory digest');
  return idempotent(deps,proofId,actor,'platform-challenge',key,input,async tx=>{
    await requireConsent(tx,proofId,actor);
    const intent=(await tx.query<{tenant_id:string;acquisition_mode:string;canonical_json:string}>('SELECT * FROM rnd_intents WHERE id=$1 AND proof_id=$2 AND actor_id=$3',[intentId,proofId,actor])).rows[0];
    if(!intent)bad('RND_INTENT_FORBIDDEN','Intent is not available to this actor',403);
    if(intent.acquisition_mode!=='ONLINE')bad('RND_OFFLINE_NOT_FRESH','Offline capture cannot obtain online platform freshness',409);
    if((await tx.query('SELECT 1 FROM rnd_session_receipts WHERE intent_id=$1',[intentId])).rows.length)bad('RND_PLATFORM_RECEIPT_SEALED','Platform assertion must precede capture receipt sealing',409);
    if(purpose==='CLOSE_INVENTORY'&&!(await tx.query('SELECT 1 FROM rnd_session_starts WHERE intent_id=$1',[intentId])).rows.length)bad('RND_START_REQUIRED','Inventory assertion requires a bound capture start',409);
    const count=(await tx.query<{n:string}>('SELECT count(*) AS n FROM rnd_platform_challenges WHERE intent_id=$1 AND purpose=$2',[intentId,purpose])).rows[0];
    if(Number(count?.n??0)>=8)bad('RND_PLATFORM_ATTEMPT_LIMIT','Platform challenge limit reached',429);
    const id=newId('rnd_platform'),issuedAt=deps.clock.now().getTime(),expiresAt=issuedAt+120_000;
    const challenge={schemaVersion:'packproof.platform-challenge.v1',challengeId:id,intentId,proofId,actorId:actor,tenantId:intent.tenant_id,subject:JSON.parse(intent.canonical_json).subject,purpose,inventoryDigest,nonce:nonce(),issuedAt,expiresAt};
    const record=await signedRecord(deps,proofId,id,challenge),hash=createHash('sha256').update(record.canonicalJson).digest();
    await tx.query('INSERT INTO rnd_platform_challenges(id,intent_id,proof_id,actor_id,tenant_id,purpose,inventory_digest,expected_hash,canonical_json,digest,signature,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[id,intentId,proofId,actor,intent.tenant_id,purpose,inventoryDigest,hash.toString('hex'),record.canonicalJson,record.digest,JSON.stringify(record.signature),new Date(issuedAt).toISOString(),new Date(expiresAt).toISOString()]);
    return {challenge,...record,expectedClientDataHash:hash.toString('base64'),requestHash:hash.toString('base64url')};
  });
}

export async function verifyPlatformChallenge(deps:RndDeps,actor:string,proofId:string,challengeId:string,key:unknown,input:unknown) {
  requireRnd(deps.rnd,'verifiedcapture','collection');onlyKeys(input,['platform','token','keyId','attestationObjectBase64','assertionObjectBase64','certificateChainBase64','publicKeyPem','clientCanonicalJson','inventorySignatureBase64']);
  if(!['android','ios'].includes(String(input.platform)))bad('RND_PLATFORM_UNSUPPORTED','Supported assertion platforms are Android and iOS');
  const platform=String(input.platform),requestDigest=digest(input);
  for(const [name,value] of Object.entries(input)){
    if(name==='certificateChainBase64'){if(!Array.isArray(value)||value.length<1||value.length>5||value.some(v=>typeof v!=='string'||v.length>22000))bad('RND_PLATFORM_INPUT','Certificate chain must contain one to five bounded certificates');}
    else if(typeof value!=='string'||value.length>90000)bad('RND_PLATFORM_INPUT','Platform evidence must be bounded strings');
  }
  const keyAttestation=input.certificateChainBase64!==undefined;
  if(platform==='ios'&&['certificateChainBase64','publicKeyPem','clientCanonicalJson','inventorySignatureBase64'].some(field=>input[field]!==undefined)||platform==='android'&&[input.keyId,input.attestationObjectBase64,input.assertionObjectBase64].some(v=>v!==undefined)||platform==='android'&&(keyAttestation?input.token!==undefined:['publicKeyPem','clientCanonicalJson','inventorySignatureBase64'].some(field=>input[field]!==undefined)))bad('RND_PLATFORM_INPUT','Platform evidence types cannot be mixed');
  await authorized(deps.db,proofId,actor);await requireConsent(deps.db,proofId,actor);
  const challenge=(await deps.db.query<ChallengeRow>('SELECT * FROM rnd_platform_challenges WHERE id=$1 AND proof_id=$2 AND actor_id=$3',[challengeId,proofId,actor])).rows[0];
  if(!challenge)bad('RND_PLATFORM_CHALLENGE_FORBIDDEN','Platform challenge unavailable',403);
  const prior=(await deps.db.query<ResultRow>('SELECT * FROM rnd_platform_results WHERE challenge_id=$1',[challengeId])).rows[0];
  if(prior&&prior.request_digest!==requestDigest)bad('RND_PLATFORM_CHALLENGE_CONSUMED','Challenge is already consumed by different evidence',409);
  const issued=()=>({now:deps.clock.now().getTime(),challengeIssuedAt:new Date(challenge.created_at).getTime(),challengeExpiresAt:new Date(challenge.expires_at).getTime()});
  // The Google call is bounded and happens outside the proof transaction lock.
  const androidResult=!prior&&platform==='android'&&!keyAttestation?await verifyPlayIntegrity({...issued(),token:String(input.token??''),expectedRequestHash:Buffer.from(challenge.expected_hash,'hex').toString('base64url')},deps.rnd?.platform?.android):null;
  return idempotent(deps,proofId,actor,`platform-verify:${challengeId}`,key,input,async tx=>{
    await requireConsent(tx,proofId,actor);
    const committed=(await tx.query<ResultRow>('SELECT * FROM rnd_platform_results WHERE challenge_id=$1',[challengeId])).rows[0];
    if(committed){if(committed.request_digest!==requestDigest)bad('RND_PLATFORM_CHALLENGE_CONSUMED','Challenge already contains different evidence',409);return fromRow(committed);}
    if((await tx.query('SELECT 1 FROM rnd_session_receipts WHERE intent_id=$1',[challenge.intent_id])).rows.length)bad('RND_PLATFORM_RECEIPT_SEALED','Capture receipt already sealed',409);
    let verification:PlatformAssuranceResult;
    const current=issued();
    if(current.now<current.challengeIssuedAt||current.now>=current.challengeExpiresAt)verification={state:'INVALID',reasonCodes:['CHALLENGE_EXPIRED_OR_NOT_YET_VALID'],components:{},limitations:['Expired challenges cannot supply fresh app assurance.']};
    else if(platform==='android'){
      if(keyAttestation){
        if(challenge.purpose!=='CLOSE_INVENTORY'||typeof input.publicKeyPem!=='string'||input.publicKeyPem.length>2048||typeof input.clientCanonicalJson!=='string'||typeof input.inventorySignatureBase64!=='string')bad('RND_PLATFORM_INPUT','Key attestation requires the inventory challenge, public key and signed canonical inventory');
        let bound=false,signatureValid=false;
        try{
          bound=canonicalize(parseStrictJson(input.clientCanonicalJson))===input.clientCanonicalJson&&createHash('sha256').update(input.clientCanonicalJson).digest('hex')===challenge.inventory_digest;
          const signature=Buffer.from(input.inventorySignatureBase64,'base64');
          signatureValid=signature.length>=64&&signature.length<=80&&signature.toString('base64')===input.inventorySignatureBase64&&verify('sha256',Buffer.from(input.clientCanonicalJson),{key:input.publicKeyPem,dsaEncoding:'der'},signature);
        }catch{/* Malformed keys, canonical input and signatures are rejected below. */}
        if(!bound||!signatureValid)verification={state:'INVALID',reasonCodes:[!bound?'ANDROID_INVENTORY_BINDING_MISMATCH':'ANDROID_INVENTORY_SIGNATURE_INVALID'],components:{},limitations:['A fresh challenged key must sign the exact capture inventory.']};
        else{
          verification=await verifyAndroidKeyAttestationChain({certificatesBase64:input.certificateChainBase64 as string[],now:current.now,expectedChallenge:Buffer.from(challenge.expected_hash,'hex'),expectedPublicKeyPem:input.publicKeyPem},deps.rnd?.platform?.androidKey);
          verification.components={...verification.components,keyRole:'ATTESTATION_REQUEST_KEY',inventorySignature:verification.state==='VALIDATED'?'VALIDATED':'NOT_TRUSTED',recordingSessionKeyProtection:'NOT_CHECKED'};
          verification.limitations.push('The dedicated request key is separate from the recording-session signing key; this result does not upgrade that session key.');
        }
      }else verification=androidResult!;
    }else{
      const apple=deps.rnd?.platform?.apple?{...deps.rnd.platform.apple,now:current.now}:undefined;
      const keyId=String(input.keyId??'');
      if(!/^[A-Za-z0-9+/]{43}=$/.test(keyId)||input.token!==undefined)bad('RND_PLATFORM_INPUT','App Attest requires a valid key ID and CBOR evidence');
      if(challenge.purpose==='REGISTER_KEY'){
        if(typeof input.attestationObjectBase64!=='string'||input.assertionObjectBase64!==undefined)bad('RND_PLATFORM_INPUT','Key registration requires one attestation object');
        {
          const registered=await verifyAppAttestAttestation({...current,objectBase64:input.attestationObjectBase64,keyId,expectedClientDataHash:Buffer.from(challenge.expected_hash,'hex')},apple);
          verification=registered;
          if(registered.state==='VALIDATED'&&registered.registeredKey){
            const inserted=await tx.query('INSERT INTO rnd_platform_keys(key_id,actor_id,registered_challenge_id,key_json,receipt_base64,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(key_id) DO NOTHING RETURNING key_id',[keyId,actor,challengeId,JSON.stringify(registered.registeredKey),registered.receiptBase64??'',deps.clock.now().toISOString()]);
            if(!inserted.rowCount)verification={state:'INVALID',reasonCodes:['APP_ATTEST_KEY_ALREADY_REGISTERED'],components:{},limitations:['A key cannot be reassigned or reset by attesting it again.']};
            else await tx.query('INSERT INTO rnd_platform_key_counters(key_id,counter) VALUES($1,0)',[keyId]);
          }
        }
      }else{
        if(typeof input.assertionObjectBase64!=='string'||input.attestationObjectBase64!==undefined)bad('RND_PLATFORM_INPUT','Inventory assurance requires one assertion object');
        const registration=(await tx.query<{key_json:AppAttestKeyRecord;counter:string}>('SELECT k.key_json,c.counter FROM rnd_platform_keys k JOIN rnd_platform_key_counters c ON c.key_id=k.key_id WHERE k.key_id=$1 AND k.actor_id=$2 FOR UPDATE OF c',[keyId,actor])).rows[0];
        if(!registration)verification={state:'UNSUPPORTED',reasonCodes:['APP_ATTEST_REGISTERED_KEY_UNAVAILABLE'],components:{},limitations:['Only an attested key registered to this actor may validate an assertion.']};
        else verification=await verifyAppAttestAssertion({...current,objectBase64:input.assertionObjectBase64,expectedClientDataHash:Buffer.from(challenge.expected_hash,'hex'),key:{...registration.key_json,counter:Number(registration.counter)}},apple,async(previous,next)=>(await tx.query('UPDATE rnd_platform_key_counters SET counter=$3 WHERE key_id=$1 AND counter=$2',[keyId,previous,next])).rowCount===1);
      }
    }
    const id=newId('rnd_assurance');
    // Receipt contains public evidence only. Never persist an OAuth credential or opaque Google token.
    const assurance={schemaVersion:'packproof.platform-assurance.v1',id,challengeId,intentId:challenge.intent_id,proofId,actorId:actor,tenantId:challenge.tenant_id,purpose:challenge.purpose,inventoryDigest:challenge.inventory_digest,requestHash:challenge.expected_hash,platform,state:verification.state,reasonCodes:verification.reasonCodes,components:verification.components,limitations:verification.limitations,verifiedAt:deps.clock.now().toISOString()};
    const record=await signedRecord(deps,proofId,id,assurance);
    await tx.query('INSERT INTO rnd_platform_results(challenge_id,proof_id,actor_id,tenant_id,platform,state,request_digest,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[challengeId,proofId,actor,challenge.tenant_id,platform,verification.state,requestDigest,record.canonicalJson,record.digest,JSON.stringify(record.signature),assurance.verifiedAt]);
    return {assurance,...record};
  });
}

const route=(fn:(r:Request,s:Response)=>Promise<unknown>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(n);};
export function rndPlatformRouter(deps:RndDeps) {
  const router=Router(),base='/proofs/:id/rnd/platform-challenges';
  const actor=(r:Request)=>r.packproofUserId??bad('UNAUTHENTICATED','Authentication required',401);
  router.use(base,(_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
  router.post(base,route(async(r,s)=>s.status(201).json(await issuePlatformChallenge(deps,actor(r),r.params.id,r.header('Idempotency-Key'),r.body))));
  router.post(`${base}/:challengeId/verify`,route(async(r,s)=>s.json(await verifyPlatformChallenge(deps,actor(r),r.params.id,r.params.challengeId,r.header('Idempotency-Key'),r.body))));
  return router;
}
