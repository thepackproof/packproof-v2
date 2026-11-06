import express, {type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import {newId} from '../ids.js';
import {sha256Hex} from '../hash.js';
import {canonicalize} from '../canonical.js';
import {DomainError} from '../domain/errors.js';
import {textField} from '../platform/tenants.js';
import {reauthorizePartner,type PartnerActor,organizationAdmin} from '../platform/organizations.js';
import {partnerProblem,requirePartnerFeature} from '../platform/partner-router.js';
import {distributedRateLimit} from '../http/boundary.js';
import {requireRecordWorkspace} from './access.js';
import {startEnrollment,redeemEnrollment,readEnrollment,decideEnrollment,agentWorkspace,readAgentInventory,readAgentDetail,actOnAgent,installationForActor,agentView,proposeAgentConfig,heartbeatAgent,renewAgentCredential} from './agent-enrollments.js';
const route=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r,s).catch(n);
export function createConnectEnrollmentRouter(deps:AppDependencies){
 const router=express.Router();
 router.use((_r,_s,n)=>{try{requirePartnerFeature();n();}catch(e){n(e);}});
 router.post('/enrollments',distributedRateLimit(deps.db,{scope:'connect-start',limit:12,windowMs:60000}),route(async(r,s)=>{s.status(201).json(await startEnrollment(deps,r.body));}));
 router.post('/enrollments/:enrollmentId/redeem',distributedRateLimit(deps.db,{scope:'connect-poll',limit:60,windowMs:60000}),route(async(r,s)=>{s.setHeader('Retry-After','5');s.json(await redeemEnrollment(deps,r.params.enrollmentId,r.body));}));
 router.use(partnerProblem);return router;
}
export function createAgentHumanRouter(deps:AppDependencies){
 const router=express.Router();
 async function workspace(r:Request,mutating=false){return agentWorkspace(deps,r.headers,r.body?.organizationId??r.query.organizationId,r.body?.environment??r.query.environment,mutating);}
 router.get('/agent-enrollments/:enrollmentId',route(async(r,s)=>{const w=await workspace(r);s.json(await readEnrollment(deps,r.params.enrollmentId,w));}));
 router.get('/agent-installations',route(async(r,s)=>{s.json(await readAgentInventory(deps,await workspace(r)));}));
 router.get('/agent-installations/:installationId',route(async(r,s)=>{s.json(await readAgentDetail(deps,await workspace(r),r.params.installationId,typeof r.query.importId==='string'?r.query.importId:undefined));}));
 function command(path:string,fn:(tx:Database,w:Awaited<ReturnType<typeof workspace>>,r:Request,requestId:string)=>Promise<unknown>){
  router.post(path,route(async(r,s)=>{
   const w=await workspace(r,true),operation=`connect:POST:${r.path}`,keyHash=sha256Hex(textField(r.header('Idempotency-Key'),'Idempotency-Key')),hash=sha256Hex(canonicalize(r.body??{}));
   const value=await deps.db.transaction(async tx=>{
    await organizationAdmin(tx,w.userId,w.organizationId);
    // Recheck entitlement before cached responses as well as new commands.
    await requireRecordWorkspace(tx,w.userId,w.organizationId,w.environment,true);
    await tx.query('INSERT INTO platform_command_results(actor_user_id,operation,key_hash,request_hash,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[w.userId,operation,keyHash,hash,deps.clock.now().toISOString()]);
    const old=(await tx.query<{request_hash:string;response:unknown}>('SELECT request_hash,response FROM platform_command_results WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3 FOR UPDATE',[w.userId,operation,keyHash])).rows[0];
    if(old.request_hash!==hash)throw new DomainError('IDEMPOTENCY_CONFLICT','The command key was used with different choices',409);
    if(old.response!==null){s.setHeader('Idempotency-Replayed','true');return old.response;}
    const result=await fn(tx,w,r,s.locals.operationId??newId('req'));
    await tx.query('UPDATE platform_command_results SET response=$4::jsonb WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3',[w.userId,operation,keyHash,JSON.stringify(result)]);
    return result;
   });
   await workspace(r,true);s.json(value);
  }));
 }
 command('/agent-enrollments/:enrollmentId/decision',(tx,w,r,id)=>decideEnrollment(deps,tx,w,r.params.enrollmentId,r.body,id));
 command('/agent-installations/:installationId/actions',(tx,w,r,id)=>actOnAgent(deps,tx,w,r.params.installationId,r.body,id));
 router.use(partnerProblem);return router;
}
export function createAgentPartnerRouter(deps:AppDependencies){
 const router=express.Router();
 const actor=(r:Request)=>(r as Request&{partnerActor:PartnerActor}).partnerActor;
 router.get('/agent/config',route(async(r,s)=>{const a=actor(r);const value=await deps.db.transaction(async tx=>{await reauthorizePartner(tx,deps.clock,a,'imports:read');const result=await agentView(deps,await installationForActor(tx,a),tx);await reauthorizePartner(tx,deps.clock,a,'imports:read');return result;});s.json(value);}));
 router.post('/agent/config-proposals',route(async(r,s)=>{s.json(await proposeAgentConfig(deps,actor(r),r.body));}));
 router.post('/agent/heartbeat',route(async(r,s)=>{const a=actor(r);await reauthorizePartner(deps.db,deps.clock,a,'imports:read');s.json(await heartbeatAgent(deps,a,r.body));}));
 router.post('/agent/credential-renewals',route(async(r,s)=>{s.json(await renewAgentCredential(deps,actor(r),r.header('Idempotency-Key'),r.body));}));
 return router;
}
