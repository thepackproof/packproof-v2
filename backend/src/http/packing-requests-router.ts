import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import {DomainError} from '../domain/errors.js';
import {requestPackingProof,listPackingRequests,respondPackingRequest,remindPackingRequest} from '../domain/packing-requests.js';
import {getParcelScope,declareSingleParcel} from '../domain/parcel-scope.js';
const route=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};
const user=(req:Request)=>{if(!req.packproofUserId)throw new DomainError('UNAUTHENTICATED','Sign in to manage packing requests',401);return req.packproofUserId;};
export function packingRequestsRouter(deps:AppDependencies){const r=express.Router();r.use((_q,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});r.get('/',route(async(q,s)=>{s.json(await listPackingRequests(deps.db,deps.clock,user(q)));}));r.post('/',route(async(q,s)=>{s.status(201).json(await requestPackingProof(deps.db,deps.clock,user(q),q.body??{}));}));r.post('/:requestId/respond',route(async(q,s)=>{s.json(await respondPackingRequest(deps.db,deps.clock,user(q),q.params.requestId,q.body??{}));}));r.post('/:requestId/remind',route(async(q,s)=>{s.json(await remindPackingRequest(deps.db,deps.clock,user(q),q.params.requestId));}));return r;}
export function parcelScopeRouter(deps:AppDependencies){const r=express.Router({mergeParams:true});r.use((_q,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});r.get('/',route(async(q,s)=>{s.json(await getParcelScope(deps.db,user(q),q.params.id));}));r.post('/',route(async(q,s)=>{s.status(201).json(await declareSingleParcel(deps.db,deps.clock,user(q),q.params.id,q.body??{}));}));return r;}
