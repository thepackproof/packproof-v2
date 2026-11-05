import express,{type Request,type Response,type NextFunction} from 'express';
import type { AppDependencies } from '../app.js';
import { requirePartnerFeature, partnerProblem } from '../platform/partner-router.js';
import { previewRecordImport, readRecordImport, commitRecordImport } from './imports.js';
import { SHIPMENT_CSV_TEMPLATE, CSV_LIMITS } from './csv.js';

/** Human-session route. Service credentials do not become human import actors. */
export function createRecordImportsRouter(deps:AppDependencies){
 const router=express.Router();
 const run=(fn:(req:Request,res:Response,userId:string)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{
  try{requirePartnerFeature();}catch(error){next(error);return;}
  void deps.auth.authenticate(req.headers).then(auth=>fn(req,res,auth.userId)).catch(next);
 };
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 router.get('/template.csv',run(async(_req,res)=>{res.type('text/csv; charset=utf-8').setHeader('Content-Disposition','attachment; filename="packproof-shipment-template.csv"');res.send(SHIPMENT_CSV_TEMPLATE);}));
 router.get('/limits',run(async(_req,res)=>{res.json({limits:CSV_LIMITS,encoding:'UTF-8',supportedDelimiters:[',',';','\t'],sourceTimeZoneRequired:true});}));
 router.post('/preview',run(async(req,res,user)=>{res.status(201).json(await previewRecordImport(deps,user,req.body));}));
 router.get('/:importId',run(async(req,res,user)=>{res.json(await readRecordImport(deps.db,user,req.params.importId));}));
 router.get('/:importId/corrections.csv',run(async(req,res,user)=>{const value=await readRecordImport(deps.db,user,req.params.importId);res.type('text/csv; charset=utf-8').setHeader('Content-Disposition','attachment; filename="packproof-row-corrections.csv"');res.send(value.correctionsCsv);}));
 router.post('/:importId/commit',run(async(req,res,user)=>{const value=await commitRecordImport(deps.db,deps.clock,user,req.params.importId,req.body);res.setHeader('Location',`/me/records/imports/${encodeURIComponent(value.id)}`);res.status(value.state==='succeeded'?200:202).json(value);}));
 router.use(partnerProblem);
 return router;
}
