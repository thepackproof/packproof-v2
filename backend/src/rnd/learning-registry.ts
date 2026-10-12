/** Signed synthetic model/campaign records. Importing a report never launches training. */
import { createPublicKey,verify as verifySignature } from 'node:crypto';
import { Router,type Request,type Response,type NextFunction } from 'express';
import { canonicalize } from '../../../packages/evidence-contracts/contracts.mjs';
import { sha256Hex } from '../hash.js';
import { assertSystemAdmin } from '../admin/auth.js';
import { appendAdminAudit } from '../admin/audit.js';
import { requireRnd } from './config.js';
import { authorized,bad,onlyKeys,requireConsent } from './security.js';
import type { AnalysisRow,RndDeps,WorkerResult } from './types.js';

interface SignedCandidate {payload:Record<string,unknown>;canonicalPayload:string;signature:string;keyId:string;}
interface LearningRow {id:string;model_sha256:string;signer_key_id:string;signed_candidate:SignedCandidate;summary_json:Record<string,unknown>;imported_by:string;imported_at:Date|string;}
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fraction=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:bad('RND_LEARNING_INVALID','Invalid signed record field');
const allowedPayload=['schema','scope','purpose','featureOrder','model','modelSha256','parentSha256','recipeSha256','datasetManifestSha256','holdoutManifestSha256','privacy','qualityGate','evaluation','productionReleaseAuthorized','reviewStatus','rollbackModelSha256'];

