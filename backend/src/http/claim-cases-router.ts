import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import {DomainError} from '../domain/errors.js';
import {createClaimCase,getClaimCase,listClaimCases,reviseClaimCase,requireClaimCaseFeature} from '../domain/claim-cases.js';
const run=(fn:(q:Request,s:Response)=>Promise<void>)=>(q:Request,s:Response,n:NextFunction)=>{void fn(q,s).catch(n);};
export async function requireRecentClaimAuthentication(deps:AppDependencies,q:Request){
 requireClaimCaseFeature();
 const identity=await deps.auth.authenticate(q.headers);
 if(!(deps.devAuth&&deps.testFixtures)){
  const age=deps.clock.now().getTime()/1000-(identity.authenticatedAt??0);
  if(!Number.isFinite(age)||age<0||age>300)throw new DomainError('RECENT_AUTHENTICATION_REQUIRED','Sign in again before reviewing sensitive case files.',401);
 }
 if(q.packproofUserId&&identity.userId!==q.packproofUserId)throw new DomainError('UNAUTHENTICATED','Authentication changed.',401);
 return identity.userId;
}
export function claimCasesRouter(deps:AppDependencies){
 const r=express.Router({mergeParams:true});
 r.use((_q,s,n)=>{s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');n();});
 r.get('/',run(async(q,s)=>{s.json(await listClaimCases(deps.db,await requireRecentClaimAuthentication(deps,q),q.params.id));}));
 r.post('/',run(async(q,s)=>{s.status(201).json(await createClaimCase(deps.db,deps.clock,await requireRecentClaimAuthentication(deps,q),q.params.id,{...q.body,idempotencyKey:q.header('Idempotency-Key')}));}));
 r.get('/:claimCaseId',run(async(q,s)=>{s.json(await getClaimCase(deps.db,await requireRecentClaimAuthentication(deps,q),q.params.id,q.params.claimCaseId));}));
 r.post('/:claimCaseId/revisions',run(async(q,s)=>{s.status(201).json(await reviseClaimCase(deps.db,deps.clock,await requireRecentClaimAuthentication(deps,q),q.params.id,q.params.claimCaseId,{...q.body,idempotencyKey:q.header('Idempotency-Key')}));}));
 r.post('/:claimCaseId/submissions',run(async(q,_s)=>{
  await getClaimCase(deps.db,await requireRecentClaimAuthentication(deps,q),q.params.id,q.params.claimCaseId);
  throw new DomainError('CLAIM_PROVIDER_SUBMISSION_UNAVAILABLE','This workflow exports files for merchant review. No eligible provider submission adapter is active.',409);
 }));
 return r;
}
