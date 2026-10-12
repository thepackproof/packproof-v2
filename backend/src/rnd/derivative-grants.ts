import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router,type Request,type Response,type NextFunction } from 'express';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { loadProof } from '../domain/proof-access.js';
import { requireRnd } from './config.js';
import { artifactFor,exportDerivativeZip } from './exports.js';
import { authorized,bad,boundedId,digest,onlyKeys,requireConsent,signedRecord } from './security.js';
import type { RndDeps } from './types.js';

type GrantRow={id:string;proof_id:string;analysis_id:string;actor_id:string;tenant_id:string;request_digest:string;artifact_sha256:string;recipe_sha256:string;review_id:string;review_digest:string;canonical_json:string;digest:string;signature:unknown;expires_at:Date|string};
type ReviewRow={id:string;approved:boolean;recipe_sha256:string;digest:string};
const tokenPattern=/^rndg_[A-Za-z0-9_-]{43}$/;
const unavailable=()=>bad('RND_GRANT_UNAVAILABLE','This research derivative grant is unavailable',404);
const unpack=(row:GrantRow)=>({grant:JSON.parse(row.canonical_json) as Record<string,unknown>,canonicalJson:row.canonical_json,digest:row.digest,signature:row.signature});
function enabled(deps:RndDeps){requireRnd(deps.rnd,'proofshield','collection');requireRnd(deps.rnd,'proofshield','internalDisplay');}
async function latestReview(deps:RndDeps,analysisId:string,artifactSha:string){return (await deps.db.query<ReviewRow>('SELECT id,approved,recipe_sha256,digest FROM rnd_derivative_reviews WHERE analysis_id=$1 AND artifact_sha256=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[analysisId,artifactSha])).rows[0];}
async function event(deps:RndDeps,row:Pick<GrantRow,'id'|'proof_id'>,kind:string,actorId:string|null){
 const id=newId('rnd_grant_event'),createdAt=deps.clock.now().toISOString(),record={schemaVersion:'packproof.derivative-grant-event.v1',id,grantId:row.id,kind,actorId,createdAt};
 const wrapper=await signedRecord(deps,row.proof_id,id,record);
 await deps.db.query('INSERT INTO rnd_derivative_grant_events(id,grant_id,actor_id,kind,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,row.id,actorId,kind,wrapper.canonicalJson,wrapper.digest,JSON.stringify(wrapper.signature),createdAt]);
 return {event:record,...wrapper};
}
async function active(deps:RndDeps,row:GrantRow){
 enabled(deps);
 if(new Date(row.expires_at).getTime()<=deps.clock.now().getTime()||(await deps.db.query("SELECT 1 FROM rnd_derivative_grant_events WHERE grant_id=$1 AND kind='REVOKED'",[row.id])).rows.length)unavailable();
 // A bearer grant never outlives its issuer's access, research consent, or exact review.
 await authorized(deps.db,row.proof_id,row.actor_id);await requireConsent(deps.db,row.proof_id,row.actor_id);
 const review=await latestReview(deps,row.analysis_id,row.artifact_sha256);
 if(!review?.approved||review.id!==row.review_id||review.digest!==row.review_digest||review.recipe_sha256!==row.recipe_sha256)unavailable();
}
export async function createDerivativeGrant(deps:RndDeps,actor:string,proofId:string,analysisId:string,key:unknown,input:unknown){
 enabled(deps);onlyKeys(input,['artifactSha256','recipeSha256','expiresInSeconds']);
 if(typeof input.artifactSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.artifactSha256)||typeof input.recipeSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.recipeSha256)||!Number.isSafeInteger(input.expiresInSeconds)||Number(input.expiresInSeconds)<60||Number(input.expiresInSeconds)>86400)bad('RND_INVALID_GRANT','Bind exact artifact/recipe and expiry between 60 seconds and one day');
 const requestKey=sha256Hex(boundedId(key,'Idempotency-Key')),requestDigest=digest({analysisId,...input});
 return deps.db.transaction(async tx=>{
  const scoped={...deps,db:tx};await loadProof(tx,proofId,true);
  const ownership=await authorized(tx,proofId,actor);await requireConsent(tx,proofId,actor);
  const prior=(await tx.query<GrantRow>('SELECT * FROM rnd_derivative_grants WHERE proof_id=$1 AND actor_id=$2 AND request_key_hash=$3',[proofId,actor,requestKey])).rows[0];
  // Do not cache bearer material in the generic idempotency table. Delivery is once.
  if(prior){if(prior.request_digest!==requestDigest)bad('RND_IDEMPOTENCY_CONFLICT','Grant request key already used for different scope',409);return {...unpack(prior),token:null,tokenDelivery:'ALREADY_ISSUED_CREATE_NEW_GRANT' as const};}
  const {row,artifact}=await artifactFor(scoped,actor,proofId,analysisId,0);
  const record=(row.result_json?.details as {observations?:{record?:Record<string,unknown>}[]})?.observations?.[0]?.record;
  if(row.feature!=='proofshield'||artifact.sha256!==input.artifactSha256||record?.derivativeSha256!==input.artifactSha256||record?.recipeSha256!==input.recipeSha256)bad('RND_GRANT_SCOPE','Grant must bind the exact committed privacy derivative',409);
  const review=await latestReview(scoped,analysisId,String(input.artifactSha256));
  if(!review?.approved||review.recipe_sha256!==input.recipeSha256)bad('RND_PRIVACY_REVIEW_REQUIRED','Approve the exact derivative and recipe before granting access',409);
  const count=(await tx.query<{count:number}>('SELECT COUNT(*)::int AS count FROM rnd_derivative_grants WHERE proof_id=$1 AND actor_id=$2 AND expires_at>$3',[proofId,actor,deps.clock.now().toISOString()])).rows[0].count;
  if(count>=128)bad('RND_GRANT_LIMIT','At most 128 unexpired research grants are allowed per issuer and Proof',429);
  const id=newId('rnd_grant'),token=`rndg_${randomBytes(32).toString('base64url')}`,createdAt=deps.clock.now().toISOString(),expiresAt=new Date(deps.clock.now().getTime()+Number(input.expiresInSeconds)*1000).toISOString();
  const grant={schemaVersion:'packproof.derivative-grant.v1',id,proofId,analysisId,issuerId:actor,scope:'REVIEWED_DERIVATIVE_ZIP_ONLY',artifactSha256:input.artifactSha256,recipeSha256:input.recipeSha256,reviewDigest:review.digest,createdAt,expiresAt,limitations:['Research derivative only; original evidence and source-dependent findings are omitted.','Bearer access expires and can be revoked; downloaded archives cannot be recalled.']};
  const wrapper=await signedRecord(scoped,proofId,id,grant);
  await tx.query('INSERT INTO rnd_derivative_grants(id,proof_id,analysis_id,actor_id,tenant_id,token_hash,request_key_hash,request_digest,artifact_sha256,recipe_sha256,review_id,review_digest,canonical_json,digest,signature,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[id,proofId,analysisId,actor,ownership.tenantId,sha256Hex(token),requestKey,requestDigest,input.artifactSha256,input.recipeSha256,review.id,review.digest,wrapper.canonicalJson,wrapper.digest,JSON.stringify(wrapper.signature),expiresAt,createdAt]);
  await event(scoped,{id,proof_id:proofId},'CREATED',actor);
  return {grant,...wrapper,token,tokenDelivery:'ONCE' as const};
 });
}
export async function listDerivativeGrants(deps:RndDeps,actor:string,proofId:string,analysisId:string){
 enabled(deps);await authorized(deps.db,proofId,actor);
 const rows=(await deps.db.query<GrantRow>('SELECT * FROM rnd_derivative_grants WHERE proof_id=$1 AND analysis_id=$2 ORDER BY created_at,id',[proofId,analysisId])).rows;
 const grants=[];
 for(const row of rows){const audit=(await deps.db.query<{canonical_json:string;digest:string;signature:unknown}>('SELECT canonical_json,digest,signature FROM rnd_derivative_grant_events WHERE grant_id=$1 ORDER BY created_at,id',[row.id])).rows.map(e=>({canonicalJson:e.canonical_json,digest:e.digest,signature:e.signature}));grants.push({...unpack(row),expired:new Date(row.expires_at).getTime()<=deps.clock.now().getTime(),revoked:audit.some(e=>JSON.parse(e.canonicalJson).kind==='REVOKED'),audit});}
 return {grants};
}
export async function revokeDerivativeGrant(deps:RndDeps,actor:string,proofId:string,grantId:string){
 // Revocation only restricts existing access and remains available during a kill
 // switch. It cannot create/redeem grants or enable a non-research environment.
 if(!deps.rnd||!['research','test'].includes(deps.rnd.environment))bad('RND_DISABLED','This experimental capability is disabled',404);
 return deps.db.transaction(async tx=>{
  await loadProof(tx,proofId,true);await authorized(tx,proofId,actor);
  const row=(await tx.query<GrantRow>('SELECT * FROM rnd_derivative_grants WHERE id=$1 AND proof_id=$2',[grantId,proofId])).rows[0];if(!row)unavailable();
  const prior=(await tx.query<{canonical_json:string;digest:string;signature:unknown}>("SELECT canonical_json,digest,signature FROM rnd_derivative_grant_events WHERE grant_id=$1 AND kind='REVOKED'",[grantId])).rows[0];
  if(prior)return {event:JSON.parse(prior.canonical_json),canonicalJson:prior.canonical_json,digest:prior.digest,signature:prior.signature};
  return event({...deps,db:tx},row,'REVOKED',actor);
 });
}
export async function redeemDerivativeGrant(deps:RndDeps,input:unknown){
 enabled(deps);onlyKeys(input,['token']);
 if(typeof input.token!=='string'||!tokenPattern.test(input.token))unavailable();
 const row=(await deps.db.query<GrantRow>('SELECT * FROM rnd_derivative_grants WHERE token_hash=$1',[sha256Hex(input.token as string)])).rows[0];if(!row)unavailable();
 await active(deps,row);
 const zip=await exportDerivativeZip(deps,row.actor_id,row.proof_id,row.analysis_id);
 await event(deps,row,'REDEEM_STARTED',null);
 return Readable.from((async function*(){let completed=false;try{for await(const raw of zip){const chunk=Buffer.from(raw);for(let offset=0;offset<chunk.length;offset+=65536){await active(deps,row);yield chunk.subarray(offset,offset+65536);}}completed=true;}finally{zip.destroy();await event(deps,row,completed?'REDEEM_COMPLETED':'REDEEM_ABORTED',null);}})(),{objectMode:false,highWaterMark:1});
}
const route=(fn:(r:Request,s:Response)=>Promise<unknown>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(n);};
const actor=(r:Request)=>r.packproofUserId??bad('UNAUTHENTICATED','Authentication required',401);
export function rndDerivativeGrantRouter(deps:RndDeps){
 const router=Router(),base='/proofs/:id/rnd';
 router.use(base,(_,s,n)=>{s.set('Cache-Control','private, no-store');n();});
 router.post(`${base}/analyses/:analysisId/grants`,route(async(r,s)=>s.status(201).json(await createDerivativeGrant(deps,actor(r),r.params.id,r.params.analysisId,r.header('Idempotency-Key'),r.body))));
 router.get(`${base}/analyses/:analysisId/grants`,route(async(r,s)=>s.json(await listDerivativeGrants(deps,actor(r),r.params.id,r.params.analysisId))));
 router.post(`${base}/derivative-grants/:grantId/revoke`,route(async(r,s)=>{onlyKeys(r.body,[]);s.json(await revokeDerivativeGrant(deps,actor(r),r.params.id,r.params.grantId));}));return router;
}
export function rndDerivativeGrantPublicRouter(deps:RndDeps){
 const router=Router();router.post('/rnd/derivative-grants/redeem',route(async(r,s)=>{
  s.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  const zip=await redeemDerivativeGrant(deps,r.body);s.type('application/zip').set('Content-Disposition','attachment; filename="packproof-redacted.zip"');await pipeline(zip,s);
 }));return router;
}
