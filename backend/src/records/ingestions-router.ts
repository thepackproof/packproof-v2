import express,{type Request,type Response,type NextFunction} from 'express';
import type { AppDependencies } from '../app.js';
import type { PartnerActor } from '../platform/organizations.js';
import { acceptSourceIngestion, readSourceOperation } from './ingestions.js';
import {readPartnerImport} from './partner-imports.js';
import {readCanonicalExport} from './partner-exports.js';
import {readSourceArtifactOperation} from './source-artifacts.js';
import {acceptReferenceObservation,readReferenceObservation,resolveSourceReference} from './source-associations.js';
type PartnerRequest=Request&{partnerActor:PartnerActor};
/** Mount inside the existing authenticated partner router before unsupported. */
export function createPartnerIngestionsRouter(deps:AppDependencies){
 const router=express.Router();
 const run=(fn:(r:PartnerRequest,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r as PartnerRequest,s).catch(n);
 router.post('/ingestions',run(async(r,s)=>{const receipt=await acceptSourceIngestion(deps.db,deps.clock,r.partnerActor,r.body,r.header('Idempotency-Key'));s.setHeader('Location',receipt.links.self);s.status(202).json(receipt);}));
 router.post('/source-references/resolve',run(async(r,s)=>{s.json(await resolveSourceReference(deps.db,deps.clock,r.partnerActor,r.body));}));
 router.post('/source-observations',run(async(r,s)=>{const receipt=await acceptReferenceObservation(deps.db,deps.clock,r.partnerActor,r.body,r.header('Idempotency-Key'));s.setHeader('Location',`/v1/partner/operations/${receipt.id}`);s.status(202).json(receipt);}));
 router.get('/operations/:operationId',run(async(r,s)=>{
  const id=r.params.operationId,a=r.partnerActor;
  if(id.startsWith('association_')){s.json({...await readReferenceObservation(deps.db,deps.clock,a,id),resourceType:'source_association'});return;}
  if(id.startsWith('partner_import_')){s.json({...await readPartnerImport(deps,a,id),operationId:id,resourceType:'import'});return;}
  if(id.startsWith('canonical_export_')){s.json({...await readCanonicalExport(deps,{kind:'PARTNER',actor:a},id),operationId:id,resourceType:'export'});return;}
  if(id.startsWith('source_completion_')){s.json({...await readSourceArtifactOperation(deps.db,deps.clock,{kind:'partner',partner:a},id),resourceType:'source_artifact'});return;}
  s.json({...await readSourceOperation(deps.db,deps.clock,a,id),resourceType:'source_ingestion'});
 }));
 return router;
}
