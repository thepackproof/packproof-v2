import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export interface ReceiverDatabase {
 query<T=Record<string,unknown>>(sql:string,params?:unknown[]):Promise<{rows:T[];rowCount:number}>;
 transaction<T>(run:(tx:ReceiverDatabase)=>Promise<T>):Promise<T>;
}
export interface Subscription {
 id:string;tenantId:string;environment:'sandbox'|'live';endpointPath:string;
 secrets:{value:string;validUntil?:number}[];
 /** Reload trusted subscription/delegation state before accepting or working. */
 authorize:()=>Promise<void>;
}
export class ReceiverError extends Error {constructor(public status:number,message:string){super(message);}}
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export async function receiveEvent(db:ReceiverDatabase,subscription:Subscription,input:{path:string;rawBody:Buffer;signature:string},now=new Date()){
 if(input.rawBody.length>65536)throw new ReceiverError(413,'Event too large');
 if(input.path!==subscription.endpointPath)throw new ReceiverError(404,'Subscription not found');
 await subscription.authorize();
 const match=/^t=(\d+),v1=([a-f0-9]{64})$/.exec(input.signature),seconds=Math.floor(now.getTime()/1000);
 if(!match||!Number.isSafeInteger(Number(match[1]))||Math.abs(Number(match[1])-seconds)>300)throw new ReceiverError(401,'Invalid signature');
 const raw=input.rawBody.toString('utf8'),signature=Buffer.from(match[2],'hex');
 const verified=subscription.secrets.filter(s=>s.validUntil===undefined||s.validUntil>seconds).some(s=>timingSafeEqual(signature,createHmac('sha256',s.value).update(`${match[1]}.`).update(input.rawBody).digest()));
 if(!verified)throw new ReceiverError(401,'Invalid signature');
 let event:{id?:unknown;type?:unknown;tenantId?:unknown;environment?:unknown;apiVersion?:unknown;data?:{proofId?:unknown}};
 try{event=JSON.parse(raw);}catch{throw new ReceiverError(400,'Invalid JSON');}
 if(!event||typeof event.id!=='string'||event.id.length>200||typeof event.type!=='string'||event.apiVersion!=='v1'||event.tenantId!==subscription.tenantId||
  (event.environment!==undefined&&event.environment!==subscription.environment)||typeof event.data?.proofId!=='string'||event.data.proofId.length>200)throw new ReceiverError(400,'Invalid subscription event');
 const eventId=event.id,proofId=event.data.proofId,bodySha=hash(input.rawBody),effectKey=hash(`packproof:${subscription.id}:${eventId}:reconcile/v1`);
 return db.transaction(async tx=>{
  const accepted=await tx.query(`INSERT INTO receiver_inbox(provider,subscription_id,event_id,tenant_id,proof_id,body_sha256,received_at)
   VALUES('packproof',$1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_id`,[subscription.id,eventId,subscription.tenantId,proofId,bodySha,now.toISOString()]);
  if(!accepted.rows.length){
   const previous=(await tx.query<{body_sha256:string}>('SELECT body_sha256 FROM receiver_inbox WHERE provider=\'packproof\' AND subscription_id=$1 AND event_id=$2',[subscription.id,eventId])).rows[0];
   if(previous.body_sha256!==bodySha)throw new ReceiverError(409,'Event ID reused with changed content');
   return {accepted:true,duplicate:true};
  }
  await tx.query('INSERT INTO receiver_jobs(effect_key,subscription_id,event_id,proof_id,created_at) VALUES($1,$2,$3,$4,$5)',[effectKey,subscription.id,eventId,proofId,now.toISOString()]);
  return {accepted:true,duplicate:false};
 }); // Only return 2xx after this transaction commits.
}
export async function applyLocalJob(db:ReceiverDatabase,subscription:Subscription,now=new Date()){
 await subscription.authorize();
 return db.transaction(async tx=>{
  const job=(await tx.query<{effect_key:string;proof_id:string}>("SELECT effect_key,proof_id FROM receiver_jobs WHERE subscription_id=$1 AND state='PENDING' ORDER BY created_at,effect_key LIMIT 1 FOR UPDATE SKIP LOCKED",[subscription.id])).rows[0];
  if(!job)return {applied:false};
  await tx.query('INSERT INTO receiver_reconciliation_requests(effect_key,proof_id,requested_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[job.effect_key,job.proof_id,now.toISOString()]);
  await tx.query("UPDATE receiver_jobs SET state='DONE',completed_at=$2 WHERE effect_key=$1",[job.effect_key,now.toISOString()]);
  return {applied:true,effectKey:job.effect_key};
 });
}
