import {createHmac,timingSafeEqual} from 'node:crypto';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import type {PartnerActor} from './organizations.js';

interface Cursor {v:1;query:'proofs';merchant:string;environment:string;after:string;highWater:string;expires:number}
const invalid=()=>new DomainError('INVALID_CURSOR','Use a cursor from this merchant Proof listing',400);
/** Membership is frozen at the committed stream watermark. New Proofs appear on
 * the next fresh listing. Authorizations are always evaluated at request time. */
export async function listPartnerProofs(db:Database,clock:Clock,actor:PartnerActor,after:unknown,signingKey:string){
 const key=Buffer.from(signingKey,'base64');if(key.length!==32)throw new DomainError('CURSOR_SIGNING_UNAVAILABLE','Cursor signing is not configured',503);
 const mac=(body:string)=>createHmac('sha256',key).update(`proof-list/v1:${body}`).digest();
 let cursor:Cursor;
 if(after!==undefined){
  if(typeof after!=='string'||after.length>2048)throw invalid();
  const parts=after.split('.');if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))throw invalid();
  const sig=Buffer.from(parts[1],'base64url'),expected=mac(parts[0]);if(sig.length!==expected.length||!timingSafeEqual(sig,expected))throw invalid();
  try{cursor=JSON.parse(Buffer.from(parts[0],'base64url').toString());}catch{throw invalid();}
  if(!cursor||cursor.v!==1||cursor.query!=='proofs'||cursor.merchant!==actor.merchantId||cursor.environment!==actor.environment||
    ![cursor.after,cursor.highWater].every(x=>typeof x==='string'&&/^\d{1,19}$/.test(x)&&BigInt(x)<=9223372036854775807n)||!Number.isSafeInteger(cursor.expires))throw invalid();
  if(cursor.expires<=clock.now().getTime())throw new DomainError('CURSOR_EXPIRED','Restart the Proof listing and reconcile using the event stream',410);
 }else{
  const head=(await db.query<{position:string}>('SELECT position::text FROM api_event_stream_heads WHERE tenant_id=$1',[actor.tenantId])).rows[0]?.position??'0';
  cursor={v:1,query:'proofs',merchant:actor.merchantId,environment:actor.environment,after:'0',highWater:head,expires:clock.now().getTime()+3600000};
 }
 const rows=(await db.query<{proof_id:string;position:string}>(`WITH first_event AS (
   SELECT o.proof_id,MIN(s.position) AS position FROM api_event_stream s JOIN proof_outbox o ON o.id=s.event_id
   JOIN platform_proof_ownership p ON p.proof_id=o.proof_id AND p.merchant_id=$2 AND p.environment=$3
   WHERE s.tenant_id=$1 AND s.position<=$4::bigint GROUP BY o.proof_id
  ) SELECT proof_id,position::text FROM first_event WHERE position>$5::bigint ORDER BY position LIMIT 51`,
  [actor.tenantId,actor.merchantId,actor.environment,cursor.highWater,cursor.after])).rows;
 const page=rows.slice(0,50);cursor.after=page.at(-1)?.position??cursor.after;
 const body=Buffer.from(JSON.stringify(cursor)).toString('base64url');
 return {proofIds:page.map(r=>r.proof_id),nextCursor:`${body}.${mac(body).toString('base64url')}`,hasMore:rows.length>50,cursorExpiresAt:new Date(cursor.expires).toISOString()};
}
