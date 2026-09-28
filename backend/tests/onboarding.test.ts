import {afterEach,expect,it} from 'vitest';
import request from 'supertest';
import {auth,createHarness,login,type TestHarness} from './helpers.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
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