export function validateLearningCandidate(input:unknown,trustedKeysHex:string[]) {
 onlyKeys(input,['payload','canonicalPayload','signature','keyId']);
 const envelope=input as unknown as SignedCandidate;
 if(!hex(envelope.keyId)||typeof envelope.canonicalPayload!=='string'||envelope.canonicalPayload.length>32768||!/^[\x20-\x7e]+$/.test(envelope.canonicalPayload)||typeof envelope.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature))bad('RND_LEARNING_SIGNATURE_INVALID','Invalid signed record envelope');
 const trusted=trustedKeysHex.find(key=>hex(key)&&sha256Hex(Buffer.from(key,'hex'))===envelope.keyId);
 if(!trusted)bad('RND_LEARNING_SIGNER_UNTRUSTED','Configure the isolated training signer in the server trust policy',403);
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(trusted,'hex')]),format:'der',type:'spki'});
 if(!verifySignature(null,Buffer.concat([Buffer.from('PACKPROOF-F10-V1\0','ascii'),Buffer.from(envelope.canonicalPayload,'ascii')]),key,Buffer.from(envelope.signature,'base64')))bad('RND_LEARNING_SIGNATURE_INVALID','Candidate signature did not verify');
 let parsed:unknown;try{parsed=JSON.parse(envelope.canonicalPayload);}catch{bad('RND_LEARNING_INVALID','Invalid signed JSON');}
 if(canonicalize(parsed)!==canonicalize(envelope.payload))bad('RND_LEARNING_PAYLOAD_MISMATCH','Signed bytes and structured payload differ');
 const p=object(envelope.payload);onlyKeys(p,allowedPayload);
 if(p.schema!=='proofcollective-candidate/v1'||p.scope!=='SYNTHETIC_LOCAL_RESEARCH'||p.purpose!=='capture-frame-usefulness/v1'||p.productionReleaseAuthorized!==false||p.reviewStatus!=='EXTERNAL_PRIVACY_SECURITY_AND_PARTNER_VALIDATION_REQUIRED')bad('RND_LEARNING_SCOPE_FORBIDDEN','Only isolated synthetic candidate records are accepted');
 if(canonicalize(p.featureOrder)!==canonicalize(['sharpness','glare_fraction','local_contrast','bias'])||!Array.isArray(p.model)||p.model.length!==4||p.model.some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>20))bad('RND_LEARNING_MODEL_INVALID','Unsupported model or feature contract');
 for(const field of ['modelSha256','parentSha256','recipeSha256','datasetManifestSha256','holdoutManifestSha256','rollbackModelSha256'])if(!hex(p[field]))bad('RND_LEARNING_INVALID','Invalid lineage digest');
 const modelBytes=envelope.canonicalPayload.match(/"model":(\[[^\]]*\])/ )?.[1];
 if(!modelBytes||sha256Hex(modelBytes)!==p.modelSha256)bad('RND_LEARNING_MODEL_INVALID','Model weights do not match their signed digest');
 const privacy=object(p.privacy),evaluation=object(p.evaluation),gate=object(p.qualityGate);
 onlyKeys(privacy,['epsilonMaxCumulative','delta','noiseMultiplier','accountant','sampling','adjacency','reservation']);
 if(typeof privacy.epsilonMaxCumulative!=='number'||!Number.isFinite(privacy.epsilonMaxCumulative)||privacy.epsilonMaxCumulative<0||privacy.epsilonMaxCumulative>3||typeof privacy.delta!=='number'||!Number.isFinite(privacy.delta)||privacy.delta<=0||privacy.delta>1e-6||privacy.noiseMultiplier!==4||privacy.accountant!=='google-dp-accounting/0.6.0:RdpAccountant'||privacy.sampling!=='full-participation; no amplification'||privacy.adjacency!=='replace one bounded enrolled partner contribution'||privacy.reservation!=='spent before aggregate; no refund on abort')bad('RND_LEARNING_PRIVACY_INVALID','Candidate violates the governed privacy profile');
 onlyKeys(evaluation,['accuracy','groups','n','population','split']);
 const groups=object(evaluation.groups);
 if(!fraction(evaluation.accuracy)||evaluation.n!==3072||Object.keys(groups).length!==3||Object.entries(groups).some(([k,v])=>!/^synthetic-device-group-[0-2]$/.test(k)||!fraction(v))||evaluation.population!=='frozen synthetic held-out quality vectors; no camera or partner validation'||evaluation.split!=='seed-v1; training partners 1..64; holdout 100..143 with separate seed domain')bad('RND_LEARNING_EVALUATION_INVALID','Unsupported or non-synthetic evaluation');
 onlyKeys(gate,['passed','requiredGain','observedGain','maximumAllowedGroupDrop','groupDeltas']);
 const deltas=object(gate.groupDeltas);
 if(typeof gate.passed!=='boolean'||gate.requiredGain!==.05||gate.maximumAllowedGroupDrop!==.02||typeof gate.observedGain!=='number'||!Number.isFinite(gate.observedGain)||Math.abs(gate.observedGain)>1||Object.keys(deltas).length!==3||Object.entries(deltas).some(([k,v])=>!/^synthetic-device-group-[0-2]$/.test(k)||typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1))bad('RND_LEARNING_EVALUATION_INVALID','Invalid quality gate');
 if(gate.passed!==(gate.observedGain>=.05&&Object.values(deltas).every(v=>(v as number)>=-.02)))bad('RND_LEARNING_EVALUATION_INVALID','Quality gate disagrees with signed measurements');
 const id=sha256Hex(envelope.canonicalPayload);
 const summary={schemaVersion:'packproof.learning-summary.v1',reportId:id,feature:'proofcollective',modelSha256:p.modelSha256,parentSha256:p.parentSha256,recipeSha256:p.recipeSha256,holdoutManifestSha256:p.holdoutManifestSha256,signerKeyId:envelope.keyId,scope:p.scope,purpose:p.purpose,privacy:{epsilonMaxCumulative:privacy.epsilonMaxCumulative,delta:privacy.delta,coordinatorSeesPreNoiseAggregate:true},evaluation:{accuracy:evaluation.accuracy,n:evaluation.n,groups},qualityGate:gate,operationalState:'SUCCEEDED',findingState:'RECORDED',qualification:'SYNTHETIC_PROTOCOL_ONLY',independentContributors:0,trainingStarted:false,productionReleaseAuthorized:false};
 return {id,envelope,summary,modelSha256:p.modelSha256 as string};
}

function trustKeys(deps:RndDeps):string[]{return deps.rnd?.learning?.trustedPublicKeysHex??[];}
async function access(deps:RndDeps,actor:string,operation:'processing'|'internalDisplay') {requireRnd(deps.rnd,'proofcollective',operation);await assertSystemAdmin(deps.db,actor);}

