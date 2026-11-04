import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import {requireRecordWorkspace} from './access.js';
import {actOnRecordConnection,readRecordConnectionOperation} from './connections.js';
export function createRecordConnectionsRouter(deps:AppDependencies){
 const router=express.Router();
 const route=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r,s).catch(n);
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
 async function workspace(req:Request,write=false){const auth=await deps.auth.authenticate(req.headers);return requireRecordWorkspace(deps.db,auth.userId,req.body?.organizationId??req.query.organizationId,req.body?.environment??req.query.environment,write);}
 router.post('/:connectionId/actions',route(async(r,s)=>{const w=await workspace(r,true),result=await actOnRecordConnection(deps.db,deps.clock,w,r.params.connectionId,r.body,r.header('Idempotency-Key'));s.status('operationId' in (result as object)?202:200).json(result);}));
 router.get('/:connectionId/operations/:operationId',route(async(r,s)=>{const w=await workspace(r);s.json(await readRecordConnectionOperation(deps.db,w,r.params.connectionId,r.params.operationId));}));
 return router;
}
