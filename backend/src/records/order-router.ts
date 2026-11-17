import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import type {PartnerActor} from '../platform/organizations.js';
import {organizationAdmin} from '../platform/organizations.js';
import {agentWorkspace,type Installation} from './agent-enrollments.js';
import {requireRecordWorkspace} from './access.js';
import {checkedInstallation,workspaceState,proposeScope,readSession,decideSession} from './order-workspace.js';
import {decideAssociation,humanAttentionFilter,deviceAttentionFilter,attention} from './order-review.js';
import {reconcileApiHistory,setApiSourcePaused} from './order-api-history.js';
import {storeDerivation} from './order-derivatives.js';
import {readOrderArtifact} from './order-artifact.js';
import {ingestOrderFile} from './order-ledger.js';
import {agentOrderFilter,humanOrderFilter,listOrders,orderChanges,readOrder} from './order-feed.js';

const route=(fn:(r:Request,s:Response)=>Promise<unknown>)=>(r:Request,s:Response,next:NextFunction)=>void fn(r,s).catch(next);
export function orderHumanRouter(deps:AppDependencies){
 const router=express.Router();
 const sessionPath='/agent-installations/:installationId/order-workspace/:sessionId';
 async function session(r:Request,deciding=false){
  const w=await agentWorkspace(deps,r.headers,r.body?.organizationId??r.query.organizationId,r.body?.environment??r.query.environment,deciding);
  return deps.db.transaction(async tx=>{
   const current=await requireRecordWorkspace(tx,w.userId,w.organizationId,w.environment,deciding);
   await organizationAdmin(tx,w.userId,w.organizationId);
   return deciding?decideSession(tx,deps.clock,current,r.params.installationId,r.params.sessionId,r.body):readSession(tx,deps.clock,current,r.params.installationId,r.params.sessionId);
  });
 }
 router.get(sessionPath,route(async(r,s)=>s.json(await session(r))));
 router.post(sessionPath+'/decision',route(async(r,s)=>s.json(await session(r,true))));
 const read=(fn:(tx:Database,scope:Awaited<ReturnType<typeof humanOrderFilter>>,r:Request)=>Promise<unknown>)=>route(async(r,s)=>{
  const a=await deps.auth.authenticate(r.headers);
  const result=await deps.db.transaction(async tx=>{
   const w=await requireRecordWorkspace(tx,a.userId,r.query.organizationId,r.query.environment);
   return fn(tx,await humanOrderFilter(tx,w,r.query.locationId),r);
  });s.set('Cache-Control','private, no-store').json(result);
 });
 router.get('/order-attention',route(async(r,s)=>{
  const a=await deps.auth.authenticate(r.headers);
  const value=await deps.db.transaction(async tx=>{const w=await requireRecordWorkspace(tx,a.userId,r.query.organizationId,r.query.environment);return attention(tx,await humanAttentionFilter(tx,w,r.query.locationId));});
  s.set('Cache-Control','private, no-store').json(value);
 }));
 router.post('/order-proofs/:proofId/associations',route(async(r,s)=>{
  const a=await deps.auth.authenticate(r.headers);
  const value=await deps.db.transaction(async tx=>{const w=await requireRecordWorkspace(tx,a.userId,r.body?.organizationId,r.body?.environment,true);return decideAssociation(tx,deps.clock,w,r.params.proofId,r.body,r.header('Idempotency-Key'));});
  s.set('Cache-Control','private, no-store').json(value);
 }));
 router.get('/order-proofs',read((tx,f,r)=>listOrders(tx,f,r.query.q,r.query.limit)));
 router.get('/order-changes',read((tx,f,r)=>orderChanges(tx,f,r.query.after,r.query.limit)));
 router.get('/order-proofs/:proofId',read((tx,f,r)=>readOrder(tx,f,r.params.proofId)));
 router.get('/order-proofs/:proofId/revisions/:revision',read((tx,f,r)=>readOrder(tx,f,r.params.proofId,r.params.revision)));
 return router;
}
export function orderAgentRouter(deps:AppDependencies){
 const router=express.Router();
 const call=(fn:(tx:Database,i:Installation,a:PartnerActor,r:Request)=>Promise<unknown>,write=false)=>route(async(r,s)=>{
  const a=(r as Request&{partnerActor:PartnerActor}).partnerActor;
  const result=await deps.db.transaction(async tx=>fn(tx,await checkedInstallation(tx,deps.clock,a,write),a,r));
  s.set('Cache-Control','private, no-store').json(result);
 });
 router.get('/agent/order-workspace',call((tx,i)=>workspaceState(tx,deps.clock,i)));
 router.post('/agent/order-workspace/proposals',call((tx,i,_a,r)=>proposeScope(tx,deps.clock,i,r.body),true));
 router.post('/agent/order-workspace/reconcile-api-source',call((tx,i,a,r)=>reconcileApiHistory(deps,tx,a,i,r.body),true));
 router.post('/agent/order-workspace/api-source-pause',call((tx,i,_a,r)=>setApiSourcePaused(tx,i,r.body),true));
 router.post('/agent/order-workspace/derivatives',call((tx,i,_a,r)=>storeDerivation(tx,i,r.body),true));
 router.post('/agent/order-workspace/observations',call((tx,i,a,r)=>ingestOrderFile(deps,tx,a,i,r.body),true));
 router.get('/agent/order-attention',call(async(tx,i)=>attention(tx,await deviceAttentionFilter(tx,i))));
 router.get('/agent/order-proofs',call(async(tx,i,_a,r)=>listOrders(tx,await agentOrderFilter(tx,i),r.query.q,r.query.limit)));
 router.post('/agent/order-changes',call(async(tx,i,_a,r)=>orderChanges(tx,await agentOrderFilter(tx,i),r.body?.after,r.body?.limit)));
 router.get('/agent/order-proofs/:proofId/revisions/:revision/artifacts/:receiptId',call((tx,i,_a,r)=>readOrderArtifact(deps,tx,i,r.params.proofId,r.params.revision,r.params.receiptId)));
 router.get('/agent/order-proofs/:proofId/revisions/:revision',call(async(tx,i,_a,r)=>readOrder(tx,await agentOrderFilter(tx,i),r.params.proofId,r.params.revision)));
 return router;
}
