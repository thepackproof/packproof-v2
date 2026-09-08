import express, {type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import {DomainError} from '../domain/errors.js';
import {intakeEnabled} from '../intake/runtime-config.js';
import {getIntakeSnapshot,readApprovedIntakeSnapshot,submitIntakeObservation,prepareExistingIntakeOrder,listIntakeOrders,pinIntakeSnapshotForCapture,type IntakeObservationInput,type IntakeScope} from '../intake/context.js';
import {registerIntakeDevice,approveIntakeDevice,listIntakeDevices,revokeIntakeDevice,createIntakeHandoff,listIntakeHandoffs,claimIntakeHandoff,releaseIntakeDevice} from '../intake/handoffs.js';
import {createMailAlias,listMailSetup,revokeMailAlias,acknowledgeMailVerification,replayMailReceipt} from '../intake/mail.js';
import {createCaptureSession,loadCaptureSession,captureSessionView} from '../domain/capture-sessions.js';
import {resolveIntakeIssue} from '../intake/context.js';
const route=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};
function actor(req:Request):string{if(!req.packproofUserId)throw new DomainError('UNAUTHENTICATED','Sign in to prepare an order.',401);return req.packproofUserId;}
function token(req:Request):string{return req.header('x-intake-device-token')||'';}
function text(value:unknown):string{return typeof value==='string'?value:'';}
function admit(deps:AppDependencies,user:string,feature?:'handoffEnabled'|'browserEnabled'|'emailEnabled'){
  if(!intakeEnabled(deps.intake,user)||(feature&&!deps.intake?.[feature]))throw new DomainError('INTAKE_PAUSED','New order intake is paused. Existing recordings remain available.',409);
}
async function mappedScope(deps:AppDependencies,user:string,connectionId:string):Promise<IntakeScope>{
  const c=(await deps.db.query<{provider:string;external_account_reference:string}>("SELECT provider,external_account_reference FROM integration_connections WHERE id=$1 AND owner_user_id=$2 AND status='ACTIVE'",[connectionId,user])).rows[0];
  if(!c?.external_account_reference||!['ebay','etsy','shopify'].includes(c.provider))throw new DomainError('INTAKE_SCOPE_UNVERIFIED','Choose the connected store that owns this order.',409);
  return {provider:c.provider,externalAccountReference:c.external_account_reference,namespaceSource:c.provider==='shopify'?'STOREFRONT_API':'MARKETPLACE_API',connectionId,store:c.external_account_reference,verified:true};
}
export function intakeRouter(deps:AppDependencies){
  const router=express.Router();
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
  router.get('/capabilities',route(async(req,res)=>{
    const enabled=intakeEnabled(deps.intake,actor(req));
    res.json({enabled,handoffEnabled:enabled&&!!deps.intake?.handoffEnabled,browserEnabled:enabled&&!!deps.intake?.browserEnabled,emailEnabled:enabled&&!!deps.intake?.emailEnabled,shippoEnabled:enabled&&!!deps.intake?.shippoEnabled,mailDomainConfigured:!!deps.intake?.mailDomain});
  }));
  router.get('/orders',route(async(req,res)=>{res.json({orders:await listIntakeOrders(deps.db,actor(req))});}));
  router.get('/observations/:id',route(async(req,res)=>{
    const row=(await deps.db.query<{context:IntakeObservationInput;result:{reasons:string[]}}>('SELECT o.context,r.result FROM intake_source_observations o JOIN intake_delivery_receipts r ON r.observation_id=o.id WHERE o.id=$1 AND o.actor_user_id=$2',[req.params.id,actor(req)])).rows[0];
    if(!row)throw new DomainError('INTAKE_OBSERVATION_NOT_FOUND','This order source is not available.',404);
    const {items,physicalFulfillment,paid,fulfillmentScope,orderReference}=row.context;
    res.json({observationId:req.params.id,items,physicalFulfillment,paid,fulfillmentScope,orderReference,reasonCodes:row.result.reasons});
  }));
  router.post('/observations/:id/resolve',route(async(req,res)=>{
    const user=actor(req);
    const observation=(await deps.db.query<{proof_id:string|null}>('SELECT proof_id FROM intake_delivery_receipts WHERE observation_id=$1 AND actor_user_id=$2',[req.params.id,user])).rows[0];
    if(!observation)throw new DomainError('INTAKE_OBSERVATION_NOT_FOUND','This order source is not available.',404);
    // Bound corrections recover admitted work. An unbound observation would create a new Proof.
    if(!observation.proof_id)admit(deps,user);
    res.json(await resolveIntakeIssue(deps.db,deps.clock,user,req.params.id,{receiptId:text(req.body?.receiptId),items:req.body?.items,physicalFulfillment:req.body?.physicalFulfillment,paid:req.body?.paid,fulfillmentScope:req.body?.fulfillmentScope,reason:text(req.body?.reason)}));
  }));
  router.post('/orders/prepare',route(async(req,res)=>{const user=actor(req);admit(deps,user);res.json(await prepareExistingIntakeOrder(deps.db,deps.clock,user,text(req.body?.transactionId)));}));
  router.post('/orders/:snapshotId/capture',route(async(req,res)=>{
    const user=actor(req),idempotencyKey=text(req.body?.idempotencyKey),client=text(req.body?.client);
    const result=await deps.db.transaction(async tx=>{
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user]);
      const snapshot=await getIntakeSnapshot(tx,user,req.params.snapshotId);
      const existing=(await tx.query<{id:string;client:string;order_snapshot_id:string}>('SELECT id,client,order_snapshot_id FROM capture_sessions WHERE proof_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',[snapshot.proofId,user,idempotencyKey])).rows[0];
      if(existing){
        if(existing.client!==client||existing.order_snapshot_id!==snapshot.id)throw new DomainError('INTAKE_CAPTURE_CONFLICT','This retry belongs to another recording.',409);
        return {session:captureSessionView(await loadCaptureSession(tx,user,snapshot.proofId,existing.id)),proofId:snapshot.proofId,transactionId:snapshot.transactionId,orderSnapshot:snapshot};
      }
      admit(deps,user);
      await readApprovedIntakeSnapshot(tx,user,snapshot.id);
      const session=await createCaptureSession(tx,deps.clock,user,snapshot.proofId,{idempotencyKey,client});
      await pinIntakeSnapshotForCapture(tx,deps.clock,user,session.id,snapshot.id);
      return {session,proofId:snapshot.proofId,transactionId:snapshot.transactionId,orderSnapshot:snapshot};
    });res.json(result);
  }));
  router.post('/observations',route(async(req,res)=>{
    const user=actor(req);admit(deps,user,'browserEnabled');
    const event=req.body,scope=await mappedScope(deps,user,text(event?.connectionId));
    if(scope.provider!=='ebay'||event?.pageAccountReference!==scope.externalAccountReference||event?.ownerId!==user||event?.adapterKey!=='ebay-seller-order-en-US'||event?.adapterVersion!=='1')throw new DomainError('INTAKE_SCOPE_CONFLICT','This page does not match the connected store. Open the supported single-order page.',409);
    let sourceUrl:URL;try{sourceUrl=new URL(text(event.sourceUrl));}catch{throw new DomainError('INTAKE_PAGE_UNSUPPORTED','This order page is not supported.',422);}
    if(sourceUrl.protocol!=='https:'||!['www.ebay.com','www.sandbox.ebay.com'].includes(sourceUrl.hostname))throw new DomainError('INTAKE_PAGE_UNSUPPORTED','This order page is not supported.',422);
    if(typeof event.sourceExcerpt!=='string'||!event.sourceExcerpt.trim()||event.sourceExcerpt.length>20000)throw new DomainError('INTAKE_SOURCE_REQUIRED','The order page excerpt is missing or too large.',422);
    const input:IntakeObservationInput={...event.observation,receiptId:text(event.eventId),sourceKind:'BROWSER_CAPTURED',adapterKey:'ebay-seller-order-en-US',adapterVersion:'1',rawSourceRef:null};
    // The shared observation retains the bounded excerpt privately; public views use only its digest.
    Object.assign(input,{sourceText:event.sourceExcerpt});
    res.json(await submitIntakeObservation(deps.db,deps.clock,user,input,scope));
  }));
  router.get('/devices',route(async(req,res)=>{res.json(await listIntakeDevices(deps.db,deps.clock,actor(req)));}));
  router.post('/devices',route(async(req,res)=>{const user=actor(req);admit(deps,user,'handoffEnabled');res.status(201).json(await registerIntakeDevice(deps.db,deps.clock,user,{name:text(req.body?.name)}));}));
  router.post('/devices/:id/approve',route(async(req,res)=>{const user=actor(req);admit(deps,user,'handoffEnabled');res.json(await approveIntakeDevice(deps.db,deps.clock,user,req.params.id,text(req.body?.pairingCode)));}));
  router.delete('/devices/:id',route(async(req,res)=>{res.json(await revokeIntakeDevice(deps.db,deps.clock,actor(req),req.params.id));}));
  router.post('/devices/:id/revoke',route(async(req,res)=>{res.json(await revokeIntakeDevice(deps.db,deps.clock,actor(req),req.params.id));}));
  router.post('/devices/:id/release',route(async(req,res)=>{res.json(await releaseIntakeDevice(deps.db,deps.clock,actor(req),req.params.id,{deviceToken:token(req),captureSessionId:text(req.body?.captureSessionId)}));}));
  router.get('/handoffs',route(async(req,res)=>{
    const user=actor(req);const result=await listIntakeHandoffs(deps.db,deps.clock,user,{deviceId:text(req.query.deviceId),deviceToken:token(req)});
    // Flag-off still reconciles an active session; it stops delivery of fresh prompts.
    res.json({...result,handoffs:intakeEnabled(deps.intake,user)&&deps.intake?.handoffEnabled?result.handoffs:[]});
  }));
  router.post('/handoffs',route(async(req,res)=>{const user=actor(req);admit(deps,user,'handoffEnabled');res.status(201).json(await createIntakeHandoff(deps.db,deps.clock,user,{snapshotId:text(req.body?.snapshotId),targetDeviceId:text(req.body?.targetDeviceId),idempotencyKey:text(req.body?.idempotencyKey),eventId:req.body?.eventId}));}));
  router.post('/handoffs/:id/claim',route(async(req,res)=>{
    const user=actor(req);
    if(!intakeEnabled(deps.intake,user)||!deps.intake?.handoffEnabled){
      const claimed=(await deps.db.query('SELECT id FROM intake_handoffs WHERE id=$1 AND actor_user_id=$2 AND state=\'CLAIMED\'',[req.params.id,user])).rows[0];
      if(!claimed)admit(deps,user,'handoffEnabled');
    }
    res.json(await claimIntakeHandoff(deps.db,deps.clock,user,req.params.id,{deviceId:text(req.body?.deviceId),deviceToken:token(req),idempotencyKey:text(req.body?.idempotencyKey),client:text(req.body?.client)}));
  }));
  router.get('/mail',route(async(req,res)=>{res.json({aliases:await listMailSetup(deps.db,deps.clock,actor(req))});}));
  router.post('/mail',route(async(req,res)=>{const user=actor(req);admit(deps,user,'emailEnabled');if(!deps.intake?.mailDomain)throw new DomainError('MAIL_NOT_CONFIGURED','Order email forwarding is not configured yet.',503);res.status(201).json({alias:await createMailAlias(deps.db,deps.clock,{ownerUserId:user,connectionId:text(req.body?.connectionId),domain:deps.intake.mailDomain})});}));
  router.delete('/mail/:id',route(async(req,res)=>{res.json({alias:await revokeMailAlias(deps.db,deps.clock,actor(req),req.params.id)});}));
  router.post('/mail/:id/revoke',route(async(req,res)=>{res.json({alias:await revokeMailAlias(deps.db,deps.clock,actor(req),req.params.id)});}));
  router.post('/mail/:id/verify',route(async(req,res)=>{res.json({alias:await acknowledgeMailVerification(deps.db,deps.clock,actor(req),req.params.id,text(req.body?.challengeId))});}));
  router.post('/mail/:id/replay',route(async(req,res)=>{const user=actor(req);admit(deps,user,'emailEnabled');res.json(await replayMailReceipt(deps.db,deps.clock,user,req.params.id,text(req.body?.receiptId)));}));
  return router;
}
