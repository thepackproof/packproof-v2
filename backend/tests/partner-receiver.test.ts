import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {splitSqlStatements} from '../src/db/sql.js';
import {receiveEvent,applyLocalJob,type ReceiverDatabase,type Subscription} from '../../examples/merchant-receiver/receiver.js';
import {signWebhook} from '../src/platform/webhooks.js';

describe('T08 durable merchant receiver',()=>{
 it('rolls back inbox on a crash, survives restart, and applies duplicate/out-of-order deliveries once',async()=>{
  const open=async(loadDataDir?:Blob)=>{
   const client=new PGlite({loadDataDir});await client.waitReady;
   const wrap=(connection:any):ReceiverDatabase=>({query:async<T>(sql:string,params?:unknown[])=>{const r=await connection.query(sql,params);return {rows:r.rows as T[],rowCount:r.affectedRows??r.rows.length};},transaction:fn=>connection.transaction((tx:any)=>fn(wrap(tx)))});
   return {db:wrap(client),close:()=>client.close(),dump:()=>client.dumpDataDir()};
  };
  let opened=await open();const now=new Date(),seconds=Math.floor(now.getTime()/1000);
  let active=true;const subscription:Subscription={id:'subscription-a',tenantId:'merchant-a',environment:'sandbox',endpointPath:'/events/a',secrets:[{value:'current'},{value:'previous',validUntil:seconds+60}],authorize:async()=>{if(!active)throw new Error('REVOKED');}};
  const delivery=(id:string,secret='current',tenantId='merchant-a')=>{const rawBody=Buffer.from(JSON.stringify({id,type:'proof.finalized',apiVersion:'v1',tenantId,environment:'sandbox',data:{proofId:'proof-a'}}));return {path:'/events/a',rawBody,signature:signWebhook(secret,seconds,rawBody.toString())};};
  try{
   const schema=await readFile(new URL('../../examples/merchant-receiver/schema.sql',import.meta.url),'utf8');
   for(const statement of splitSqlStatements(schema))await opened.db.query(statement);
   const crashing:ReceiverDatabase={query:(sql,p)=>opened.db.query(sql,p),transaction:fn=>opened.db.transaction(tx=>fn({query:async(sql,p)=>{if(sql.startsWith('INSERT INTO receiver_jobs'))throw new Error('CRASH_BEFORE_COMMIT');return tx.query(sql,p);},transaction:inner=>tx.transaction(inner)}))};
   await expect(receiveEvent(crashing,subscription,delivery('event-new'),now)).rejects.toThrow('CRASH_BEFORE_COMMIT');
   expect((await opened.db.query('SELECT * FROM receiver_inbox')).rows).toHaveLength(0);
   expect(await receiveEvent(opened.db,subscription,delivery('event-new','previous'),now)).toMatchObject({duplicate:false});
   const persisted=await opened.dump();await opened.close();opened=await open(persisted);
   expect(await receiveEvent(opened.db,subscription,delivery('event-new'),now)).toMatchObject({duplicate:true});
   await receiveEvent(opened.db,subscription,delivery('event-old'),now);
   await applyLocalJob(opened.db,subscription,now);await applyLocalJob(opened.db,subscription,now);
   expect(await applyLocalJob(opened.db,subscription,now)).toEqual({applied:false});
   expect((await opened.db.query('SELECT * FROM receiver_reconciliation_requests')).rows).toHaveLength(2);
   await expect(receiveEvent(opened.db,subscription,delivery('bad','wrong'),now)).rejects.toMatchObject({status:401});
   await expect(receiveEvent(opened.db,subscription,delivery('cross','current','merchant-b'),now)).rejects.toMatchObject({status:400});
   await expect(receiveEvent(opened.db,subscription,delivery('expired'),new Date(now.getTime()+301000))).rejects.toMatchObject({status:401});
   await expect(receiveEvent(opened.db,subscription,{...delivery('endpoint'),path:'/events/b'},now)).rejects.toMatchObject({status:404});
   active=false;await expect(applyLocalJob(opened.db,subscription,now)).rejects.toThrow('REVOKED');
  }finally{await opened.close();}
 },30000);
});
