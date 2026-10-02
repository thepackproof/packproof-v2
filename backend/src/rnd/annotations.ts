import { Router,type Request,type Response,type NextFunction } from 'express';
import { newId } from '../ids.js';
import { requireRnd } from './config.js';
import { authorized,bad,boundedId,idempotent,onlyKeys,signedRecord } from './security.js';
import { sourceRef } from './analyses.js';
import type { AnalysisRow,RndDeps } from './types.js';

export async function addAnnotation(deps:RndDeps,actor:string,proofId:string,key:unknown,input:unknown) {
 onlyKeys(input,['analysisId','sourceId','text','interval','observationIndex','supersedesId']);
 const analysisId=boundedId(input.analysisId),sourceId=boundedId(input.sourceId);
 if(typeof input.text!=='string'||input.text.trim().length<1||input.text.length>2000)bad('RND_INVALID_ANNOTATION','Use a bounded attributed reviewer statement');
 const text=input.text.trim();
 return idempotent(deps,proofId,actor,'annotation',key,input,async tx=>{
  const {tenantId}=await authorized(tx,proofId,actor);
  const job=(await tx.query<AnalysisRow>('SELECT * FROM rnd_analyses WHERE id=$1 AND proof_id=$2 AND tenant_id=$3 AND operational_state=\'SUCCEEDED\'',[analysisId,proofId,tenantId])).rows[0];
  if(!job)bad('RND_ANALYSIS_NOT_FOUND','The referenced analysis is unavailable',404);
  requireRnd(deps.rnd,job.feature,'internalDisplay');
  const source=job.input_json.sources.find(s=>s.sourceId===sourceId||s.evidenceId===sourceId);if(!source)bad('RND_ANNOTATION_SOURCE','Reviewer statements must reference an input of this analysis',403);
  const observations=(job.result_json?.details as {observations?:unknown[]})?.observations??[];
  if(input.observationIndex!==undefined&&(!Number.isSafeInteger(input.observationIndex)||Number(input.observationIndex)<0||Number(input.observationIndex)>=observations.length))bad('RND_ANNOTATION_TARGET','Observation index is outside this immutable result');
  let interval:null|{startMs:number;endMs:number}=null;
  if(input.interval!==undefined&&input.interval!==null){onlyKeys(input.interval,['startMs','endMs']);const {startMs,endMs}=input.interval;
   if(!source.mimeType.startsWith('video/')||typeof startMs!=='number'||typeof endMs!=='number'||!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<=startMs||endMs>86400000)bad('RND_ANNOTATION_INTERVAL','Invalid source video interval');interval={startMs,endMs};}
  const supersedesId=input.supersedesId?boundedId(input.supersedesId):null;
  if(supersedesId&&!(await tx.query('SELECT 1 FROM rnd_annotations WHERE id=$1 AND proof_id=$2 AND actor_id=$3',[supersedesId,proofId,actor])).rows[0])bad('RND_ANNOTATION_PARENT','Only your own prior statement in this Proof can be superseded',403);
  const id=newId('rnd_annotation'),createdAt=deps.clock.now().toISOString();
  const annotation={schemaVersion:'packproof.reviewer-annotation.v1',annotationId:id,proofId,tenantId,analysisId,actorId:actor,attribution:'PARTICIPANT_STATEMENT',statement:text,sourceRefs:[sourceRef(source)],interval,observationIndex:input.observationIndex??null,supersedesId,createdAt,limitations:['This is an attributed human statement. It does not change or replace the machine observation, its sources, or the sealed Proof.']};
  const signed=await signedRecord(deps,proofId,id,annotation);
  await tx.query('INSERT INTO rnd_annotations(id,proof_id,tenant_id,actor_id,analysis_id,source_id,supersedes_id,canonical_json,digest,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,proofId,tenantId,actor,analysisId,source.sourceId,supersedesId,signed.canonicalJson,signed.digest,JSON.stringify(signed.signature),createdAt]);
  return {annotation,...signed};
 });
}
export async function listAnnotations(deps:RndDeps,actor:string,proofId:string) {
 await authorized(deps.db,proofId,actor);
 const rows=(await deps.db.query<{canonical_json:string;digest:string;signature:unknown;feature:string}>('SELECT n.canonical_json,n.digest,n.signature,a.feature FROM rnd_annotations n JOIN rnd_analyses a ON a.id=n.analysis_id WHERE n.proof_id=$1 ORDER BY n.created_at,n.id',[proofId])).rows;
 return {annotations:rows.map(row=>{requireRnd(deps.rnd,row.feature as AnalysisRow['feature'],'internalDisplay');return {annotation:JSON.parse(row.canonical_json),canonicalJson:row.canonical_json,digest:row.digest,signature:row.signature};})};
}
export function rndAnnotationsRouter(deps:RndDeps) {
 const router=Router(),base='/proofs/:id/rnd/annotations';
 const route=(fn:(r:Request,s:Response)=>Promise<unknown>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(n);};
 const actor=(r:Request)=>r.packproofUserId??bad('UNAUTHENTICATED','Authentication required',401);
 router.get(base,route(async(r,s)=>s.json(await listAnnotations(deps,actor(r),r.params.id))));
 router.post(base,route(async(r,s)=>s.status(201).json(await addAnnotation(deps,actor(r),r.params.id,r.header('Idempotency-Key'),r.body))));
 return router;
}
