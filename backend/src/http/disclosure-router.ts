import express, {type Request,type Response,type NextFunction} from 'express';
import type { AppDependencies } from '../app.js';
import { createDisclosureGrant, previewDisclosure } from '../domain/disclosure.js';
import { approveRedaction, listRedactions, readRedactionForReview, renderRedaction } from '../domain/media-redaction.js';
import { setReceiptPreference } from '../domain/buyer-receipt.js';
import { queueThumbnail,listThumbnails,readThumbnail } from '../domain/media-thumbnails.js';
import { DomainError } from '../domain/errors.js';
const route=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};
export function sendPrivateMedia(req:Request,res:Response,media:{body:Buffer,contentType:string}) {
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Accept-Ranges','bytes');
  res.type(media.contentType);
  const range=req.headers.range;
  if(range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    const size=media.body.length;
    if(!match||(!match[1]&&!match[2])) {res.setHeader('Content-Range',`bytes */${size}`);res.status(416).end();return;}
    const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
    const end=match[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){res.setHeader('Content-Range',`bytes */${size}`);res.status(416).end();return;}
    res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
    res.status(206).send(media.body.subarray(start,end+1));return;
  }
  res.send(media.body);
}
export function disclosureRouter(deps:AppDependencies) {
  const router=express.Router({mergeParams:true});
  const user=(req:Request)=>{if(!req.packproofUserId)throw new DomainError('UNAUTHENTICATED','Sign in to manage sharing',401);return req.packproofUserId;};
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.post('/preview',route(async(req,res)=>{res.json(await previewDisclosure(deps.db,user(req),req.params.id,req.body??{}));}));
  router.post('/grants',route(async(req,res)=>{res.status(201).json(await createDisclosureGrant(deps.db,deps.clock,user(req),req.params.id,{...req.body,publicWebBaseUrl:(deps.corsOrigins ?? []).find(origin=>origin.startsWith("http"))??deps.publicBaseUrl}));}));
  router.patch('/grants/:linkId',route(async(req,res)=>{res.json(await createDisclosureGrant(deps.db,deps.clock,user(req),req.params.id,{...req.body,accessLinkId:req.params.linkId,publicWebBaseUrl:(deps.corsOrigins ?? []).find(origin=>origin.startsWith("http"))??deps.publicBaseUrl}));}));
  router.get('/thumbnails',route(async(req,res)=>{res.json({derivatives:await listThumbnails(deps.db,user(req),req.params.id)});}));
  router.post('/thumbnails/:anchorId',route(async(req,res)=>{res.status(202).json(await queueThumbnail(deps.db,deps.clock,user(req),req.params.id,req.params.anchorId));}));
  router.get('/thumbnails/:derivativeId/media',route(async(req,res)=>{sendPrivateMedia(req,res,await readThumbnail(deps.db,deps.objectStore,user(req),req.params.id,req.params.derivativeId));}));
  router.get('/redactions',route(async(req,res)=>{res.json({derivatives:await listRedactions(deps.db,user(req),req.params.id)});}));
  router.post('/redactions/:evidenceId',route(async(req,res)=>{res.status(201).json(await renderRedaction(deps.db,deps.clock,deps.objectStore,user(req),req.params.id,req.params.evidenceId,req.body));}));
  router.get('/redactions/:derivativeId/media',route(async(req,res)=>{sendPrivateMedia(req,res,await readRedactionForReview(deps.db,deps.objectStore,user(req),req.params.id,req.params.derivativeId));}));
  router.post('/redactions/:derivativeId/approve',route(async(req,res)=>{res.json(await approveRedaction(deps.db,deps.clock,deps.objectStore,user(req),req.params.id,req.params.derivativeId,req.body?.sha256));}));
  router.post('/receipt-preference',route(async(req,res)=>{res.json(await setReceiptPreference(deps.db,deps.clock,user(req),req.params.id,req.body?.optedIn));}));
  return router;
}
