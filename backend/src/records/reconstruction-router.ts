import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import {DomainError} from '../domain/errors.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {textField} from '../platform/tenants.js';
import {organizationAdmin,type PartnerActor} from '../platform/organizations.js';
import {requireRecordWorkspace} from './access.js';
import {reconstructionFeatureEnabled,requireReconstructionFeature} from './reconstruction-features.js';
import {listOperationalCases,getOperationalCase} from './reconstruction.js';
import {approveCaseCrosswalk} from './cases.js';
import {previewTypedImport,commitTypedImport,readTypedImport,readTypedImportRecordSubset,resumeTypedImport} from './typed-imports.js';
import {SOURCE_PROFILES,TYPED_SOURCE_LIMITS,SOURCE_CONTRACT_VERSION} from './source-profiles.js';
import {listSourceSubscriptions,getSourceSubscription,proposeSourceSubscription,actOnSourceSubscription,listAgentSourceSubscriptions,heartbeatSourceSubscription,proposeAgentSourceSubscription} from './source-subscriptions.js';
import {readCaseAssertionSource,exportOperationalCase} from './reconstruction-exports.js';
import {listOperationalCaseIssues,actOnOperationalCaseIssue,pageOperationalCaseIssueHistory} from './reconstruction-issues.js';
import {readSourceRetentionReview,actOnSourceRetention} from './source-retention.js';

