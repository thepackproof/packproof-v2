import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import express, {type NextFunction,type Request,type Response} from 'express';
import request from 'supertest';
import {createPgliteDatabase} from '../src/db/pglite.js';
import {migrate} from '../src/db/migrate.js';
import {BearerUserAdapter} from '../src/auth/adapter.js';
import {CognitoJwtAdapter} from '../src/auth/cognito-adapter.js';
import {ensureIdentityUser,insertUser} from '../src/domain/users.js';
import {bootstrapSystemAdmin} from '../src/admin/bootstrap.js';
import {getAdminMe,requireSystemAdmin} from '../src/admin/auth.js';
import {appendAdminAudit,runAdminCommand} from '../src/admin/audit.js';
import {adminActionsRouter} from '../src/admin/actions.js';
import {createIntakeSession,authenticateIntakeSession} from '../src/intake/sessions.js';
import {registerOfferVersion,scheduleApprovedOfferPeriod,getAccountUsageSummary,type OfferDefinition} from '../src/billing/usage-ledger.js';
import {syntheticPublication} from './program-metrics-publication-fixture.js';
import {createTransaction} from '../src/domain/transactions.js';
import {createOrGetProof} from '../src/domain/create-proof.js';
import {createCaptureSession} from '../src/domain/capture-sessions.js';

const now=new Date('2026-09-24T12:00:00.000Z'),clock={now:()=>new Date(now)};
let opened:Awaited<ReturnType<typeof createPgliteDatabase>>,admin:string,app:ReturnType<typeof express>;
const bearer=(id:string)=>({Authorization:`Bearer ${id}`});
const command=(id:string,operationId:string,expectedVersion=0)=>({operationId,reason:'Reviewed support request',confirmation:id,expectedVersion});
function buildApp(devAuth=true,authenticatedAt?:number){
 const result=express();result.use(express.json());const auth=new BearerUserAdapter(opened.db);
 result.use((req:Request,_res:Response,next:NextFunction)=>{void auth.authenticate(req.headers).then(context=>{req.packproofUserId=context.userId;req.packproofAuth={...context,authenticatedAt};next();}).catch(next);});
 result.use('/admin',requireSystemAdmin({db:opened.db,clock}),adminActionsRouter({db:opened.db,clock,devAuth}));
 result.use((err:any,_req:Request,res:Response,_next:NextFunction)=>res.status(err.httpStatus??500).json({error:{code:err.code??'INTERNAL',message:err.message}}));return result;
}
beforeAll(async()=>{
 opened=await createPgliteDatabase();await migrate(opened.db);
 const adapter=new CognitoJwtAdapter(opened.db,clock,{verify:async()=>({sub:'admin-subject',token_use:'id',iss:'verified-fixture',exp:Math.floor(now.getTime()/1000)+3600,email:'admin@thepackproof.com',email_verified:true})});
 admin=(await adapter.authenticate({authorization:'Bearer verified-fixture'})).userId;
 await expect(bootstrapSystemAdmin(opened.db,clock,{userId:admin,cognitoSubject:'wrong-subject',reason:'Initial verified administrator'})).rejects.toMatchObject({code:'ADMIN_BOOTSTRAP_IDENTITY_MISMATCH'});
 expect((await bootstrapSystemAdmin(opened.db,clock,{userId:admin,cognitoSubject:'admin-subject',reason:'Initial verified administrator'})).alreadyAssigned).toBe(false);
 app=buildApp();
},30000);
afterAll(async()=>{await opened?.close();});

