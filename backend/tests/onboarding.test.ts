import {afterEach,expect,it} from 'vitest';
import request from 'supertest';
import {auth,createHarness,login,commitFulfillmentAndAttest,type TestHarness} from './helpers.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {finalizeProof} from '../src/domain/finalize.js';
let h:TestHarness;afterEach(async()=>{await h?.close();});
it('persists resume and dismissal across clients, deduplicates events, and rejects reset/version forgery',async()=>{
 h=await createHarness();const user=await login(h.app,'onboarding-new');
 const get=()=>request(h.app).get('/me/onboarding').set(auth(user));
 const post=(body:unknown)=>request(h.app).post('/me/onboarding').set(auth(user)).send(body);
 expect((await get()).body).toMatchObject({onboarding_completed:false,onboarding_enrolled:true,onboarding_version:0});
 for(let i=0;i<2;i++){expect((await post({action:'start',version:1})).status).toBe(200);expect((await post({action:'step',version:1,step:2})).status).toBe(200);}
 expect((await get()).body.onboarding_last_step).toBe(2);
 expect((await post({action:'step',version:1,step:6})).status).toBe(400);
 expect((await post({action:'complete',version:2})).status).toBe(400);
 expect((await post({onboarding_completed:false})).status).toBe(400);
 await post({action:'skip',version:1,step:2});await post({action:'step',version:1,step:0});
 expect((await get()).body).toMatchObject({onboarding_completed:true,first_proof_coaching_completed:true,onboarding_last_step:null});
 const events=(await h.db.query<{event:string}>('SELECT event FROM onboarding_events WHERE user_id=$1',[user])).rows;
 expect(events.map(e=>e.event).sort()).toEqual(['onboarding_skipped','onboarding_started','onboarding_step_viewed']);
});
it('exempts existing accounts and isolates authenticated users',async()=>{
 h=await createHarness();const old=await login(h.app,'old');const fresh=await login(h.app,'fresh');
 await h.db.query('UPDATE users SET onboarding_enrolled=FALSE,onboarding_completed=TRUE,first_proof_coaching_completed=TRUE,onboarding_version=1 WHERE id=$1',[old]);
 expect((await request(h.app).get('/me/onboarding')).status).toBe(401);
 await request(h.app).post('/me/onboarding').set(auth(old)).send({action:'start',version:1});
 expect((await request(h.app).get('/me/onboarding').set(auth(fresh))).body.onboarding_completed).toBe(false);
 expect((await h.db.query('SELECT * FROM onboarding_events WHERE user_id=$1',[old])).rows.length).toBe(0);
});
it('records first-Proof start from domain records without client claims',async()=>{
 h=await createHarness();const user=await login(h.app,'first-proof');
 const tx=await createTransaction(h.db,h.clock,user,{itemTitle:'First shipment'});
 const proof=await createOrGetProof(h.db,h.clock,user,tx.transactionId);
 for(let i=0;i<2;i++){const res=await request(h.app).get('/me/onboarding').set(auth(user));expect(res.status).toBe(200);expect(res.body.first_proof_id).toBe(proof.proofId);}
 expect((await h.db.query("SELECT * FROM onboarding_events WHERE user_id=$1 AND event='first_proof_started'",[user])).rows.length).toBe(1);
});
it('allows only the pending onboarding migration during rolling deployment and keeps its API unavailable',async()=>{
 h=await createHarness();const user=await login(h.app,'pending-migration');const {assertSchemaCurrent}=await import('../src/db/migrate.js');
 await h.db.query("DELETE FROM schema_migrations WHERE id='075_onboarding'");
 await expect(assertSchemaCurrent(h.db,undefined,true)).resolves.toBeUndefined();
 await expect(assertSchemaCurrent(h.db)).rejects.toThrow('075_onboarding');
 expect((await request(h.app).get('/me/onboarding').set(auth(user))).status).toBe(503);
 await h.db.query("DELETE FROM schema_migrations WHERE id='074_desktop_capture_registration'");
 await expect(assertSchemaCurrent(h.db,undefined,true)).rejects.toThrow('074_desktop_capture_registration');
});
it('derives first activation from the earliest finalized packing Proof even after an abandoned draft and tutorial dismissal',async()=>{
 let now=new Date('2026-10-11T10:00:00Z');h=await createHarness({now:()=>new Date(now)});
 const user=await login(h.app,'later-first-packing');
 const abandoned=await createTransaction(h.db,h.clock,user,{itemTitle:'Abandoned draft'});
 await createOrGetProof(h.db,h.clock,user,abandoned.transactionId);
 await request(h.app).post('/me/onboarding').set(auth(user)).send({action:'skip',version:1,step:1});
 expect((await request(h.app).get('/me/onboarding').set(auth(user))).body).toMatchObject({activation_status:'NOT_ACTIVATED',first_proof_completed:false});
 now=new Date('2026-10-11T11:00:00Z');
 const tx=await createTransaction(h.db,h.clock,user,{itemTitle:'Actual shipment'});
 const proof=await createOrGetProof(h.db,h.clock,user,tx.transactionId);
 await commitFulfillmentAndAttest(h,user,proof.proofId);
 expect((await request(h.app).get('/me/onboarding').set(auth(user))).body.activation_status).toBe('NOT_ACTIVATED');
 now=new Date('2026-10-11T11:05:00Z');
 await finalizeProof(h.db,h.clock,user,proof.proofId);
 for(let i=0;i<2;i++)expect((await request(h.app).get('/me/onboarding').set(auth(user))).body).toMatchObject({
  automatic_tour:false,first_experience_version:1,activation_status:'ACTIVATED',first_proof_completed:true,
  first_proof_coaching_completed:true,first_finalized_packing_proof_id:proof.proofId,first_finalized_packing_at:now.toISOString(),
 });
 const events=(await h.db.query<{event:string;occurred_at:string|Date}>("SELECT event,occurred_at FROM onboarding_events WHERE user_id=$1 AND event='first_packing_proof_finalized'",[user])).rows;
 expect(events).toHaveLength(1);expect(new Date(events[0].occurred_at).toISOString()).toBe(now.toISOString());
});
it('backfills old-account activation without reopening or completing guidance and excludes viewer-only history',async()=>{
 h=await createHarness();const seller=await login(h.app,'historic-seller'),viewer=await login(h.app,'historic-viewer');
 await h.db.query('UPDATE users SET onboarding_enrolled=FALSE,onboarding_completed=TRUE,first_proof_coaching_completed=TRUE WHERE id=$1',[seller]);
 const tx=await createTransaction(h.db,h.clock,seller,{itemTitle:'Historic shipment'});
 const proof=await createOrGetProof(h.db,h.clock,seller,tx.transactionId);
 await h.db.query("INSERT INTO proof_participants(id,proof_id,user_id,role,joined_at) VALUES('viewer-participant',$1,$2,'BUYER',now())",[proof.proofId,viewer]);
 await commitFulfillmentAndAttest(h,seller,proof.proofId);await finalizeProof(h.db,h.clock,seller,proof.proofId);
 expect((await request(h.app).get('/me/onboarding').set(auth(seller))).body).toMatchObject({activation_status:'ACTIVATED',onboarding_completed:true,first_proof_coaching_completed:true});
 expect((await request(h.app).get('/me/onboarding').set(auth(viewer))).body).toMatchObject({activation_status:'NOT_ACTIVATED',first_proof_completed:false,first_proof_id:null});
 expect((await h.db.query("SELECT * FROM onboarding_events WHERE user_id=$1 AND event='onboarding_completed'",[seller])).rows).toHaveLength(0);
});
it('excludes finalized sandbox and sample records and does not activate from imported-only work or forged completion',async()=>{
 h=await createHarness();const user=await login(h.app,'ineligible-activation');
 for(const kind of ['sandbox','sample','demo','provider-sandbox']){
  const metadata=kind==='sample'?{sample:true}:kind==='demo'?{import:{adapterKey:'demo-storefront'}}:kind==='provider-sandbox'?{import:{providerIdentifiers:{environment:'sandbox'}}}:{};
  const tx=await createTransaction(h.db,h.clock,user,{itemTitle:kind,metadata});const proof=await createOrGetProof(h.db,h.clock,user,tx.transactionId);
  if(kind==='sandbox'){
   await h.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES('activation-sandbox',$1,'Sandbox','sandbox',now())",[user]);
   await h.db.query("INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES('activation-sandbox','fixture',$1,'fixture',now())",[proof.proofId]);
  }
  await commitFulfillmentAndAttest(h,user,proof.proofId);await finalizeProof(h.db,h.clock,user,proof.proofId);
 }
 const imported=await createTransaction(h.db,h.clock,user,{itemTitle:'Imported only'});await createOrGetProof(h.db,h.clock,user,imported.transactionId);
 expect((await request(h.app).post('/me/onboarding').set(auth(user)).send({action:'activate',version:1,first_proof_completed:true})).status).toBe(400);
 expect((await request(h.app).get('/me/onboarding').set(auth(user))).body).toMatchObject({activation_status:'NOT_ACTIVATED',first_proof_completed:false,first_finalized_packing_proof_id:null});
 expect((await h.db.query("SELECT * FROM onboarding_events WHERE user_id=$1 AND event='first_packing_proof_finalized'",[user])).rows).toHaveLength(0);
});
