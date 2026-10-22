import {describe,it,expect} from 'vitest';
import {createPgDatabase} from '../src/db/postgres.js';
import {migrate} from '../src/db/migrate.js';
import {insertUser} from '../src/domain/users.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {appendAudit} from '../src/domain/audit.js';
import {listEventStream} from '../src/platform/event-stream.js';
import {newId} from '../src/ids.js';
import {randomBytes} from 'node:crypto';

// Explicit isolated-test credentials only. Never falls back to DATABASE_URL.
const connection=process.env.PACKPROOF_TEST_DATABASE_URL;
describe.skipIf(!connection)('T07 real PostgreSQL concurrency gate',()=>{
 it('holds B behind allocated A, reconnects the reader, and discovers every committed event',async()=>{
  const admin=createPgDatabase(connection!),schema=`partner_gate_${randomBytes(8).toString('hex')}`;
  await admin.db.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(connection!);url.searchParams.set('options',`-c search_path=${schema}`);
  const opened=createPgDatabase(url.toString());let reader=createPgDatabase(url.toString());
  const clock={now:()=>new Date()},config={signingKey:randomBytes(32).toString('base64')};
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let writerA:Promise<unknown>|undefined,writerB:Promise<unknown>|undefined;
  try{
   await migrate(opened.db);const user=await insertUser(opened.db,clock),tenant=newId('ten');
   await opened.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,'PostgreSQL synthetic gate','sandbox',$3)",[tenant,user,clock.now().toISOString()]);
   const proof=await createOrGetProof(opened.db,clock,user,(await createTransaction(opened.db,clock,user,{itemTitle:'Concurrency fixture'})).transactionId);
   await opened.db.query("INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,'gate',$2,'synthetic',$3)",[tenant,proof.proofId,clock.now().toISOString()]);
   const scope={tenantId:tenant,environment:'sandbox' as const},before=await listEventStream(reader.db,clock,scope,config);
   let allocated!:()=>void;const allocatedSignal=new Promise<void>(r=>{allocated=r;});
   writerA=opened.db.transaction(async tx=>{await appendAudit(tx,{proofId:proof.proofId,actorUserId:user,eventType:'PROOF_ACCESSED',eventData:{writer:'A'},at:clock.now()});await tx.query('SET CONSTRAINTS ALL IMMEDIATE');allocated();await held;});
   await allocatedSignal;
   let backendPid=0;
   writerB=opened.db.transaction(async tx=>{backendPid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;await appendAudit(tx,{proofId:proof.proofId,actorUserId:user,eventType:'PROOF_ACCESSED',eventData:{writer:'B'},at:clock.now()});await tx.query('SET CONSTRAINTS ALL IMMEDIATE');});
   let blocked=false;
   for(let n=0;n<100;n++){
    if(backendPid)blocked=Boolean((await reader.db.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[backendPid])).rows[0]);
    if(blocked)break;await new Promise(r=>setTimeout(r,20));
   }
   expect(blocked).toBe(true);
   expect((await listEventStream(reader.db,clock,scope,config,{after:before.nextCursor})).events).toEqual([]);
   await reader.close();reader=createPgDatabase(url.toString());
   release();await Promise.all([writerA,writerB]);
   const after=await listEventStream(reader.db,clock,scope,config,{after:before.nextCursor});
   expect(after.events).toHaveLength(2);expect(new Set(after.events.map(e=>e.id)).size).toBe(2);
   expect(BigInt(after.events[1].streamSequence)-BigInt(after.events[0].streamSequence)).toBe(1n);
  }finally{
   release();await Promise.allSettled([writerA,writerB]);await reader.close();await opened.close();
   // The only dropped schema was generated and created by this test invocation.
   await admin.db.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();
  }
 },60000);
});
