import {createHmac,timingSafeEqual} from 'node:crypto';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {authorizePartnerProof,auditOrganization,strictBody,type PartnerActor} from './organizations.js';

interface BindingKey {account:string;resource:string;external:string}
interface Cursor {
 v:1;query:'external-bindings';tenant:string;merchant:string;environment:string;
 principal:string;credential:string;delegation:string|null;proof:string;
 after:BindingKey;expires:number;
}
export interface BindingPageConfig {signingKey:string;cursorLifetimeMs?:number}
interface BindingRow {
 integration_account_id:string;resource_type:string;external_id:string;created_at:string|Date;
}
const invalid=()=>new DomainError('INVALID_CURSOR','Use a cursor from this authorized Proof binding listing',400);
const resourceTypes=['ORDER','PAYMENT','SHIPMENT','RETURN','CLAIM'];
function validKey(key:unknown):key is BindingKey {
 if(!key||typeof key!=='object'||Array.isArray(key))return false;
 const k=key as BindingKey;
 return typeof k.account==='string'&&k.account.length>0&&k.account.length<=200&&
  typeof k.external==='string'&&k.external.length>0&&k.external.length<=200&&resourceTypes.includes(k.resource);
}
/** Live immutable-key pagination, not a materialized snapshot. On a binding
 * change event consumers restart from the beginning, then continue the feed.
 * New lower-sorting keys may arrive between pages; no stable-page claim is made. */
export async function listPartnerBindings(db:Database,clock:Clock,actor:PartnerActor,proofId:string,
 config:BindingPageConfig,input:unknown={}) {
 await authorizePartnerProof(db,clock,actor,proofId,'proofs:read');
 const query=strictBody(input,['after','limit']);
 const limit=query.limit===undefined?50:
  typeof query.limit==='number'?query.limit:
  typeof query.limit==='string'&&/^\d{1,3}$/.test(query.limit)?Number(query.limit):NaN;
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('INVALID_LIMIT','limit must be an integer from 1 to 100',400);
 const key=Buffer.from(config.signingKey,'base64');
 if(key.length!==32)throw new DomainError('CURSOR_SIGNING_UNAVAILABLE','Cursor signing is not configured',503);
 const mac=(payload:string)=>createHmac('sha256',key).update('external-bindings/v1:'+payload).digest();
 const lifetime=config.cursorLifetimeMs??900000;
 if(!Number.isSafeInteger(lifetime)||lifetime<1||lifetime>3600000)throw new DomainError('CURSOR_SIGNING_UNAVAILABLE','Binding cursor lifetime is invalid',503);
 let after:BindingKey|null=null,expires=clock.now().getTime()+lifetime;
 if(query.after!==undefined){
  if(typeof query.after!=='string'||query.after.length>8192)throw invalid();
  const parts=query.after.split('.');
  if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))throw invalid();
  const signature=Buffer.from(parts[1],'base64url'),expected=mac(parts[0]);
  if(signature.length!==expected.length||!timingSafeEqual(signature,expected))throw invalid();
  let cursor:Cursor;
  try{cursor=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw invalid();}
  if(!cursor||cursor.v!==1||cursor.query!=='external-bindings'||cursor.tenant!==actor.tenantId||
   cursor.merchant!==actor.merchantId||cursor.environment!==actor.environment||cursor.principal!==actor.principalId||
   cursor.credential!==actor.credentialId||cursor.delegation!==actor.delegationGrantId||cursor.proof!==proofId||
   !validKey(cursor.after)||!Number.isSafeInteger(cursor.expires))throw invalid();
  if(cursor.expires<=clock.now().getTime())throw new DomainError('BINDING_CURSOR_EXPIRED','Restart the current binding listing and reconcile change event IDs',410);
  after=cursor.after;expires=cursor.expires;
 }
 const rows=(await db.query<BindingRow>(`
  SELECT integration_account_id,resource_type,external_id,created_at FROM platform_external_bindings
  WHERE merchant_id=$1 AND environment=$2 AND proof_id=$3
   AND ($4::text IS NULL OR (integration_account_id,resource_type,external_id)>($4,$5,$6))
  ORDER BY integration_account_id,resource_type,external_id LIMIT $7`,
  [actor.merchantId,actor.environment,proofId,after?.account??null,after?.resource??null,after?.external??null,limit+1])).rows;
 const page=rows.slice(0,limit),hasMore=rows.length>limit;
 let nextCursor:string|null=null;
 if(hasMore){
  const last=page[page.length-1];
  const cursor:Cursor={v:1,query:'external-bindings',tenant:actor.tenantId,merchant:actor.merchantId,
   environment:actor.environment,principal:actor.principalId,credential:actor.credentialId,
   delegation:actor.delegationGrantId,proof:proofId,expires,
   after:{account:last.integration_account_id,resource:last.resource_type,external:last.external_id}};
  const payload=Buffer.from(JSON.stringify(cursor)).toString('base64url');
  nextCursor=payload+'.'+mac(payload).toString('base64url');
 }
 // Recheck immediately before returning frozen identity rows; a successful
 // earlier page never grants continuing access after credential/grant revocation.
 await authorizePartnerProof(db,clock,actor,proofId,'proofs:read');
 await auditOrganization(db,clock,{actor,requestId:actor.requestId,operation:'PROOF_BINDINGS_READ',resourceId:proofId});
 return {schema:'packproof.external-bindings/v1',proofId,
  bindings:page.map(row=>({integrationAccountId:row.integration_account_id,resourceType:row.resource_type,
   externalId:row.external_id,createdAt:new Date(row.created_at).toISOString()})),
  hasMore,nextCursor,cursorExpiresAt:hasMore?new Date(expires).toISOString():null,
  consistency:'LIVE_KEYSET_RESTART_ON_CHANGE'};
}
