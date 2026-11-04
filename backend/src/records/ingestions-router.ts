import express,{type Request,type Response,type NextFunction} from 'express';
import type { AppDependencies } from '../app.js';
import type { PartnerActor } from '../platform/organizations.js';
import { acceptSourceIngestion, readSourceOperation } from './ingestions.js';
type PartnerRequest=Request&{partnerActor:PartnerActor};
/** Mount inside the existing authenticated partner router before unsupported. */
export function createPartnerIngestionsRouter(deps:AppDependencies){
 const router=express.Router();
 const run=(fn:(r:PartnerRequest,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r as PartnerRequest,s).catch(n);
 router.post('/ingestions',run(async(r,s)=>{const receipt=await acceptSourceIngestion(deps.db,deps.clock,r.partnerActor,r.body,r.header('Idempotency-Key'));s.setHeader('Location',receipt.links.self);s.status(202).json(receipt);}));
 router.get('/operations/:operationId',run(async(r,s)=>{s.json(await readSourceOperation(deps.db,deps.clock,r.partnerActor,r.params.operationId));}));
 return router;
}
