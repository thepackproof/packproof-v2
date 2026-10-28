import { searchPartnerProofs } from './proof-search.js';
import { createPartnerProofSnapshot, readPartnerProofSnapshot, releasePartnerProofSnapshot } from './proof-snapshots.js';
import { getProofRecoveryStatus } from '../domain/recovery-journal.js';
import { requirePartnerWebhook, requirePartnerWebhookDelivery, listPartnerWebhooks, listPartnerWebhookDeliveries, readPartnerWebhookDelivery, rotatePartnerWebhookSecret, retryPartnerWebhookDelivery, revokePartnerWebhook } from './partner-webhook-operations.js';
import express, {type Request,type Response,type NextFunction} from 'express';
import { pipeline } from 'node:stream/promises';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { idempotent } from './idempotency.js';
import { consumeApiRate } from './tenants.js';
import { authenticatePartner,reauthorizePartner,authorizePartnerProof,auditOrganization,type PartnerActor,type PartnerScope } from './organizations.js';
import { importPartnerOrder,resolvePartnerProof,readPartnerProof,requestOperatorCapture,addPartnerBinding } from './partner-proofs.js';
import { listEventStream } from './event-stream.js';
import { listPartnerProofs } from './proof-pagination.js';
import { createWebhook,protectWebhookResponse,webhookConfigFromEnv } from './webhooks.js';
import { exportEvidencePackageStream,getEvidenceReview } from '../domain/evidence-review.js';
import { withPartnerReadGrant } from './proof-read-grant.js';
import { guardAuthorizedStream } from '../domain/authorized-stream.js';
import { getProofEnvelope, exportProofEnvelope } from '../integrity/envelope-access.js';

