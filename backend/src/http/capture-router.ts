import express, { type Request, type Response, type NextFunction } from 'express';
import type { AppDependencies } from '../app.js';
import { DomainError } from '../domain/errors.js';
import { createCaptureSession, completeCaptureSession, recoverCaptureSession, cancelCaptureSession } from '../domain/capture-sessions.js';
import { createRelayStation, pairRelayCamera, getRelayStation, sendRelayCommand, acknowledgeRelayCommand, renewRelayStation } from '../domain/packing-relay.js';
const route=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};
function user(req:Request){if(!req.packproofUserId) throw new DomainError('UNAUTHENTICATED','Sign in to record packing',401); return req.packproofUserId;}
export function captureSessionRouter(deps:AppDependencies) {
  const router=express.Router({mergeParams:true});
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.post('/',route(async(req,res)=>{res.status(201).json(await createCaptureSession(deps.db,deps.clock,user(req),req.params.id,{idempotencyKey:String(req.header('idempotency-key')??req.body?.idempotencyKey??''),client:String(req.body?.client??''),stageId:req.body?.stageId==null?undefined:String(req.body.stageId)}));}));
  router.get('/:sessionId',route(async(req,res)=>{res.json(await recoverCaptureSession(deps.db,deps.clock,user(req),req.params.id,req.params.sessionId));}));
  router.post('/:sessionId/complete',route(async(req,res)=>{res.json(await completeCaptureSession(deps.db,deps.clock,user(req),req.params.id,req.params.sessionId,{sha256:req.body?.sha256,byteSize:req.body?.byteSize,contentType:req.body?.contentType,interrupted:req.body?.interrupted,recordedDurationMs:req.body?.recordedDurationMs}));}));
  router.post('/:sessionId/recover',route(async(req,res)=>{res.json(await recoverCaptureSession(deps.db,deps.clock,user(req),req.params.id,req.params.sessionId));}));
  router.post('/:sessionId/cancel',route(async(req,res)=>{res.json(await cancelCaptureSession(deps.db,deps.clock,user(req),req.params.id,req.params.sessionId));}));
  return router;
}
export function packingRelayRouter(deps:AppDependencies) {
  const router=express.Router({mergeParams:true});
  const token=(req:Request)=>String(req.header('x-packproof-station-token')??'');
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.post('/',route(async(req,res)=>{res.status(201).json(await createRelayStation(deps.db,deps.clock,user(req)));}));
  router.post('/:stationId/pair',route(async(req,res)=>{res.json(await pairRelayCamera(deps.db,deps.clock,user(req),req.params.stationId,String(req.body?.pairingToken??'')));}));
  router.get('/:stationId',route(async(req,res)=>{res.json(await getRelayStation(deps.db,deps.clock,user(req),req.params.stationId,token(req)));}));
  router.post('/:stationId/commands',route(async(req,res)=>{res.json(await sendRelayCommand(deps.db,deps.clock,user(req),req.params.stationId,token(req),req.body??{}));}));
  router.post('/:stationId/ack',route(async(req,res)=>{res.json(await acknowledgeRelayCommand(deps.db,deps.clock,user(req),req.params.stationId,token(req),req.body??{}));}));
  router.post('/:stationId/renew',route(async(req,res)=>{res.json(await renewRelayStation(deps.db,deps.clock,user(req),req.params.stationId,token(req)));}));
  return router;
}