describe('authoritative system administration',()=>{
 it('requires authentication and database role; an email alone grants nothing',async()=>{
  const user=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,'admin@thepackproof.com',$2,'COGNITO')",[user,now.toISOString()]);
  expect((await request(app).get('/admin/me')).status).toBe(401);
  expect((await request(app).get('/admin/me').set(bearer(user))).status).toBe(403);
  expect((await request(app).post(`/admin/users/${admin}/status`).set(bearer(user)).send({...command(admin,'unauthorized-1'),status:'DISABLED'})).status).toBe(403);
  expect((await request(app).get('/admin/me').set(bearer(admin))).body).toEqual({userId:admin,isAdmin:true,roles:['SYSTEM_ADMIN'],environment:'development'});
  await opened.db.query("DELETE FROM user_verified_contacts WHERE user_id=$1",[admin]);
  expect((await getAdminMe(opened.db,admin)).isAdmin).toBe(true);
 });
 it('requires fresh sign-in for production mutations and never accepts freshness from request body',async()=>{
  const user=await insertUser(opened.db,clock),input={...command(user,'reauth-001'),status:'DISABLED'};
  expect((await request(buildApp(false)).post(`/admin/users/${user}/status`).set(bearer(admin)).send(input)).body.error.code).toBe('ADMIN_REAUTH_REQUIRED');
  expect((await request(buildApp(false,Math.floor(now.getTime()/1000)-901)).post(`/admin/users/${user}/status`).set(bearer(admin)).send(input)).status).toBe(403);
  expect((await request(buildApp(false,Math.floor(now.getTime()/1000))).post(`/admin/users/${user}/status`).set(bearer(admin)).send(input)).status).toBe(200);
 });
 it('audits account disable atomically and supports idempotent retry, conflict and stale-version rejection',async()=>{
  const user=await insertUser(opened.db,clock),path=`/admin/users/${user}/status`,input={...command(user,'disable-001'),status:'DISABLED'};
  const first=await request(app).post(path).set(bearer(admin)).send(input);expect(first.status).toBe(200);expect(first.body.adminVersion).toBe(1);
  expect((await request(app).post(path).set(bearer(admin)).send(input)).body).toEqual(first.body);
  expect((await request(app).post(path).set(bearer(admin)).send({...input,status:'ACTIVE'})).body.error.code).toBe('ADMIN_IDEMPOTENCY_CONFLICT');
  expect((await request(app).post(path).set(bearer(admin)).send({...command(user,'enable-stale'),status:'ACTIVE'})).body.error.code).toBe('ADMIN_VERSION_CONFLICT');
  expect((await request(app).get('/admin/me').set(bearer(user))).status).toBe(401);
  expect((await request(app).post(path).set(bearer(admin)).send({...command(user,'enable-fresh',1),status:'ACTIVE'})).status).toBe(200);
  const audits=(await opened.db.query('SELECT id FROM system_admin_audit_events WHERE target_id=$1',[user])).rows;expect(audits).toHaveLength(2);
  await expect(opened.db.query("UPDATE system_admin_audit_events SET reason='changed reason' WHERE id=$1",[audits[0].id])).rejects.toThrow('AUDIT_IMMUTABLE');
  await expect(opened.db.query('DELETE FROM system_admin_audit_events WHERE id=$1',[audits[0].id])).rejects.toThrow('AUDIT_IMMUTABLE');
 });
 it('rechecks revocation of a database role for an already authenticated account',async()=>{
  const user=await insertUser(opened.db,clock);
  await opened.db.query("INSERT INTO user_system_roles(user_id,role,granted_at) VALUES($1,'SYSTEM_ADMIN',$2)",[user,now.toISOString()]);
  expect((await request(app).get('/admin/me').set(bearer(user))).status).toBe(200);
  await opened.db.query('DELETE FROM user_system_roles WHERE user_id=$1',[user]);
  expect((await request(app).get('/admin/me').set(bearer(user))).status).toBe(403);
 });
 it('rolls back an account mutation when the immutable audit cannot be committed',async()=>{
  const user=await insertUser(opened.db,clock);
  const input=command(user,'audit-failure-001');
  await expect(runAdminCommand(opened.db,clock,admin,'TEST_ATOMICITY',user,input,async tx=>{
    await tx.query("UPDATE users SET status='DISABLED' WHERE id=$1",[user]);
    // A duplicate immutable operation simulates failure of the audit append.
    await appendAdminAudit(tx,clock,{actorId:admin,action:'TEST_ATOMICITY',targetType:'user',targetId:user,reason:input.reason,before:{},after:{},operationId:`bootstrap:${admin}`});
    return {changed:true};
  })).rejects.toThrow();
  expect((await opened.db.query('SELECT status FROM users WHERE id=$1',[user])).rows[0].status).toBe('ACTIVE');
  expect((await opened.db.query('SELECT 1 FROM admin_command_receipts WHERE actor_id=$1 AND operation_id=$2',[admin,input.operationId])).rows).toHaveLength(0);
 });
 it('forbids self disable and exposes no evidence or role mutation endpoint',async()=>{
  expect((await request(app).post(`/admin/users/${admin}/status`).set(bearer(admin)).send({...command(admin,'self-disable'),status:'DISABLED'})).body.error.code).toBe('ADMIN_SELF_DISABLE');
  expect((await request(app).post('/admin/proofs/finalized/evidence').set(bearer(admin)).send({hash:'replacement'})).status).toBe(404);
  expect((await request(app).post('/admin/users/me/role').set(bearer(admin)).send({role:'SYSTEM_ADMIN'})).status).toBe(404);
 });
 it('rejects prior Cognito sign-ins even after refresh and revokes scoped intake sessions',async()=>{
  let authTime=Math.floor(now.getTime()/1000)-30;
  const adapter=new CognitoJwtAdapter(opened.db,clock,{verify:async()=>({sub:'revoked-subject',token_use:'access',iss:'verified',exp:Math.floor(now.getTime()/1000)+3600,auth_time:authTime})});
  const user=(await adapter.authenticate({authorization:'Bearer verified'})).userId;
  const intake=await createIntakeSession(opened.db,clock,user);
  const result=await request(app).post(`/admin/users/${user}/revoke-sessions`).set(bearer(admin)).send(command(user,'revoke-user-1'));expect(result.status).toBe(200);
  await expect(adapter.authenticate({authorization:'Bearer newly-refreshed-token'})).rejects.toMatchObject({code:'SESSION_REVOKED'});
  await expect(authenticateIntakeSession(opened.db,clock,intake.token)).rejects.toMatchObject({code:'INTAKE_SESSION_EXPIRED'});
  authTime=Math.floor(now.getTime()/1000)+1;expect((await adapter.authenticate({authorization:'Bearer fresh-sign-in'})).userId).toBe(user);
 });
 it('changes allowlisted flags with an immutable audit and honors them in account creation',async()=>{
  const key='REGISTRATION_PAUSED';
  const pause=await request(app).post(`/admin/feature-flags/${key}`).set(bearer(admin)).send({...command(key,'pause-signups'),enabled:true});expect(pause.status).toBe(200);
  await expect(ensureIdentityUser(opened.db,clock,'cognito','new-registration')).rejects.toMatchObject({code:'REGISTRATION_PAUSED'});
  expect(await ensureIdentityUser(opened.db,clock,'cognito','admin-subject')).toBe(admin);
  expect((await request(app).post('/admin/feature-flags/DELETE_EVIDENCE').set(bearer(admin)).send({...command('DELETE_EVIDENCE','invalid-flag'),enabled:true})).status).toBe(404);
  expect((await request(app).post(`/admin/feature-flags/${key}`).set(bearer(admin)).send({...command(key,'resume-signups',1),enabled:false})).status).toBe(200);
  expect((await opened.db.query("SELECT id FROM system_admin_audit_events WHERE action='FEATURE_FLAG_CHANGED' AND target_id=$1",[key])).rows).toHaveLength(2);
 });
 it('pauses new capture sessions while preserving idempotent session recovery',async()=>{
  const user=await insertUser(opened.db,clock);
  const transaction=await createTransaction(opened.db,clock,user,{itemTitle:'Captured item'});
  const proof=await createOrGetProof(opened.db,clock,user,transaction.transactionId);
  const session=await createCaptureSession(opened.db,clock,user,proof.proofId,{client:'WEB_CAMERA',idempotencyKey:'before-pause'});
  const key='NEW_CAPTURE_PAUSED';
  expect((await request(app).post(`/admin/feature-flags/${key}`).set(bearer(admin)).send({...command(key,'pause-capture-1'),enabled:true})).status).toBe(200);
  expect((await createCaptureSession(opened.db,clock,user,proof.proofId,{client:'WEB_CAMERA',idempotencyKey:'before-pause'})).id).toBe(session.id);
  await expect(createCaptureSession(opened.db,clock,user,proof.proofId,{client:'WEB_CAMERA',idempotencyKey:'after-pause'})).rejects.toMatchObject({code:'NEW_CAPTURE_PAUSED'});
  expect((await request(app).post(`/admin/feature-flags/${key}`).set(bearer(admin)).send({...command(key,'resume-capture',1),enabled:false})).status).toBe(200);
 });
 it('requires confirmations and never makes an unaudited partial change on invalid input',async()=>{
  const user=await insertUser(opened.db,clock);
  expect((await request(app).post(`/admin/users/${user}/status`).set(bearer(admin)).send({...command(user,'bad-confirmation'),confirmation:'wrong',status:'DISABLED'})).status).toBe(400);
  expect((await opened.db.query('SELECT status,admin_version FROM users WHERE id=$1',[user])).rows[0]).toEqual({status:'ACTIVE',admin_version:0});
  expect((await opened.db.query('SELECT id FROM system_admin_audit_events WHERE target_id=$1',[user])).rows).toHaveLength(0);
 });
 it('keeps missing prepaid credits honest and records real plan allowance adjustments once',async()=>{
  const user=await insertUser(opened.db,clock),path=`/admin/users/${user}/credits`,input={...command(user,'adjust-credit-1'),delta:2};
  expect((await request(app).post(path).set(bearer(admin)).send(input)).body.error.code).toBe('BILLING_ACTIVE_PERIOD_REQUIRED');
  const offer:OfferDefinition={schemaVersion:'packproof.billing.v1',version:'admin-allowance-fixture',status:'approved',currency:'USD',priceMinor:2900,interval:'monthly',includedFinalizedProofs:1,maxRecordingBytes:10000,maxRecordingSeconds:30,retentionPolicyVersion:'test-retention-v1',preservationStandard:'canonical-original-v1',supplements:'included_within_published_allowance',overage:'block_new_capture',approvedTermsReference:'synthetic-terms'};
  const options={publication:syntheticPublication(offer,now)};await registerOfferVersion(opened.db,clock,offer,options);
  await scheduleApprovedOfferPeriod(opened.db,clock,{id:'admin-allowance-period',userId:user,offerVersion:offer.version,start:now.toISOString(),end:'2026-10-24T12:00:00.000Z',consentReceiptReference:'test-consent'},options);
  const first=await request(app).post(path).set(bearer(admin)).send(input);expect(first.status).toBe(200);expect(first.body.allowance).toBe(3);
  expect((await request(app).post(path).set(bearer(admin)).send(input)).body).toEqual(first.body);
  expect((await opened.db.query('SELECT delta FROM billing_allowance_adjustments WHERE user_id=$1',[user])).rows).toEqual([{delta:2}]);
  expect((await getAccountUsageSummary(opened.db,clock,user)).currentOffer).toMatchObject({allowanceAdjustments:2,effectiveAllowance:3,remaining:3});
  // New captures consume the adjusted real plan allowance, not a disconnected display counter.
  for(let i=0;i<3;i++){
    const transaction=await createTransaction(opened.db,clock,user,{itemTitle:`Allowance item ${i}`});
    const proof=await createOrGetProof(opened.db,clock,user,transaction.transactionId);
    await createCaptureSession(opened.db,clock,user,proof.proofId,{client:'WEB_CAMERA',idempotencyKey:`allowance-${i}`});
  }
  const transaction=await createTransaction(opened.db,clock,user,{itemTitle:'Beyond allowance'});
  const proof=await createOrGetProof(opened.db,clock,user,transaction.transactionId);
  await expect(createCaptureSession(opened.db,clock,user,proof.proofId,{client:'WEB_CAMERA',idempotencyKey:'over-allowance'})).rejects.toMatchObject({code:'BILLING_CAPTURE_ALLOWANCE_EXHAUSTED'});
  expect((await request(app).post(path).set(bearer(admin)).send({...command(user,'remove-reserved',1),delta:-1})).body.error.code).toBe('ALLOWANCE_BELOW_RESERVED');
  await expect(opened.db.query('UPDATE billing_allowance_adjustments SET delta=100 WHERE user_id=$1',[user])).rejects.toThrow('AUDIT_IMMUTABLE');
 });
});
