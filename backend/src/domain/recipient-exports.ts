import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spoolCommittedEvidence,spoolPreservedStream} from './media-files.js';
import {streamPreservedObject} from './evidence.js';
import {MEDIA_MAX_BYTES} from './media-admission.js';
import type {Database} from '../db/database.js';
import {systemClock,type Clock} from '../clock.js';
import {strictBody} from '../platform/organizations.js';
import {getClaimCase} from './claim-cases.js';
import {bindClaimExport,assertClaimExportCurrent,claimEvidenceSelection,type ClaimExportBinding} from '../export/claim-profiles.js';
import type {ObjectStore} from '../s3/object-store.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {DomainError} from './errors.js';
import {getSignatureCase, type SignatureCasePreview} from './signature.js';
import {appendAudit} from './audit.js';
import {RECIPIENT_PROFILES,recipientProfile,recipientProfileNeedsReview,validateRecipientFiles,type RecipientProfile,type EncodedRecipientFile} from '../export/recipient-profiles.js';
import {extractRecipientFrame,renderFactsImages,recipientPdf,RENDERER_VERSION} from '../export/recipient-renderer.js';
import {zipFiles} from '../export/zip.js';
import {validateRecipientProtection,requireRecipientWriter,recipientRequestOperation,recipientResultOperation,recipientApprovalOperation,type RecipientProtection,type RecipientPreservationRuntime} from '../export/recipient-preservation.js';
import type {ProtectedReceipt} from '../integrity/envelope-jobs.js';
import {buildProofRecoverySnapshot,enqueueRecoveryEvent,getRecoveryStatus,requireDurableOperation} from './recovery-journal.js';
import {verifyRecipientArtifact} from '../export/recipient-artifact.js';
type Frame={evidenceId:string;offsetMs:number;label:string};
export type ExportRequest={preservation?:RecipientProtection;claimCase?:ClaimExportBinding;claimSelection?:ReturnType<typeof claimEvidenceSelection>;caseId:string;caseSha256:string;profile:RecipientProfile;frames:Frame[];narrative:string;destinationDeadline:string;destinationInstructionsReviewed:true;scopeStatement:string};
export type FileMeta={preservation?:ProtectedReceipt;name:string;contentType:string;byteSize:number;sha256:string;objectKey:string;pages:number;width?:number;height?:number};
export type Artifact={preservation?:RecipientProtection;requestSha256?:string;claimCase?:ClaimExportBinding;claimSelection?:ReturnType<typeof claimEvidenceSelection>;schema:string;jobId:string;proofId:string;caseId:string;caseSha256:string;snapshotId:string;snapshotSha256:string;manifestSha256:string|null;recordAsOf?:{sequence:number;sha256:string|null;snapshotAt:string};profile:RecipientProfile;scope:string;approvedNarrative:string;destinationDeadline:string;files:FileMeta[];sources:Array<{originalFramePreservation?:ProtectedReceipt;derivedFilePreservation?:ProtectedReceipt;derivedFileObjectKey?:string;evidenceId:string;sourceSha256:string;requestedOffsetMs:number;presentationTimestampMs:number;extractionTool:string;sourceCommittedAt?:string;sourceActorUserId?:string;actorAttribution?:'AUTHENTICATED_SUBMITTER';recipeVersion:string;crop:null;transform:string;originalFrameSha256:string;originalFrameObjectKey:string;derivedFileSha256:string}>;gaps:string[];createdAt:string;portalAcceptance:'NOT_TESTED';submission:'MERCHANT_CONTROLLED'};
export type Job={id:string;proof_id:string;case_id:string;actor_user_id:string;request_json:string;request_sha256:string;state:string;attempts:number;artifact_json:string|null;artifact_sha256:string|null;failure_code:string|null;created_at:string};
const fail=(code:string,message:string,status=409)=>new DomainError(code,message,status);
export function listRecipientProfiles(clock:Clock){return {profiles:RECIPIENT_PROFILES.map(p=>({...p,reviewRequired:recipientProfileNeedsReview(p,clock.now())})),limitations:'Profile constraints are checked against official instructions. Actual case deadlines, portal acceptance and reviewer comprehension require separate confirmation.'};}
export async function queueRecipientExport(db:Database,clock:Clock,actor:string,proofId:string,input:Record<string,unknown>,protection?:RecipientPreservationRuntime){
 if(input.claimCaseId!=null||input.claimSnapshotSha256!=null)strictBody(input,['caseId','profileId','idempotencyKey','destinationInstructionsReviewed','destinationDeadline','narrative','frames','claimCaseId','claimSnapshotSha256']);
 const profile=recipientProfile(input.profileId,clock.now());
 if(typeof input.caseId!=='string'||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.idempotencyKey.length>200)throw fail('EXPORT_INPUT_INVALID','A case, destination profile and retry key are required.',400);
 if(input.destinationInstructionsReviewed!==true||typeof input.destinationDeadline!=='string'||!Number.isFinite(Date.parse(input.destinationDeadline))||Date.parse(input.destinationDeadline)<=clock.now().getTime())throw fail('EXPORT_DESTINATION_REVIEW_REQUIRED','Check the actual destination instructions and enter its future submission deadline.');
 const packet=await getSignatureCase(db,actor,proofId,input.caseId);
 if(packet.createdBy!==actor)throw fail('EXPORT_CREATOR_REQUIRED','Create your own scoped case preview before preparing destination files.',403);
 if(typeof input.narrative!=='string'||input.narrative.length>2000)throw fail('EXPORT_NARRATIVE_INVALID','Supporting text must be at most 2,000 characters.',400);
 if(!Array.isArray(input.frames)||input.frames.length<1||input.frames.length>4)throw fail('EXPORT_FRAME_SELECTION_REQUIRED','Select one to four relevant source frames.',400);
 const frames=input.frames.map((x:any)=>{if(!x||typeof x.evidenceId!=='string'||!Number.isSafeInteger(x.offsetMs)||x.offsetMs<0||x.offsetMs>21600000||typeof x.label!=='string'||!x.label.trim()||x.label.length>120)throw fail('EXPORT_FRAME_INVALID','Each frame needs an evidence ID, offset and short factual label.',400);const source=packet.preview.evidence.find(e=>e.evidenceId===x.evidenceId);if(!source||!source.contentType.startsWith('video/'))throw fail('EXPORT_SOURCE_OUTSIDE_SCOPE','Select a recording included in this case scope.',403);if(source.capturedDurationMs!=null&&x.offsetMs>=source.capturedDurationMs)throw fail('EXPORT_FRAME_RANGE','The selected frame is outside the recording.');return {evidenceId:x.evidenceId,offsetMs:x.offsetMs,label:x.label.trim()};});
 const req:ExportRequest={caseId:input.caseId,caseSha256:packet.sha256,profile,frames,narrative:input.narrative.trim(),destinationDeadline:new Date(input.destinationDeadline).toISOString(),destinationInstructionsReviewed:true,scopeStatement:'Scoped snapshot of this Proof. Only the selected case fields and frames are included; other evidence or contrary observations may exist.'};
 if(input.claimCaseId!=null||input.claimSnapshotSha256!=null){req.claimCase=await bindClaimExport(db,clock,actor,proofId,input,profile);req.claimSelection=claimEvidenceSelection(packet.preview,req.claimCase,frames);
  if(!protection)throw fail('EXPORT_PROTECTION_UNAVAILABLE','Protected recipient export storage is not configured.',503);
  protection.assertReady?.();validateRecipientProtection(protection.policy,clock);
  if(Date.parse(protection.policy.retainUntil)<=Date.parse(req.destinationDeadline))throw fail('EXPORT_PROTECTION_DEADLINE','The reviewed preservation policy must cover this case deadline.',409);
  req.preservation={...protection.policy};
 }
 const json=canonicalize(req),hash=sha256Hex(json);
 return db.transaction(async tx=>{
  await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[actor]);
  if(req.claimCase)await assertClaimExportCurrent(tx,clock,actor,proofId,req.claimCase);
  if(req.preservation)await requireRecipientWriter(tx,protection!.writerGeneration);
  const old=(await tx.query<Job>('SELECT * FROM recipient_export_jobs WHERE proof_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',[proofId,actor,input.idempotencyKey])).rows[0];
  if(old){if(old.request_sha256!==hash)throw fail('EXPORT_RETRY_CONFLICT','Changed text, profile, selection or deadline requires a new preview and approval.');return req.preservation?getRecipientExport(tx,actor,proofId,old.id,clock):jobView(old);}
  if(req.preservation&&Number((await tx.query<{count:string}>("SELECT count(*) FROM recipient_export_jobs WHERE proof_id=$1 AND request_json::jsonb ? 'preservation'",[proofId])).rows[0].count)>=100)throw fail('EXPORT_PROOF_LIMIT','This Proof has reached its protected export limit.',429);
  const n=(await tx.query<{count:string}>("SELECT count(*) AS count FROM recipient_export_jobs WHERE actor_user_id=$1 AND created_at>$2",[actor,new Date(clock.now().getTime()-3600000).toISOString()])).rows[0];if(Number(n.count)>=10)throw fail('EXPORT_RATE_LIMIT','Up to ten recipient packets may be prepared per hour.',429);
  const row=(await tx.query<Job>(`INSERT INTO recipient_export_jobs(id,proof_id,case_id,actor_user_id,idempotency_key,request_json,request_sha256,profile_id,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED',$9) RETURNING *`,[newId('rex'),proofId,input.caseId,actor,input.idempotencyKey,json,hash,profile.id,clock.now().toISOString()])).rows[0];
  if(req.preservation){await appendAudit(tx,{proofId,actorUserId:actor,eventType:'RECIPIENT_EXPORT_REQUESTED',eventData:{jobId:row.id,requestSha256:hash},at:clock.now()});await enqueueRecoveryEvent(tx,clock,{operationId:recipientRequestOperation(row.id),kind:'RECIPIENT_EXPORT_REQUESTED',proofId,actorUserId:actor,payload:await buildProofRecoverySnapshot(tx,proofId)});}
  return req.preservation?getRecipientExport(tx,actor,proofId,row.id,clock):jobView(row);
 });
}
function jobView(j:Job){const b=(JSON.parse(j.request_json) as ExportRequest).claimCase;return {...(b?{claimCaseId:b.claimCaseId,claimSnapshotSha256:b.snapshotSha256,action:b.action,providerSubmission:'UNAVAILABLE'}:{}),jobId:j.id,proofId:j.proof_id,caseId:j.case_id,state:j.state,requestSha256:j.request_sha256,artifactSha256:j.artifact_sha256,artifact:j.artifact_json?JSON.parse(j.artifact_json):null,failureCode:j.failure_code,createdAt:j.created_at};}
async function loadJob(db:Database,actor:string,proofId:string,id:string){const j=(await db.query<Job>('SELECT * FROM recipient_export_jobs WHERE id=$1 AND proof_id=$2',[id,proofId])).rows[0];if(!j)throw fail('EXPORT_NOT_FOUND','Recipient packet is unavailable.',404);await getSignatureCase(db,actor,proofId,j.case_id);if(j.actor_user_id!==actor)throw fail('EXPORT_NOT_FOUND','Recipient packet is unavailable.',404);if(sha256Hex(j.request_json)!==j.request_sha256||(j.artifact_json&&sha256Hex(j.artifact_json)!==j.artifact_sha256))throw fail('EXPORT_INTEGRITY_FAILURE','The packet integrity check failed.');const binding=(JSON.parse(j.request_json) as ExportRequest).claimCase;if(binding)await getClaimCase(db,actor,proofId,binding.claimCaseId);return j;}
export async function getRecipientExport(db:Database,actor:string,proofId:string,id:string,clock:Clock=systemClock){
 const j=await loadJob(db,actor,proofId,id),r=JSON.parse(j.request_json) as ExportRequest,b=r.claimCase;
 const approval=(await db.query('SELECT actor_user_id AS "actorUserId",artifact_sha256 AS "artifactSha256",approved_at AS "approvedAt" FROM recipient_export_approvals WHERE job_id=$1',[id])).rows[0]??null;
 const preservation=r.preservation?{
  request:await getRecoveryStatus(db,recipientRequestOperation(id)),
  result:j.state==='READY'?await getRecoveryStatus(db,recipientResultOperation(id)):null,
  approval:approval?await getRecoveryStatus(db,recipientApprovalOperation(id)):null,
 }:undefined;
 const ready=j.state==='READY'&&(!preservation||preservation.result?.status==='PRESERVED');
 const approved=approval&&(!preservation||preservation.approval?.status==='PRESERVED');
 let claimReview:undefined|{state:string;requiresNewApproval:boolean;reason:string|null};
 if(b){let reason:string|null=null;try{await db.transaction(tx=>assertClaimExportCurrent(tx,clock,actor,proofId,b));}catch(e){if(!(e instanceof DomainError))throw e;reason=e.code;}
 claimReview={state:j.state==='FAILED'?'FAILED':!ready?'PREPARING':reason?'REVIEW_REQUIRED':approved?'APPROVED':approval?'APPROVAL_PRESERVING':'REVIEW_REQUIRED',requiresNewApproval:Boolean(reason),reason};}
 return {...jobView(j),...(j.state==='READY'&&!ready?{state:'PRESERVING',artifact:null}:{}),approval,...(preservation?{preservation}:{}),...(claimReview?{claimReview}:{})};
}
async function currentExport(db:Database,clock:Clock,actor:string,proofId:string,j:Job){
 await loadJob(db,actor,proofId,j.id);
 const r=JSON.parse(j.request_json) as ExportRequest;
 if(r.claimCase)await db.transaction(tx=>assertClaimExportCurrent(tx,clock,actor,proofId,r.claimCase!));
}
async function exportFileBytes(db:Database,clock:Clock,store:ObjectStore,actor:string,proofId:string,j:Job,protection?:RecipientPreservationRuntime){
 const r=JSON.parse(j.request_json) as ExportRequest,a=JSON.parse(j.artifact_json!) as Artifact;
 if(r.claimCase&&!r.preservation)throw fail('EXPORT_PROTECTION_UNAVAILABLE','Prepare a new protected export for this case.',503);
 if(!r.preservation)return {artifact:a,files:await approvedFileBytes(store,a.files)};
 if(!protection||protection.policy.bucket!==r.preservation.bucket)throw fail('EXPORT_PROTECTION_UNAVAILABLE','Protected recipient storage is unavailable.',503);
 protection.assertReady?.();validateRecipientProtection(r.preservation,clock);
 await requireDurableOperation(db,recipientResultOperation(j.id));
 const saved=(await db.query<{artifact_sha256:string;request_sha256:string;receipt_json:ProtectedReceipt}>('SELECT artifact_sha256,request_sha256,receipt_json FROM recipient_export_preservations WHERE job_id=$1 AND proof_id=$2',[j.id,proofId])).rows[0];
 if(!saved||saved.artifact_sha256!==j.artifact_sha256||saved.request_sha256!==j.request_sha256)throw fail('EXPORT_INTEGRITY_FAILURE','Protected export acceptance is inconsistent.');
 const packet=await getSignatureCase(db,actor,proofId,j.case_id);
 return verifyRecipientArtifact({job:j,preview:packet.preview,bytes:Buffer.from(j.artifact_json!),receipt:saved.receipt_json,reader:protection.reader,beforeRead:()=>currentExport(db,clock,actor,proofId,j)});
}
async function requireExportApproval(db:Database,j:Job){
 if(!(await db.query('SELECT job_id FROM recipient_export_approvals WHERE job_id=$1 AND artifact_sha256=$2',[j.id,j.artifact_sha256])).rows[0])throw fail('EXPORT_APPROVAL_REQUIRED','Approve the exact files before downloading the submission.');
 if((JSON.parse(j.request_json) as ExportRequest).preservation)await requireDurableOperation(db,recipientApprovalOperation(j.id));
}
export async function approveRecipientExport(db:Database,clock:Clock,store:ObjectStore,actor:string,proofId:string,id:string,input:Record<string,unknown>,protection?:RecipientPreservationRuntime){
 const j=await loadJob(db,actor,proofId,id);
 if(j.state!=='READY'||!j.artifact_json||input.artifactSha256!==j.artifact_sha256)throw fail('EXPORT_PREVIEW_CHANGED','Review the exact completed files before approving.');
 if(input.legibilityConfirmed!==true)throw fail('EXPORT_LEGIBILITY_REQUIRED','Confirm that the selected facts and images are readable in the exact files.');
 const a=JSON.parse(j.artifact_json) as Artifact;
 if(a.claimCase&&(input.action!=='EXPORT_FOR_MERCHANT_REVIEW'||input.claimSnapshotSha256!==a.claimCase.snapshotSha256))throw fail('CLAIM_APPROVAL_ACTION_REQUIRED','Approve this exact case revision for merchant review export. Provider submission is unavailable.');
 await exportFileBytes(db,clock,store,actor,proofId,j,protection);
 if(Date.parse(a.destinationDeadline)<=clock.now().getTime())throw fail('EXPORT_DEADLINE_PASSED','The recorded destination deadline has passed. Review the current case before creating a new packet.');
 await db.transaction(async tx=>{
  await loadJob(tx,actor,proofId,id);
  if(a.claimCase)await assertClaimExportCurrent(tx,clock,actor,proofId,a.claimCase);
  if(a.preservation)await requireRecipientWriter(tx,protection!.writerGeneration);
  const inserted=await tx.query('INSERT INTO recipient_export_approvals(job_id,actor_user_id,artifact_sha256,approved_at,legibility_confirmed) VALUES($1,$2,$3,$4,true) ON CONFLICT(job_id) DO NOTHING RETURNING job_id',[id,actor,j.artifact_sha256,clock.now().toISOString()]);
  if(inserted.rowCount){
   await appendAudit(tx,{proofId,actorUserId:actor,eventType:'RECIPIENT_EXPORT_APPROVED',eventData:{jobId:id,artifactSha256:j.artifact_sha256,profileVersion:a.profile.version,caseSha256:a.caseSha256,files:a.files.map(f=>({name:f.name,sha256:f.sha256,byteSize:f.byteSize})),...(a.claimCase?{claimCaseId:a.claimCase.claimCaseId,claimSnapshotSha256:a.claimCase.snapshotSha256,action:a.claimCase.action}:{}),legibilityConfirmed:true},at:clock.now()});
   if(a.preservation)await enqueueRecoveryEvent(tx,clock,{operationId:recipientApprovalOperation(id),kind:'RECIPIENT_EXPORT_APPROVED',proofId,actorUserId:actor,payload:await buildProofRecoverySnapshot(tx,proofId)});
  }
 });
 return getRecipientExport(db,actor,proofId,id,clock);
}
async function approvedFileBytes(store:ObjectStore,files:FileMeta[]){const bytes:Buffer[]=[];for(const f of files){const obj=await store.get(f.objectKey);if(!obj||obj.body.length!==f.byteSize||sha256Hex(obj.body)!==f.sha256)throw fail('EXPORT_INTEGRITY_FAILURE','A stored packet file no longer matches its approved digest.');bytes.push(obj.body);}return bytes;}
export async function readRecipientExportFile(db:Database,store:ObjectStore,actor:string,proofId:string,id:string,index:number,preview=false,clock:Clock=systemClock,protection?:RecipientPreservationRuntime){
 const j=await loadJob(db,actor,proofId,id);
 if(j.state!=='READY'||!j.artifact_json)throw fail('EXPORT_NOT_READY','The packet is still being prepared.');
 const a=JSON.parse(j.artifact_json) as Artifact,f=a.files[index];
 if(!Number.isInteger(index)||!f)throw fail('EXPORT_FILE_NOT_FOUND','File is unavailable.',404);
 if(!preview)await requireExportApproval(db,j);
 const result=await exportFileBytes(db,clock,store,actor,proofId,j,protection);
 await currentExport(db,clock,actor,proofId,j);
 return {file:f,bytes:result.files[index]};
}
export async function downloadRecipientExport(db:Database,store:ObjectStore,actor:string,proofId:string,id:string,clock:Clock=systemClock,protection?:RecipientPreservationRuntime){
 const j=await loadJob(db,actor,proofId,id);
 if(j.state!=='READY'||!j.artifact_json)throw fail('EXPORT_APPROVAL_REQUIRED','Approve the exact files before downloading the submission.');
 await requireExportApproval(db,j);
 const {artifact:a,files:bytes}=await exportFileBytes(db,clock,store,actor,proofId,j,protection),receipt=await getRecipientExport(db,actor,proofId,id,clock);
 await currentExport(db,clock,actor,proofId,j);
 return zipFiles([...a.files.map((f,i)=>({name:`submission/${f.name}`,bytes:bytes[i]})),{name:'supporting-text.txt',bytes:Buffer.from(a.approvedNarrative)},{name:'verification-receipt.json',bytes:Buffer.from(canonicalize(receipt))},{name:'READ-ME.txt',bytes:Buffer.from('Upload only the files inside submission/ to the selected destination; paste approved supporting text where accepted. The ZIP and verification receipt are for your records. No dispute was submitted by PackProof. Portal acceptance, deadline and claim outcome are separate from format validation.')}]);
}
function factualText(p:SignatureCasePreview,r:ExportRequest){const events=p.shipping?.events??[],selected=events.slice(-8);return ['PackProof - evidence for review',p.title,...(r.claimCase?[`Dispute: ${r.claimCase.snapshot.disputeId}`,`Provider account: ${r.claimCase.snapshot.providerAccountId}`,`Reason: ${r.claimCase.snapshot.reasonCode}`,`Case revision SHA-256: ${r.claimCase.snapshotSha256}`,'Case details: merchant reported, not provider verified.','Action: export for merchant review; no provider submission.','Reason-specific evidence requirements:',...r.claimCase.evidenceProfile.requiredFacts,'Contrary and comparison observations:',...(r.claimSelection?.contraryObservations??[]).map(o=>`${o.state}: ${o.note} (user observation ${o.comparisonId})`),'Case-specific gaps:',...(r.claimSelection?.gaps??[])]:[]),`Proof: ${p.proofId}`,`Snapshot: ${p.snapshotId}`,`Source snapshot SHA-256: ${p.snapshotSha256}`,r.scopeStatement,`Record status: ${p.status??'Withheld'}`,`Order reference: ${p.order?.externalReference??'Not included'}`,`Parcel: ${p.order?.parcelId??'No allocation declared'}`,`Allocation: ${p.order?.allocationAssurance??'Not established'}`,`Tracking identifier: ${p.shipping?.trackingNumber??'Not included'}`,`Item: ${p.order?.itemTitle??'Not included'}`,`Quantity: ${p.order?.quantity??'Not available'}`,`Order facts source: ${p.order?.source??'Not included'}`,'','Supporting text (user supplied):',r.narrative||'No additional narrative.','','Shipping observations:',...selected.map(e=>`${e.occurredAt}: ${e.title}; source ${e.source}; provider ${e.provider??'none'}; environment ${e.providerEnvironment??'unknown'}`),...(events.length>8?[`${events.length-8} earlier observations omitted from this concise packet.`]:[]),...(!events.length?['No carrier delivery observation included.']:[]),'Carrier-reported delivery does not verify contents or recipient identity.','Address-match evidence: not established by this packet.','','Declarations:',...p.statements.slice(0,3).map(s=>`${s.statement} (source: ${s.source})`),...(p.statements.length>3?['Additional declarations omitted from this scoped packet.']:[]),'','Material gaps:',...p.gaps,'Scope excludes original video bytes. Selected stills are embedded below.','PackProof makes no decision about fault, liability or claim eligibility.'].join('\n');}
async function renderRecipientArtifact(db:Database,clock:Clock,store:ObjectStore,j:Job,r:ExportRequest,p:SignatureCasePreview,caseHash:string,protection:RecipientPreservationRuntime|undefined,renew:()=>Promise<void>):Promise<Artifact>{
 const images=await renderFactsImages(factualText(p,r)),sources:Artifact['sources']=[];
 const preserve=async(bytes:Buffer,contentType:string,key:string)=>{
  await renew();
  if(r.preservation){
   const receipt=await protection!.writer!.preserveFile(j.id,bytes,contentType,r.preservation);
   return {objectKey:receipt.object.key,preservation:receipt};
  }
  await store.put(key,bytes,contentType);return {objectKey:key};
 };
 for(const [i,f] of r.frames.entries()){
  await renew();
  const media=p.evidence.find(e=>e.evidenceId===f.evidenceId);
  if(!media)throw fail('EXPORT_SOURCE_OUTSIDE_SCOPE','Selected evidence is no longer authorized.',403);
  const row=media.stageId?(await db.query<{id:string;object_key:string;object_version_id:string|null;content_type:string;sha256:string;byte_size:string;source_actor_user_id:string}>("SELECT e.id,e.object_key,e.object_version_id,e.content_type,e.sha256,e.byte_size,s.actor_user_id AS source_actor_user_id FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE e.id=$1 AND s.id=$2 AND s.proof_id=$3 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL",[media.evidenceId,media.stageId,j.proof_id])).rows[0]:(await db.query<{id:string;object_key:string;object_version_id:string|null;content_type:string;sha256:string;byte_size:string;source_actor_user_id:string}>("SELECT id,object_key,object_version_id,content_type,sha256,byte_size,submitted_by AS source_actor_user_id FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status='COMMITTED'",[media.evidenceId,j.proof_id])).rows[0];
  if(!row||row.sha256!==media.sha256||Number(row.byte_size)>MEDIA_MAX_BYTES)throw fail('EXPORT_SOURCE_LIMIT','Selected source is unavailable or exceeds the accepted recording limit.');
  const sourceDir=await mkdtemp(path.join(os.tmpdir(),'packproof-recipient-source-'));let rendered:Awaited<ReturnType<typeof extractRecipientFrame>>;
  try{
   const filename=path.join(sourceDir,'source');
   const spooled=media.stageId?await spoolPreservedStream(await streamPreservedObject(store,row),filename,MEDIA_MAX_BYTES):await spoolCommittedEvidence(db,store,j.actor_user_id,j.proof_id,media.evidenceId,filename,MEDIA_MAX_BYTES);
   if(spooled.sha256!==media.sha256)throw fail('EXPORT_SOURCE_INTEGRITY','Original evidence integrity failed.');
   rendered=await extractRecipientFrame(filename,f.offsetMs,f.label);
  }finally{await rm(sourceDir,{recursive:true,force:true});}
  const frameHash=sha256Hex(rendered.originalFrame),frameKey=`recipient-exports/${j.proof_id}/${j.id}/original-frame-${i}-${frameHash}`;
  const original=await preserve(rendered.originalFrame,'image/png',frameKey);
  const derived=r.preservation?await preserve(rendered.file.bytes,rendered.file.contentType,''):undefined;
  rendered.file.name=`frame-${i+1}.jpg`;images.push(rendered.file);
  sources.push({evidenceId:media.evidenceId,sourceSha256:media.sha256,requestedOffsetMs:f.offsetMs,presentationTimestampMs:rendered.actualMs,
   extractionTool:rendered.toolVersion,sourceCommittedAt:media.committedAt,sourceActorUserId:row.source_actor_user_id,actorAttribution:'AUTHENTICATED_SUBMITTER',
   recipeVersion:RENDERER_VERSION,crop:null,transform:'Full frame scaled proportionally into 1500x2000 white page; factual caption added.',
   originalFrameSha256:frameHash,originalFrameObjectKey:original.objectKey,derivedFileSha256:sha256Hex(rendered.file.bytes),
   ...(original.preservation?{originalFramePreservation:original.preservation}:{}),
   ...(derived?.preservation?{derivedFilePreservation:derived.preservation,derivedFileObjectKey:derived.objectKey}:{})});
 }
 const files:EncodedRecipientFile[]=r.profile.destination==='STRIPE_DISPUTE'?[recipientPdf(images)]:images;
 const validation=validateRecipientFiles(r.profile,files);
 if(validation.bytes>r.profile.targetBytes)throw fail('EXPORT_RELEVANCE_REQUIRED','Select fewer relevant frames or shorter text to retain readable files within the conservative size budget.',413);
 const metadata:FileMeta[]=[];
 for(const file of files){
  const hash=sha256Hex(file.bytes),key=`recipient-exports/${j.proof_id}/${j.id}/${hash}`,saved=await preserve(file.bytes,file.contentType,key);
  metadata.push({name:file.name,contentType:file.contentType,byteSize:file.bytes.length,sha256:hash,objectKey:saved.objectKey,pages:file.pages,
   ...(saved.preservation?{preservation:saved.preservation,...(file.width?{width:file.width,height:file.height}:{})}:{})});
 }
 return {schema:r.preservation?'packproof.recipient-export.v2':'packproof.recipient-export.v1',
  ...(r.preservation?{preservation:r.preservation,requestSha256:j.request_sha256}:{}),
  ...(r.claimCase?{claimCase:r.claimCase,claimSelection:r.claimSelection}:{}),jobId:j.id,proofId:j.proof_id,caseId:j.case_id,caseSha256:caseHash,
  snapshotId:p.snapshotId,snapshotSha256:p.snapshotSha256,manifestSha256:p.coreManifestSha256,...(p.recordAsOf?{recordAsOf:p.recordAsOf}:{}),
  profile:r.profile,scope:r.scopeStatement,approvedNarrative:r.narrative,destinationDeadline:r.destinationDeadline,files:metadata,sources,
  gaps:[...p.gaps,'Address-match evidence is not established by this packet.','PayPal protection eligibility is not established.'],
  createdAt:clock.now().toISOString(),portalAcceptance:'NOT_TESTED',submission:'MERCHANT_CONTROLLED'};
}
export async function processRecipientExport(db:Database,clock:Clock,store:ObjectStore,protection?:RecipientPreservationRuntime){
 const lease=newId('exportlease'),now=clock.now();
 await db.query("UPDATE recipient_export_jobs SET state='FAILED',failure_code='EXPORT_ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE state='RENDERING' AND lease_until<=$1 AND attempts>=3 AND NOT(request_json::jsonb ? 'preservation')",[now.toISOString()]);
 const j=await db.transaction(async tx=>{
  const row=(await tx.query<Job>(`SELECT j.* FROM recipient_export_jobs j WHERE
   (state='QUEUED' OR (state='RENDERING' AND lease_until<=$1)) AND (lease_until IS NULL OR lease_until<=$1)
   AND ((NOT(request_json::jsonb ? 'preservation') AND attempts<3) OR
    ($2 AND request_json::jsonb ? 'preservation' AND EXISTS(SELECT 1 FROM recovery_delivery d WHERE d.operation_id='recipient-request:'||j.id AND d.state='DURABLE')))
   ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[now.toISOString(),Boolean(protection?.writer)])).rows[0];
  if(!row)return null;
  // Row selection does not acknowledge an accepted result. The final commit also
  // checks generation, current authority and the unexpired lease.
  await tx.query("UPDATE recipient_export_jobs SET state='RENDERING',attempts=attempts+1,lease_token=$2,lease_until=$3 WHERE id=$1",[row.id,lease,new Date(now.getTime()+10*60000).toISOString()]);
  return row;
 });
 if(!j)return {processed:0,failed:0};
 const r=JSON.parse(j.request_json) as ExportRequest;
 const renew=async()=>{
  if(!r.preservation)return;
  if(!protection?.writer||!r.claimCase||r.preservation.bucket!==protection.policy.bucket)throw fail('EXPORT_PROTECTION_UNAVAILABLE','Protected export worker is unavailable.',503);
  protection.assertReady?.();validateRecipientProtection(r.preservation,clock);
  await db.transaction(async tx=>{
   await assertClaimExportCurrent(tx,clock,j.actor_user_id,j.proof_id,r.claimCase!);
   await requireRecipientWriter(tx,protection.writerGeneration);
   const at=clock.now();
   const updated=await tx.query("UPDATE recipient_export_jobs SET lease_until=$4 WHERE id=$1 AND lease_token=$2 AND state='RENDERING' AND lease_until>$3",[j.id,lease,at.toISOString(),new Date(at.getTime()+10*60000).toISOString()]);
   if(updated.rowCount!==1)throw fail('EXPORT_LEASE_LOST','This export worker lease is no longer current.',409);
  });
 };
 try{
  if(sha256Hex(j.request_json)!==j.request_sha256)throw fail('EXPORT_INTEGRITY_FAILURE','Request changed.');
  if(r.claimCase&&!r.preservation)throw fail('EXPORT_PROTECTION_UNAVAILABLE','Prepare a new protected export for this case.',503);
  recipientProfile(r.profile.id,clock.now());await renew();
  const packet=await getSignatureCase(db,j.actor_user_id,j.proof_id,j.case_id);
  if(packet.sha256!==r.caseSha256)throw fail('EXPORT_SOURCE_CHANGED','Case preview changed.');
  let json:string,receipt:ProtectedReceipt|undefined;
  if(r.preservation){
   let saved=await protection!.writer!.findArtifact(j.id,r.preservation);
   if(!saved){
    if(j.attempts>=3)throw fail('EXPORT_ATTEMPTS_EXHAUSTED','The export exhausted its bounded processing attempts.');
    const candidate=await renderRecipientArtifact(db,clock,store,j,r,packet.preview,packet.sha256,protection,renew);
    await renew();saved=await protection!.writer!.preserveArtifact(j.id,Buffer.from(canonicalize(candidate)),r.preservation);
   }
   await verifyRecipientArtifact({job:j,preview:packet.preview,bytes:saved.bytes,receipt:saved.receipt,reader:protection!.reader,beforeRead:renew});
   json=saved.bytes.toString('utf8');receipt=saved.receipt;
  }else{
   json=canonicalize(await renderRecipientArtifact(db,clock,store,j,r,packet.preview,packet.sha256,undefined,renew));
  }
  const hash=sha256Hex(json);
  await db.transaction(async tx=>{
   if(r.claimCase)await assertClaimExportCurrent(tx,clock,j.actor_user_id,j.proof_id,r.claimCase);
   if(r.preservation)await requireRecipientWriter(tx,protection!.writerGeneration);
   const changed=await tx.query("UPDATE recipient_export_jobs SET state='READY',artifact_json=$3,artifact_sha256=$4,completed_at=$5,lease_token=NULL,lease_until=NULL,failure_code=NULL WHERE id=$1 AND lease_token=$2 AND state='RENDERING' AND lease_until>$5",[j.id,lease,json,hash,clock.now().toISOString()]);
   if(changed.rowCount!==1)throw fail('EXPORT_LEASE_LOST','This export worker lease is no longer current.',409);
   if(r.preservation){
    await tx.query('INSERT INTO recipient_export_preservations(job_id,proof_id,request_sha256,artifact_sha256,receipt_json,accepted_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[j.id,j.proof_id,j.request_sha256,hash,JSON.stringify(receipt),clock.now().toISOString()]);
    await appendAudit(tx,{proofId:j.proof_id,actorUserId:j.actor_user_id,eventType:'RECIPIENT_EXPORT_PRESERVED',eventData:{jobId:j.id,artifactSha256:hash},at:clock.now()});
    await enqueueRecoveryEvent(tx,clock,{operationId:recipientResultOperation(j.id),kind:'RECIPIENT_EXPORT_PRESERVED',proofId:j.proof_id,actorUserId:j.actor_user_id,payload:await buildProofRecoverySnapshot(tx,j.proof_id)});
   }
  });
  return {processed:1,failed:0};
 }catch(error){
  const code=error instanceof DomainError?error.code:'EXPORT_RENDER_FAILED',retry=!(error instanceof DomainError)&&j.attempts+1<3;
  if(code==='EXPORT_LEASE_LOST'||code==='EXPORT_WRITER_FENCED')return {processed:0,failed:0};
  await db.transaction(async tx=>{
   if(r.preservation){if(!protection)throw error;await requireRecipientWriter(tx,protection.writerGeneration);}
   const changed=await tx.query("UPDATE recipient_export_jobs SET state=$4,failure_code=$3,lease_token=NULL,lease_until=$5 WHERE id=$1 AND lease_token=$2 AND state='RENDERING' AND lease_until>$6",[j.id,lease,code,retry?'QUEUED':'FAILED',retry?new Date(clock.now().getTime()+30000*2**j.attempts).toISOString():null,clock.now().toISOString()]);
   if(changed.rowCount&&r.preservation&&!retry){
    await appendAudit(tx,{proofId:j.proof_id,actorUserId:j.actor_user_id,eventType:'RECIPIENT_EXPORT_FAILED',eventData:{jobId:j.id,code},at:clock.now()});
    await enqueueRecoveryEvent(tx,clock,{operationId:`recipient-failed:${j.id}`,kind:'RECIPIENT_EXPORT_FAILED',proofId:j.proof_id,actorUserId:j.actor_user_id,payload:await buildProofRecoverySnapshot(tx,j.proof_id)});
   }
  });
  return {processed:0,failed:1};
 }
}