type PartnerRequest=Request & {partnerActor:PartnerActor};
const route=(fn:(req:PartnerRequest,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req as PartnerRequest,res).catch(next);};
export function requirePartnerFeature(){if(process.env.PACKPROOF_ORGANIZATIONS_ENABLED!=='true')throw new DomainError('PARTNER_PLATFORM_DISABLED','Organization API access has not been enabled',503);}
export function createPartnerRouter(deps:AppDependencies){
 const router=express.Router(),config=deps.webhookConfig??webhookConfigFromEnv();
 const historyConfig={signingKey:process.env.PACKPROOF_EVENT_CURSOR_KEY??''};
 router.use((raw,res,next)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('PackProof-API-Profile','packproof.partner/v1');
  try{requirePartnerFeature();}catch(e){next(e);return;}
  const requestId=res.locals.operationId??newId('req');res.setHeader('X-Request-Id',requestId);
  void authenticatePartner(deps.db,deps.clock,raw.header('authorization'),raw.header('PackProof-Merchant-Id'),raw.header('PackProof-Delegation-Id'),requestId)
   .then(async actor=>{await consumeApiRate(deps.db,deps.clock,actor.tenantId);(raw as PartnerRequest).partnerActor=actor;next();}).catch(next);
 });
 function endpoint(method:'get'|'post'|'delete',path:string,scope:PartnerScope,fn:(db:Database,a:PartnerActor,req:PartnerRequest)=>Promise<unknown>,status=200,sensitive=false){
  router[method](path,route(async(req,res)=>{
   const actor=req.partnerActor;
   const check=async(db:Database)=>{
    await reauthorizePartner(db,deps.clock,actor,scope);
    if(req.params.proofId)await authorizePartnerProof(db,deps.clock,actor,req.params.proofId,scope);
    if(req.params.webhookId)await requirePartnerWebhook(db,deps.clock,actor,req.params.webhookId,{active:method==='post',write:method!=='get'});
    if(req.params.deliveryId)await requirePartnerWebhookDelivery(db,deps.clock,actor,req.params.webhookId,req.params.deliveryId);
   };
   await check(deps.db);let result:unknown;
   if(method==='get')result=await fn(deps.db,actor,req);
   else {
    if(sensitive&&Buffer.from(config.encryptionKey,'base64').length!==32)throw new DomainError('SECRET_RESPONSE_UNAVAILABLE','Response encryption is not configured',503);
    const operation=`partner/v1:${actor.environment}:${actor.principalId}:${actor.credentialId}:${actor.delegationGrantId??'direct'}:${method}:${req.path}`;
    const replay=await idempotent(deps.db,deps.clock,actor.tenantId,operation,req.header('Idempotency-Key'),req.body,async tx=>{
      await check(tx);const value=await fn(tx,actor,req);
      await auditOrganization(tx,deps.clock,{actor,requestId:actor.requestId,operation:`${method.toUpperCase()} ${path}`,resourceId:req.params.proofId});return value;
    },sensitive?protectWebhookResponse(`${actor.tenantId}:${operation}:${req.header('Idempotency-Key')}`,config):undefined);
    // A revocation racing the transaction may finish before the result is sent.
    await check(deps.db);res.setHeader('Idempotency-Replayed',String(replay.replayed));result=replay.value;
   }
   if(method==='get')await check(deps.db);
   res.status(status).json(result);
  }));
 }
 router.post('/proof-snapshots',route(async(req,res)=>{
  // Snapshot isolation must be set before any query in a fresh transaction.
  // Do not wrap this bounded reconciliation job in the command replay transaction.
  const result=await createPartnerProofSnapshot(deps.db,deps.clock,req.partnerActor,historyConfig,req.body??{});
  res.status(201).json(result);
 }));
 endpoint('get','/proof-snapshots/:snapshotId','proofs:read',(db,a,r)=>readPartnerProofSnapshot(db,deps.clock,a,r.params.snapshotId,historyConfig,{after:r.query.after}));
 router.delete('/proof-snapshots/:snapshotId',route(async(req,res)=>{
  res.json(await releasePartnerProofSnapshot(deps.db,deps.clock,req.partnerActor,req.params.snapshotId));
 }));
 endpoint('get','/proofs/search','proofs:read',(db,a,r)=>searchPartnerProofs(db,deps.clock,a,r.query,historyConfig.signingKey));
 endpoint('post','/proofs','proofs:write',(db,a,r)=>importPartnerOrder(db,deps.clock,a,r.body),201);
 endpoint('get','/proofs/resolve','proofs:read',(db,a,r)=>resolvePartnerProof(db,deps.clock,a,r.query.integrationAccountId,r.query.externalId));
 endpoint('get','/proofs','proofs:read',(db,a,r)=>listPartnerProofs(db,deps.clock,a,r.query.after,process.env.PACKPROOF_EVENT_CURSOR_KEY??''));
 endpoint('get','/proofs/:proofId/recovery','proofs:read',(db,a,r)=>getProofRecoveryStatus(withPartnerReadGrant(db,deps.clock,a,r.params.proofId,'proofs:read'),a.actorUserId,r.params.proofId));
 endpoint('get','/proofs/:proofId','proofs:read',(db,a,r)=>readPartnerProof(db,deps.clock,a,r.params.proofId));
 endpoint('post','/proofs/:proofId/external-bindings','proofs:write',(db,a,r)=>addPartnerBinding(db,deps.clock,a,r.params.proofId,r.body),201);
 endpoint('post','/proofs/:proofId/capture-intents','capture:request',(db,a,r)=>requestOperatorCapture(db,deps.clock,a,r.params.proofId,r.body),201,true);
 endpoint('get','/proofs/:proofId/review','exports:read',(db,a,r)=>getEvidenceReview(withPartnerReadGrant(db,deps.clock,a,r.params.proofId,'exports:read'),deps.clock,a.actorUserId,r.params.proofId));
 endpoint('get','/proofs/:proofId/integrity-envelopes/:operationId','exports:read',(db,a,r)=>getProofEnvelope(withPartnerReadGrant(db,deps.clock,a,r.params.proofId,'exports:read'),a.actorUserId,r.params.proofId,r.params.operationId,deps.envelopes));
 router.get('/proofs/:proofId/integrity-envelopes/:operationId/package',route(async(req,res)=>{
  const a=req.partnerActor,id=req.params.proofId;await authorizePartnerProof(deps.db,deps.clock,a,id,'exports:read');
  const db=withPartnerReadGrant(deps.db,deps.clock,a,id,'exports:read');
  const stream=await exportProofEnvelope(db,a.actorUserId,id,req.params.operationId,deps.envelopes);
  await auditOrganization(deps.db,deps.clock,{actor:a,requestId:a.requestId,operation:'ENVELOPE_PACKAGE_EXPORT',resourceId:id});
  res.type('application/zip');res.setHeader('Content-Disposition','attachment; filename="packproof-integrity.pkpr"');
  await pipeline(guardAuthorizedStream(stream,()=>reauthorizePartner(deps.db,deps.clock,a,'exports:read')),res);
 }));
 router.get('/proofs/:proofId/package',route(async(req,res)=>{
  const a=req.partnerActor,id=req.params.proofId;await authorizePartnerProof(deps.db,deps.clock,a,id,'exports:read');
  const db=withPartnerReadGrant(deps.db,deps.clock,a,id,'exports:read');
  const stream=await exportEvidencePackageStream(db,deps.clock,deps.objectStore,a.actorUserId,id);
  await auditOrganization(deps.db,deps.clock,{actor:a,requestId:a.requestId,operation:'PACKAGE_EXPORT',resourceId:id});
  res.type('application/zip');res.setHeader('Content-Disposition','attachment; filename="packproof.pkpr"');
  await pipeline(guardAuthorizedStream(stream,()=>reauthorizePartner(deps.db,deps.clock,a,'exports:read')),res);
 }));
 endpoint('get','/event-stream','events:read',(db,a,r)=>listEventStream(db,deps.clock,a,{signingKey:process.env.PACKPROOF_EVENT_CURSOR_KEY??''},{after:r.query.after,limit:r.query.limit}));
 endpoint('post','/webhooks','webhooks:manage',async(db,a,r)=>{
  const webhook=await createWebhook(db,deps.clock,a.tenantId,r.body,config);
  await db.query('INSERT INTO platform_webhook_authorizations(webhook_id,merchant_id,credential_id,delegation_id) VALUES($1,$2,$3,$4)',[webhook.id,a.merchantId,a.credentialId,a.delegationGrantId]);return webhook;
 },201,true);
 endpoint('get','/webhooks','webhooks:manage',(db,a,r)=>listPartnerWebhooks(db,deps.clock,a,historyConfig,{after:r.query.after,limit:r.query.limit}));
 endpoint('get','/webhooks/:webhookId/deliveries','webhooks:manage',(db,a,r)=>listPartnerWebhookDeliveries(db,deps.clock,a,r.params.webhookId,historyConfig,{after:r.query.after,limit:r.query.limit}));
 endpoint('get','/webhooks/:webhookId/deliveries/:deliveryId','webhooks:manage',(db,a,r)=>readPartnerWebhookDelivery(db,deps.clock,a,r.params.webhookId,r.params.deliveryId));
 endpoint('post','/webhooks/:webhookId/rotate-secret','webhooks:manage',(db,a,r)=>rotatePartnerWebhookSecret(db,deps.clock,a,r.params.webhookId,r.body,config),200,true);
 endpoint('post','/webhooks/:webhookId/deliveries/:deliveryId/retry','webhooks:manage',(db,a,r)=>retryPartnerWebhookDelivery(db,deps.clock,a,r.params.webhookId,r.params.deliveryId,r.body));
 endpoint('delete','/webhooks/:webhookId','webhooks:manage',(db,a,r)=>revokePartnerWebhook(db,deps.clock,a,r.params.webhookId));
 router.use((_req,_res,next)=>next(new DomainError('PARTNER_OPERATION_UNSUPPORTED','This service-credential operation is not supported; personal capture and attestations require the operator session',404)));
 router.use(partnerProblem);
 return router;
}
export function partnerProblem(error:unknown,req:Request,res:Response,next:NextFunction){
 if(!(error instanceof DomainError)||res.headersSent){next(error);return;}
 res.status(error.httpStatus).type('application/problem+json').json({type:'about:blank',title:error.code,status:error.httpStatus,detail:error.message,code:error.code,instance:req.originalUrl,requestId:res.getHeader('X-Request-Id')});
}
