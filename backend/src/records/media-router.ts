import express,{type Request,type Response,type NextFunction} from 'express';
import {pipeline} from 'node:stream/promises';
import type {AppDependencies} from '../app.js';
import {DomainError} from '../domain/errors.js';
import {guardAuthorizedStream} from '../domain/authorized-stream.js';
import {readCommittedEvidenceStream} from '../domain/evidence.js';
import {exportEvidencePackageStream} from '../domain/evidence-review.js';
import {auditOrganization} from '../platform/organizations.js';
import {newId} from '../ids.js';
import {requireRecordAccess,requireRecordWorkspace,type RecordWorkspace} from './access.js';
import {withRecordReadGrant} from './read-grant.js';

const SAFE_INLINE:Record<string,string>={
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif',
  'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov',
  'audio/mpeg':'mp3','audio/mp4':'m4a','audio/wav':'wav','audio/ogg':'ogg','audio/webm':'webm',
};
export function recordMediaPresentation(contentType:string,evidenceId:string,forceDownload=false) {
  const mime=contentType.split(';')[0].trim().toLowerCase(),extension=SAFE_INLINE[mime];
  const inline=Boolean(extension)&&!forceDownload;
  return {contentType:extension?mime:'application/octet-stream',disposition:`${inline?'inline':'attachment'}; filename="${evidenceId.replace(/[^A-Za-z0-9_-]/g,'')}.${extension??'bin'}"`};
}
export async function authorizeRecordMedia(deps:AppDependencies,workspace:RecordWorkspace,proofId:string) {
  await requireRecordAccess(deps.db,workspace,proofId);
  return withRecordReadGrant(deps.db,workspace,proofId);
}
export async function requireRecordPackageAccess(deps:AppDependencies,workspace:RecordWorkspace,proofId:string) {
  const current=await requireRecordAccess(deps.db,workspace,proofId);
  if(current.partner||!['OWNER','ADMIN'].includes(current.role))throw new DomainError('RECORD_EXPORT_PERMISSION_REQUIRED','An organization owner or administrator must export the full record package',403);
  return current;
}
export function createRecordMediaRouter(deps:AppDependencies) {
  const router=express.Router();
  const route=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(error=>{
    if(s.headersSent||s.destroyed){s.destroy();return;}n(error);
  });};
  router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');s.setHeader('Referrer-Policy','no-referrer');n();});
  async function workspace(r:Request) {
    const auth=await deps.auth.authenticate(r.headers);
    return requireRecordWorkspace(deps.db,auth.userId,r.query.organizationId,r.query.environment);
  }
  function secureResponse(s:Response) {
    s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');
    s.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; frame-ancestors 'none'");
    s.setHeader('X-Frame-Options','DENY');s.setHeader('Referrer-Policy','no-referrer');
  }
  async function audit(w:RecordWorkspace,proofId:string,operation:string,resourceId=proofId) {
    await auditOrganization(deps.db,deps.clock,{userId:w.userId,merchantId:w.organizationId,requestId:newId('req'),operation,resourceId});
  }
  router.get('/:proofId/evidence/:evidenceId/blob',route(async(r,s)=>{
    const w=await workspace(r),proofId=r.params.proofId,evidenceId=r.params.evidenceId;
    const granted=await authorizeRecordMedia(deps,w,proofId);
    const media=await readCommittedEvidenceStream(granted,deps.objectStore,w.userId,proofId,evidenceId,r.header('Range'));
    try{
    await requireRecordAccess(deps.db,w,proofId);
    await audit(w,proofId,'RECORD_ORIGINAL_DOWNLOAD_REQUESTED',evidenceId);
    secureResponse(s);
    for(const [key,value] of Object.entries(media.headers))if(!['content-type','content-disposition','content-security-policy'].includes(key.toLowerCase()))s.setHeader(key,value);
    const presentation=recordMediaPresentation(media.contentType,evidenceId,r.query.download==='true');
    s.setHeader('Content-Type',presentation.contentType);s.setHeader('Content-Disposition',presentation.disposition);
    s.setHeader('X-Artifact-Sha256',media.sha256);s.status(media.status);
    if(!media.body){s.end();return;}
    // Existing original-byte pipeline pins the preserved object version and
    // guards current authorization. This outer gateway guard also limits the
    // bytes admitted between organization/location revocation checks.
    await pipeline(guardAuthorizedStream(media.body,()=>requireRecordAccess(deps.db,w,proofId).then(()=>undefined)),s);
    await audit(w,proofId,'RECORD_ORIGINAL_DOWNLOAD_COMPLETED',evidenceId);
    }finally{media.body?.destroy();}
  }));
  router.get('/:proofId/package',route(async(r,s)=>{
    const w=await workspace(r),proofId=r.params.proofId;
    await requireRecordPackageAccess(deps,w,proofId);
    const granted=await authorizeRecordMedia(deps,w,proofId);
    const state=(await deps.db.query<{status:string;manifest_id:string|null}>('SELECT status,manifest_id FROM proofs WHERE id=$1',[proofId])).rows[0];
    if(state?.status!=='FINALIZED'||!state.manifest_id)throw new DomainError('SNAPSHOT_NOT_AVAILABLE','Finalize the canonical capture record before downloading its evidence package',409);
    const stream=await exportEvidencePackageStream(granted,deps.clock,deps.objectStore,w.userId,proofId,{organizationDisclosure:{organizationId:w.organizationId,environment:w.environment,membershipId:w.membershipId}});
    try{
    await requireRecordPackageAccess(deps,w,proofId);await audit(w,proofId,'RECORD_CORE_PACKAGE_DOWNLOAD_REQUESTED');
    secureResponse(s);s.type('application/zip');s.setHeader('Content-Disposition',`attachment; filename="packproof-${proofId.replace(/[^A-Za-z0-9_-]/g,'')}.pkpr"`);
    s.setHeader('PackProof-Package-Scope','canonical-proof-v1');
    await pipeline(guardAuthorizedStream(stream,()=>requireRecordPackageAccess(deps,w,proofId).then(()=>undefined)),s);
    await audit(w,proofId,'RECORD_CORE_PACKAGE_DOWNLOAD_COMPLETED');
    }finally{stream.destroy();}
  }));
  return router;
}