export async function importLearningReport(deps:RndDeps,actor:string,input:unknown) {
 await access(deps,actor,'processing');
 const record=validateLearningCandidate(input,trustKeys(deps));
 return deps.db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(1347438146,80)');await assertSystemAdmin(tx,actor);
  const existing=(await tx.query<LearningRow>('SELECT * FROM rnd_learning_reports WHERE id=$1',[record.id])).rows[0];
  if(existing)return {...existing.summary_json,importedAt:new Date(existing.imported_at).toISOString()};
  const at=deps.clock.now().toISOString();
  await tx.query('INSERT INTO rnd_learning_reports(id,model_sha256,signer_key_id,signed_candidate,summary_json,imported_by,imported_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[record.id,record.modelSha256,record.envelope.keyId,JSON.stringify(record.envelope),JSON.stringify(record.summary),actor,at]);
  await appendAdminAudit(tx,deps.clock,{actorId:actor,action:'RND_LEARNING_REPORT_IMPORT',targetType:'rnd_learning_report',targetId:record.id,reason:'Imported a verified signed synthetic research candidate; no training or deployment',before:null,after:record.summary,operationId:`rnd-learning:${record.id}`});
  return {...record.summary,importedAt:at};
 });
}
export async function listLearningReports(deps:RndDeps,actor:string) {
 await access(deps,actor,'internalDisplay');
 const records=(await deps.db.query<LearningRow>('SELECT * FROM rnd_learning_reports ORDER BY imported_at DESC,id LIMIT 100')).rows;
 return {reports:records.map(r=>({...r.summary_json,importedAt:new Date(r.imported_at).toISOString()})),productionReleaseAuthorized:false};
}
export async function exportLearningReport(deps:RndDeps,actor:string,id:string) {
 await access(deps,actor,'internalDisplay');if(!hex(id))bad('RND_LEARNING_INVALID','Invalid report ID');
 const row=(await deps.db.query<LearningRow>('SELECT * FROM rnd_learning_reports WHERE id=$1',[id])).rows[0];
 if(!row)bad('RND_LEARNING_NOT_FOUND','Learning report not found',404);
 validateLearningCandidate(row.signed_candidate,trustKeys(deps));
 return {schemaVersion:'packproof.learning-export.v1',signedCandidate:row.signed_candidate,summary:row.summary_json,importedAt:new Date(row.imported_at).toISOString(),limitations:['Synthetic protocol engineering only; not a partner or camera qualification.','Central DP exposes the pre-noise aggregate to the coordinator.','No partner identities, examples, raw labels or per-partner privacy records are included.'],productionReleaseAuthorized:false};
}
export async function getLearningSummary(deps:RndDeps,job:AnalysisRow):Promise<WorkerResult> {
 await access(deps,job.actor_id,'processing');await authorized(deps.db,job.proof_id,job.actor_id);await requireConsent(deps.db,job.proof_id,job.actor_id,'LEARNING');
 const id=job.input_json.parameters.learningReportId;
 if(!hex(id))bad('RND_LEARNING_INVALID','Bind this status record to an exact signed research report');
 const row=(await deps.db.query<LearningRow>('SELECT * FROM rnd_learning_reports WHERE id=$1',[id])).rows[0];
 if(!row)bad('RND_LEARNING_NOT_FOUND','Learning report not found',404);
 validateLearningCandidate(row.signed_candidate,trustKeys(deps));
 const exported={summary:row.summary_json,signedCandidate:row.signed_candidate,limitations:['Synthetic protocol engineering only; not partner or camera qualification.','Central DP exposes the pre-noise aggregate to the coordinator.']};
 return {findingState:'RECORDED',observations:[{type:'RESEARCH_MODEL_GOVERNANCE_RECORD',sourceRefs:job.input_json.sources.map(s=>({sourceId:s.sourceId})),sourceRelation:'CONTEXT_ONLY_NOT_TRAINING_INPUT',summary:exported.summary,signedCandidate:exported.signedCandidate}],coverage:{researchReports:1,independentContributors:0,proofSourcesUsedForTraining:0},limitations:exported.limitations.concat('The linked Proof sources were not read, trained on or evaluated by this research status operation.'),provenance:{modelDigest:`sha256:${exported.summary.modelSha256}`,reportDigest:`sha256:${id}`,productionReleaseAuthorized:false}};
}

export function rndLearningRouter(deps:RndDeps) {
 const router=Router();
 const wrap=(fn:(r:Request,s:Response)=>Promise<unknown>)=>(r:Request,s:Response,n:NextFunction)=>{s.set('Cache-Control','private, no-store');void fn(r,s).catch(n);};
 const actor=(r:Request)=>r.packproofUserId??bad('UNAUTHENTICATED','Authentication required',401);
 router.post('/rnd/learning-reports',wrap(async(r,s)=>s.status(201).json(await importLearningReport(deps,actor(r),r.body))));
 router.get('/rnd/learning-reports',wrap(async(r,s)=>s.json(await listLearningReports(deps,actor(r)))));
 router.get('/rnd/learning-reports/:id/export',wrap(async(r,s)=>s.json(await exportLearningReport(deps,actor(r),r.params.id))));
 return router;
}