const run=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r,s).catch(n);
export function createReconstructionHumanRouter(deps:AppDependencies){
 const router=express.Router();
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
 async function workspace(r:Request,write=false){const a=await deps.auth.authenticate(r.headers);return requireRecordWorkspace(deps.db,a.userId,r.query.organizationId??r.body?.organizationId,r.query.environment??r.body?.environment,write);}
 router.get('/cases',run(async(r,s)=>{s.json(await listOperationalCases(deps.db,deps.clock,await workspace(r),r.query));}));
 router.get('/cases/:caseId',run(async(r,s)=>{s.json(await getOperationalCase(deps.db,deps.clock,await workspace(r),r.params.caseId,r.query));}));
 router.get('/cases/:caseId/issues',run(async(r,s)=>{s.json(await listOperationalCaseIssues(deps.db,deps.clock,await workspace(r),r.params.caseId,r.query));}));
 router.get('/cases/:caseId/issues/:issueId/history',run(async(r,s)=>{s.json(await pageOperationalCaseIssueHistory(deps.db,deps.clock,await workspace(r),r.params.caseId,r.params.issueId,r.query));}));
 router.post('/cases/:caseId/issues/:issueId/actions',run(async(r,s)=>{s.json(await actOnOperationalCaseIssue(deps.db,deps.clock,await workspace(r,true),r.params.caseId,r.params.issueId,r.body,r.header('Idempotency-Key')));}));
 router.get('/cases/:caseId/assertions/:assertionId/source',run(async(r,s)=>{s.json(await readCaseAssertionSource(deps,await workspace(r),r.params.caseId,r.params.assertionId));}));
 router.get('/cases/:caseId/export',run(async(r,s)=>{
  const result=await exportOperationalCase(deps,await workspace(r),r.params.caseId);
  s.setHeader('Content-Type','application/json; charset=utf-8');s.setHeader('Content-Disposition',`attachment; filename="${result.filename}"`);s.setHeader('X-Content-SHA256',result.sha256);s.setHeader('PackProof-Export-Profile',result.profile);s.send(result.bytes);
 }));
 router.post('/cases/crosswalks',run(async(r,s)=>{s.json(await approveCaseCrosswalk(deps.db,deps.clock,await workspace(r,true),r.body,r.header('Idempotency-Key')));}));
 router.get('/source-subscriptions',run(async(r,s)=>{s.json(await listSourceSubscriptions(deps.db,await workspace(r),r.query));}));
 router.get('/source-subscriptions/:subscriptionId',run(async(r,s)=>{s.json(await getSourceSubscription(deps.db,await workspace(r),r.params.subscriptionId,r.query.initialBatchId));}));
 router.get('/source-batches/:batchId/retention',run(async(r,s)=>{s.json(await readSourceRetentionReview(deps,await workspace(r),r.params.batchId));}));
 router.post('/source-batches/:batchId/retention/actions',run(async(r,s)=>{const result=await actOnSourceRetention(deps,await workspace(r,true),r.params.batchId,r.body,r.header('Idempotency-Key'));s.setHeader('Idempotency-Replayed',String(result.replayed));s.json(result.value);}));
 async function sourceCommand(r:Request,s:Response,action:boolean){
  requireReconstructionFeature('sourceSubscriptions');
  const w=await workspace(r,true),operation=`operational-source:${r.path}`,keyHash=sha256Hex(textField(r.header('Idempotency-Key'),'Idempotency-Key')),requestHash=sha256Hex(canonicalize(r.body));
  const result=await deps.db.transaction(async tx=>{
   const current=await requireRecordWorkspace(tx,w.userId,w.organizationId,w.environment,true);await organizationAdmin(tx,current.userId,current.organizationId);
   await tx.query('INSERT INTO platform_command_results(actor_user_id,operation,key_hash,request_hash,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[current.userId,operation,keyHash,requestHash,deps.clock.now().toISOString()]);
   const prior=(await tx.query<{request_hash:string;response:{id:string}|null}>('SELECT request_hash,response FROM platform_command_results WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3 FOR UPDATE',[current.userId,operation,keyHash])).rows[0];
   if(prior.request_hash!==requestHash)throw new DomainError('IDEMPOTENCY_CONFLICT','This command key was already used for different source choices',409);
   if(prior.response!==null){s.setHeader('Idempotency-Replayed','true');await getSourceSubscription(tx,current,prior.response.id);return prior.response;}
   const value=action?await actOnSourceSubscription(tx,deps.clock,current,r.params.subscriptionId,r.body,newId('source_request')):await proposeSourceSubscription(tx,deps.clock,current,r.body,newId('source_request'));
   const response={id:value.id};await tx.query('UPDATE platform_command_results SET response=$4::jsonb WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3',[current.userId,operation,keyHash,JSON.stringify(response)]);return response;
  });
  // Cached commands return the current scope/state, never a stale active grant.
  s.json(await getSourceSubscription(deps.db,await workspace(r),result.id,r.body.initialBatchId));
 }
 router.post('/source-subscriptions',run((r,s)=>sourceCommand(r,s,false)));
 router.post('/source-subscriptions/:subscriptionId/actions',run((r,s)=>sourceCommand(r,s,true)));
 return router;
}
export function createReconstructionPartnerRouter(deps:AppDependencies){
 const router=express.Router(),actor=(r:Request)=>(r as Request&{partnerActor:PartnerActor}).partnerActor;
 router.get('/source-profiles',run(async(_r,s)=>{requireReconstructionFeature('typedIntake');s.json({schema:SOURCE_CONTRACT_VERSION,profiles:SOURCE_PROFILES,limits:TYPED_SOURCE_LIMITS,capabilities:{typedIntake:reconstructionFeatureEnabled('typedIntake'),sourceSubscriptions:reconstructionFeatureEnabled('sourceSubscriptions'),multiSourceAgent:reconstructionFeatureEnabled('multiSourceAgent')}});}));
 router.get('/source-subscriptions',run(async(r,s)=>{s.json(await listAgentSourceSubscriptions(deps.db,deps.clock,actor(r),r.query));}));
 router.post('/source-subscriptions/proposals',run(async(r,s)=>{s.status(202).json(await proposeAgentSourceSubscription(deps.db,deps.clock,actor(r),r.body,r.header('Idempotency-Key')));}));
 router.post('/source-subscriptions/:subscriptionId/heartbeat',run(async(r,s)=>{s.json(await heartbeatSourceSubscription(deps.db,deps.clock,actor(r),r.params.subscriptionId,r.body,r.header('Idempotency-Key')));}));
 router.post('/typed-imports/preview',run(async(r,s)=>{const result=await previewTypedImport(deps,actor(r),r.body,r.header('Idempotency-Key'));s.setHeader('Idempotency-Replayed',String(result.replayed));s.status(201).json(result.value);}));
 router.get('/typed-imports/:importId',run(async(r,s)=>{s.json(await readTypedImport(deps,actor(r),r.params.importId));}));
 router.get('/typed-imports/:importId/record',run(async(r,s)=>{s.json(await readTypedImportRecordSubset(deps,actor(r),r.params.importId));}));
 router.post('/typed-imports/:importId/reconcile',run(async(r,s)=>{s.status(202).json(await resumeTypedImport(deps,actor(r),r.params.importId,r.header('Idempotency-Key')));}));
 router.post('/typed-imports/:importId/commit',run(async(r,s)=>{const result=await commitTypedImport(deps,actor(r),r.params.importId,r.body,r.header('Idempotency-Key'));s.setHeader('Idempotency-Replayed',String(result.replayed));s.status(202).json(result.value);}));
 const partnerWorkspace=(r:Request)=>{const a=actor(r);return {organizationId:a.merchantId,environment:a.environment,tenantId:a.tenantId,membershipId:'',userId:a.actorUserId,role:'OPERATOR' as const,enabled:true,locationScoped:false,partner:a,authorizationClock:deps.clock};};
 router.get('/cases',run(async(r,s)=>{s.json(await listOperationalCases(deps.db,deps.clock,partnerWorkspace(r),r.query));}));
 router.get('/cases/:caseId',run(async(r,s)=>{s.json(await getOperationalCase(deps.db,deps.clock,partnerWorkspace(r),r.params.caseId,r.query));}));
 return router;
}
