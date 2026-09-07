import express,{type Request,type Response,type NextFunction} from 'express';
import { pipeline } from 'node:stream/promises';
import { newId } from '../ids.js';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ObjectStore } from '../s3/object-store.js';
import { DomainError } from '../domain/errors.js';
import { issueSupportGrant,listSupportGrants,readSupportEvidence,readSupportMetadata,revokeSupportGrant,parseSupportAccessPolicy,type SupportAccessPolicy } from './access.js';
const route=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};
export function supportAccessRouter(deps:{db:Database;clock:Clock;objectStore:ObjectStore},policy:SupportAccessPolicy=parseSupportAccessPolicy()){
  const r=express.Router();
  const actor=(req:Request)=>{if(!req.packproofUserId)throw new DomainError('UNAUTHENTICATED','Sign in to continue',401);return req.packproofUserId;};
  r.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');next();});
  r.get('/grants',route(async(req,res)=>{res.json(await listSupportGrants(deps.db,deps.clock,policy,actor(req)));}));
  r.post('/grants',route(async(req,res)=>{res.status(201).json(await issueSupportGrant(deps.db,deps.clock,policy,actor(req),req.body));}));
  r.post('/grants/:id/revoke',route(async(req,res)=>{res.json(await revokeSupportGrant(deps.db,deps.clock,policy,actor(req),req.params.id,req.body));}));
  r.get('/grants/:id/metadata',route(async(req,res)=>{res.json(await readSupportMetadata(deps.db,deps.clock,policy,actor(req),req.params.id,res.locals.operationId??newId('support_read')));}));
  r.get('/grants/:id/evidence/:evidenceId',route(async(req,res)=>{const source=await readSupportEvidence(deps.db,deps.clock,deps.objectStore,policy,actor(req),req.params.id,req.params.evidenceId,res.locals.operationId??newId('support_read'),req.headers.range);res.status(source.status).set(source.headers);if(source.body)await pipeline(source.body,res);else res.end();}));
  return r;
}
