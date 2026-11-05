import express,{type Request,type Response,type NextFunction} from 'express';
import {pipeline} from 'node:stream/promises';
import type {AppDependencies} from '../app.js';
import type {PartnerActor} from '../platform/organizations.js';
import {strictBody} from '../platform/organizations.js';
import {requestByteLength} from '../domain/media-admission.js';
import {DomainError} from '../domain/errors.js';
import {requireRecordWorkspace} from './access.js';
import {recordMediaPresentation} from './media-router.js';
import {initializeSourceArtifact,readSourceUploadSession,receiveSourceArtifactBytes,assembleSourceArtifactParts,completeSourceArtifact,readSourceArtifactOperation,listSourceArtifacts,readSourceArtifactStream,readPartnerArtifactOrEvidenceStream,SOURCE_ARTIFACT_LIMITS,type SourceArtifactActor} from './source-artifacts.js';

type PartnerRequest=Request&{partnerActor:PartnerActor};
const run=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(error=>{if(s.headersSent||s.destroyed)s.destroy();else n(error);});};
function routes(deps:AppDependencies,human:boolean) {
 const router=express.Router(),prefix=human?'/source-upload-sessions':'/upload-sessions';
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');s.setHeader('Referrer-Policy','no-referrer');n();});
 async function actor(r:Request,write=true):Promise<SourceArtifactActor> {
  if(!human)return {kind:'partner',partner:(r as PartnerRequest).partnerActor};
  const auth=await deps.auth.authenticate(r.headers);
  return {kind:'human',workspace:await requireRecordWorkspace(deps.db,auth.userId,r.query.organizationId,r.query.environment,write)};
 }
 router.post(prefix,run(async(r,s)=>{const a=await actor(r),result=await initializeSourceArtifact(deps.db,deps.clock,a,r.body,r.header('Idempotency-Key'));s.setHeader('Idempotency-Replayed',String(result.replayed));s.setHeader('Location',result.upload.url.replace(/\/bytes(?=\?|$)/,''));s.status(201).json(result);}));
 router.get(`${prefix}/:sessionId`,run(async(r,s)=>{s.json(await readSourceUploadSession(deps.db,deps.clock,await actor(r),r.params.sessionId));}));
 router.get(`${prefix}/:sessionId/parts`,run(async(r,s)=>{s.json(await readSourceUploadSession(deps.db,deps.clock,await actor(r),r.params.sessionId));}));
 function upload(part:boolean){return run(async(r,s)=>{
  const a=await actor(r),state=await readSourceUploadSession(deps.db,deps.clock,a,r.params.sessionId);
  if(r.header('Content-Type')?.split(';')[0].trim().toLowerCase()!==state.contentType)throw new DomainError('UPLOAD_CONTENT_TYPE_MISMATCH','Upload Content-Type must match the immutable reservation',422);
  const length=requestByteLength(r,part?SOURCE_ARTIFACT_LIMITS.partSize:SOURCE_ARTIFACT_LIMITS.maximumBytes);
  r.setTimeout(SOURCE_ARTIFACT_LIMITS.ingressLifetimeMs,()=>r.destroy());
  s.json(await receiveSourceArtifactBytes(deps.db,deps.clock,deps.objectStore,a,r.params.sessionId,r,length,part?Number(r.params.partNumber):undefined));
 });}
 router.put(`${prefix}/:sessionId/bytes`,upload(false));
 router.put(`${prefix}/:sessionId/parts/:partNumber`,upload(true));
 router.post(`${prefix}/:sessionId/parts/complete`,run(async(r,s)=>{strictBody(r.body??{},[]);s.json(await assembleSourceArtifactParts(deps.db,deps.clock,deps.objectStore,await actor(r),r.params.sessionId));}));
 router.post(`${prefix}/:sessionId/complete`,run(async(r,s)=>{strictBody(r.body??{},[]);const result=await completeSourceArtifact(deps.db,deps.clock,await actor(r),r.params.sessionId);s.setHeader('Location',result.links.self);s.status(202).json(result);}));
 router.get(human?'/source-artifact-operations/:operationId':'/artifact-operations/:operationId',run(async(r,s)=>{s.json(await readSourceArtifactOperation(deps.db,deps.clock,await actor(r),r.params.operationId));}));
 router.get(human?'/:proofId/source-artifacts':'/proofs/:proofId/source-artifacts',run(async(r,s)=>{s.json(await listSourceArtifacts(deps.db,deps.clock,await actor(r,false),r.params.proofId,r.query));}));
 async function download(r:Request,s:Response) {
  const a=await actor(r,false),media=human?await readSourceArtifactStream(deps.db,deps.clock,deps.objectStore,a,r.params.artifactId,r.header('Range'),r.params.proofId):await readPartnerArtifactOrEvidenceStream(deps.db,deps.clock,deps.objectStore,(a as {kind:'partner';partner:PartnerActor}).partner,r.params.artifactId,r.header('Range'));
  try{
   for(const [key,value]of Object.entries(media.headers))if(!['content-type','content-disposition','content-security-policy'].includes(key.toLowerCase()))s.setHeader(key,value);
   const presentation=recordMediaPresentation(media.contentType,r.params.artifactId,true);
   s.setHeader('Content-Type',presentation.contentType);s.setHeader('Content-Disposition',presentation.disposition);
   s.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; frame-ancestors 'none'");s.setHeader('X-Frame-Options','DENY');s.setHeader('X-Artifact-Sha256',media.sha256);
   s.status(media.status);if(!media.body){s.end();return;}await pipeline(media.body,s);
  }finally{media.body?.destroy();}
 }
 if(human)router.get('/:proofId/source-artifacts/:artifactId/blob',run(download));
 else router.post('/evidence/:artifactId/download',run(async(r,s)=>{strictBody(r.body??{},[]);await download(r,s);}));
 return router;
}
/** Mount inside the authenticated partner router, before unsupported families. */
export function createPartnerArtifactsRouter(deps:AppDependencies){return routes(deps,false);}
/** Mount at /me/records before the generic /:proofId route. */
export function createSourceArtifactsRouter(deps:AppDependencies){return routes(deps,true);}
