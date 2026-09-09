import express,{type Request,type Response,type NextFunction} from 'express';
import type { AppDependencies } from '../app.js';
import { DomainError } from '../domain/errors.js';
import { finalizeProof, getManifest } from '../domain/finalize.js';
import { issueIntent,bindIntent,sealCapture,receiveBatch,captureStatus,captureCapsules,asDomainError } from './service.js';
const route=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(e=>n(asDomainError(e)));};
function actor(r:Request){if(!r.packproofUserId)throw new DomainError('UNAUTHENTICATED','Sign in to open this recording',401);return r.packproofUserId;}
export function captureEngineRouter(deps:AppDependencies){
 const router=express.Router();router.use((_r,s,n)=>{s.setHeader('Cache-Control','no-store');s.setHeader('Referrer-Policy','no-referrer');n();});
 router.post('/capture-intents',route(async(r,s)=>{s.status(201).json(await issueIntent(deps.db,deps.clock,actor(r),String(r.body?.proofId??''),r.body?.allowedSurfaces));}));
 router.post('/capture-sessions/bind',route(async(r,s)=>{s.status(201).json(await bindIntent(deps.db,deps.clock,actor(r),r.body));}));
 router.post('/capture-sessions/:captureId/receipts',route(async(r,s)=>{s.json(await receiveBatch(deps.db,deps.clock,actor(r),r.params.captureId,r.body));}));
 router.post('/capture-sessions/:captureId/seal',route(async(r,s)=>{s.json(await sealCapture(deps.db,deps.clock,actor(r),r.params.captureId,r.body));}));
 router.get('/capture-sessions/:captureId/status',route(async(r,s)=>{s.json(await captureStatus(deps.db,actor(r),r.params.captureId));}));
 router.get('/capture-sessions/:captureId/receipt',route(async(r,s)=>{
   const status=await captureStatus(deps.db,actor(r),r.params.captureId);const manifest=await getManifest(deps.db,actor(r),status.proofId);
   s.json({schema:'packproof.capture-receipt/1',...status,proofManifest:manifest});
 }));
 router.post('/capture-sessions/:captureId/finalize',route(async(r,s)=>{
   const status=await captureStatus(deps.db,actor(r),r.params.captureId);
   if(!["COMMITTED","FINALIZED"].includes(status.state)) throw new DomainError("CAPTURE_SOURCE_REQUIRED","This recording must be committed before its Proof can be finalized",409);
   const result=await finalizeProof(deps.db,deps.clock,actor(r),status.proofId,deps.manifestSigning?.signer,{requireDurableReceipts:deps.requireDurableReceipts===true});
   s.json({schema:'packproof.capture-receipt/1',captureId:status.captureId,proofId:status.proofId,state:result.proof.status,manifestSha256:status.manifestSha256,proofManifest:result.manifest});
 }));
 router.get('/proofs/:id/capture-capsule',route(async(r,s)=>{s.json(await captureCapsules(deps.db,actor(r),r.params.id));}));
 return router;
}
