import express,{type Request,type Response,type NextFunction} from 'express';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import type {AuthenticationAdapter} from '../auth/adapter.js';
import {DomainError} from '../domain/errors.js';
import {getProgramConsent,recordProgramConsent,startProgramTiming,appendProgramTiming,type ProgramAnalyticsRuntime} from './observation-export.js';
export interface ProgramObservationConfig extends ProgramAnalyticsRuntime{datasetRef:string;}
export function observationConfigFromEnv(env:NodeJS.ProcessEnv=process.env):ProgramObservationConfig|null{
  if(env.PACKPROOF_STUDY_ENABLED===undefined||env.PACKPROOF_STUDY_ENABLED==='false')return null;
  if(env.PACKPROOF_STUDY_ENABLED!=='true')throw new Error('PACKPROOF_STUDY_ENABLED must be true or false');
  const encoded=env.PACKPROOF_ANALYTICS_KEY_BASE64??'',key=Buffer.from(encoded,'base64'),keyVersion=env.PACKPROOF_ANALYTICS_KEY_VERSION??'',datasetRef=env.PACKPROOF_STUDY_DATASET_REF??'';
  if(key.length<32||key.toString('base64')!==encoded||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(keyVersion)||!/^pr_[a-f0-9]{32}$/.test(datasetRef))throw new Error('Enabled study requires a dedicated base64 analytics key, stable key version, and internally provisioned dataset reference');
  return {key,keyVersion,datasetRef};
}
/** Mount at /study. Dataset provisioning and cross-account export are deliberately
 * absent: those are governed internal commands, not ordinary account API routes. */
export function createObservationRouter(deps:{db:Database;clock:Clock;auth:AuthenticationAdapter},config:ProgramObservationConfig|null){
  const router=express.Router();
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');next();});
  const route=(fn:(userId:string,req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{
    void(async()=>{const user=await deps.auth.authenticate(req.headers);if(JSON.stringify(req.body??{}).length>8192)throw new DomainError('STUDY_REQUEST_TOO_LARGE','Study timing payload exceeds the supported limit.',413);await fn(user.userId,req,res);})().catch(next);
  };
  const enabled=(input?:unknown)=>{if(!config)throw new DomainError('STUDY_DISABLED','Study collection is disabled.',503);if(input&&(input as {datasetRef?:unknown}).datasetRef!==config.datasetRef)throw new DomainError('STUDY_UNAVAILABLE','This study dataset is unavailable.',404);return config;};
  router.get('/consent',route(async(userId,_req,res)=>{if(!config){res.json({enabled:false,granted:false});return;}res.json({enabled:true,...await getProgramConsent(deps.db,config,userId,config.datasetRef)});}));
  router.post('/consent',route(async(userId,req,res)=>{const runtime=enabled(req.body);res.json(await recordProgramConsent(deps.db,deps.clock,runtime,userId,req.body));}));
  router.post('/timings/start',route(async(userId,req,res)=>{const runtime=enabled(req.body);res.status(201).json(await startProgramTiming(deps.db,deps.clock,runtime,userId,req.body));}));
  router.post('/timings',route(async(userId,req,res)=>{const runtime=enabled(req.body);res.status(201).json(await appendProgramTiming(deps.db,deps.clock,runtime,userId,req.body));}));
  return router;
}
