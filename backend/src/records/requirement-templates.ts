import express,{type Request,type Response,type NextFunction} from 'express';
import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {EVIDENCE_TYPES} from '../domain/evidence-types.js';
import {buildProofRecoverySnapshot,enqueueRecoveryEvent} from '../domain/recovery-journal.js';
import {idempotent} from '../platform/idempotency.js';
import {strictBody,auditOrganization} from '../platform/organizations.js';
import {textField} from '../platform/tenants.js';
import {sha256Hex} from '../hash.js';
import {canonicalize} from '../canonical.js';
import {newId} from '../ids.js';
import {requireRecordWorkspace,type RecordWorkspace} from './access.js';
import {recordCommand,addRequirement} from './service.js';

interface Rule {key:string;stage:string;title:string;acceptedEvidenceTypes:string[];gracePeriodMs:number}
interface Definition {schema:'packproof.requirement-template/v1';name:string;description:string|null;rules:Rule[]}
interface Template {template_id:string;version:number;organization_id:string;environment:string;definition:Definition;definition_sha256:string;created_by:string;created_at:Date|string}
type Deps=Pick<AppDependencies,'db'|'clock'>;
const stages=['preparation','loading','handoff','delivery','return','receiving','customer_pickup'];
function definition(input:unknown):Definition{
 const b=strictBody(input,['name','description','rules']);
 if(!Array.isArray(b.rules)||b.rules.length<1||b.rules.length>20)throw new DomainError('INVALID_TEMPLATE','Use between one and twenty evidence requirements.',400);
 const keys=new Set<string>();
 const rules=b.rules.map(raw=>{
  const r=strictBody(raw,['key','stage','title','acceptedEvidenceTypes','gracePeriodMs']),key=textField(r.key,'key',40);
  if(!/^[a-z][a-z0-9_-]*$/.test(key)||keys.has(key))throw new DomainError('INVALID_TEMPLATE','Requirement keys must be unique lowercase identifiers.',400);
  keys.add(key);const stage=textField(r.stage,'stage',80);if(!stages.includes(stage))throw new DomainError('INVALID_TEMPLATE','Choose a supported shipping stage.',400);
  if(!Array.isArray(r.acceptedEvidenceTypes)||!r.acceptedEvidenceTypes.length||r.acceptedEvidenceTypes.length>20||r.acceptedEvidenceTypes.some(x=>![...EVIDENCE_TYPES,'SOURCE_ARTIFACT'].includes(x)))throw new DomainError('INVALID_TEMPLATE','Choose supported evidence categories.',400);
  const grace=r.gracePeriodMs??0;if(!Number.isInteger(grace)||Number(grace)<0||Number(grace)>2592000000)throw new DomainError('INVALID_TEMPLATE','Use a bounded nonnegative grace period.',400);
  return {key,stage,title:textField(r.title,'title',200),acceptedEvidenceTypes:[...new Set(r.acceptedEvidenceTypes)] as string[],gracePeriodMs:Number(grace)};
 });
 return {schema:'packproof.requirement-template/v1',name:textField(b.name,'name',100),description:b.description==null?null:textField(b.description,'description',1000),rules};
}
async function current(deps:Deps,db:Database,w:RecordWorkspace,manage=false){
 if(w.partner)throw new DomainError('HUMAN_AUTHENTICATION_REQUIRED','A current person manages requirement templates.',403);
 const result=await requireRecordWorkspace(db,w.userId,w.organizationId,w.environment,manage);
 if(manage&&!['OWNER','ADMIN'].includes(result.role))throw new DomainError('RECORD_PERMISSION_DENIED','An administrator must publish or assign templates.',403);
 return result;
}
function view(row:Template){
 if(!row)throw new DomainError('TEMPLATE_NOT_FOUND','Template not found.',404);
 if(sha256Hex(canonicalize(row.definition))!==row.definition_sha256)throw new DomainError('TEMPLATE_INTEGRITY_FAILURE','The immutable template failed its digest check.',409);
 return {templateId:row.template_id,version:row.version,definition:row.definition,definitionSha256:row.definition_sha256,createdBy:row.created_by,createdAt:new Date(row.created_at).toISOString()};
}
export async function listRequirementTemplates(deps:Deps,w:RecordWorkspace){
 await current(deps,deps.db,w);
 const rows=(await deps.db.query<Template>('SELECT * FROM record_requirement_templates WHERE organization_id=$1 AND environment=$2 ORDER BY template_id,version DESC LIMIT 501',[w.organizationId,w.environment])).rows;
 if(rows.length>500)throw new DomainError('TEMPLATE_CATALOG_LIMIT','This template catalog requires assisted archival review.',409);
 await current(deps,deps.db,w);return {templates:rows.map(view),limit:500,automaticAssignment:false};
}
export async function publishRequirementTemplate(deps:Deps,w:RecordWorkspace,key:unknown,input:unknown){
 const b=strictBody(input,['templateId','expectedVersion','definition']),value=definition(b.definition),id=b.templateId==null?null:textField(b.templateId,'templateId',40);
 if(!Number.isInteger(b.expectedVersion)||Number(b.expectedVersion)<0||Number(b.expectedVersion)>9998||(!id&&b.expectedVersion!==0))throw new DomainError('INVALID_TEMPLATE_VERSION','Use zero for a new template or the current version when appending.',400);
 await current(deps,deps.db,w,true);
 const result=await idempotent(deps.db,deps.clock,w.tenantId,'requirement-template:'+w.membershipId,key,b,async tx=>{
  await current(deps,tx,w,true);
  await tx.query('SELECT pg_advisory_xact_lock(1347438153,hashtext($1))',[w.organizationId+':'+w.environment]);
  const count=Number((await tx.query<{total:string}>('SELECT count(*) AS total FROM record_requirement_templates WHERE organization_id=$1 AND environment=$2',[w.organizationId,w.environment])).rows[0].total);
  if(count>=500)throw new DomainError('TEMPLATE_CATALOG_LIMIT','This catalog has reached its reviewed version limit.',409);
  const latest=id?(await tx.query<{version:number}>('SELECT version FROM record_requirement_templates WHERE template_id=$1 AND organization_id=$2 AND environment=$3 ORDER BY version DESC LIMIT 1',[id,w.organizationId,w.environment])).rows[0]:null;
  if(id&&!latest)throw new DomainError('TEMPLATE_NOT_FOUND','Template not found.',404);
  if((latest?.version??0)!==b.expectedVersion)throw new DomainError('TEMPLATE_VERSION_CONFLICT','Refresh before publishing another immutable version.',412);
  const templateId=id??newId('rt'),version=Number(b.expectedVersion)+1,digest=sha256Hex(canonicalize(value));
  await tx.query('INSERT INTO record_requirement_templates(template_id,version,organization_id,environment,definition,definition_sha256,created_by,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)',[templateId,version,w.organizationId,w.environment,canonicalize(value),digest,w.userId,deps.clock.now().toISOString()]);
  await auditOrganization(tx,deps.clock,{userId:w.userId,merchantId:w.organizationId,requestId:newId('req'),operation:'REQUIREMENT_TEMPLATE_VERSION_PUBLISHED',resourceId:templateId});
  return {templateId,version};
 });
 await current(deps,deps.db,w,true);
 const row=(await deps.db.query<Template>('SELECT * FROM record_requirement_templates WHERE template_id=$1 AND version=$2 AND organization_id=$3',[result.value.templateId,result.value.version,w.organizationId])).rows[0];
 return {...result,value:view(row)};
}
export async function assignRequirementTemplate(deps:Deps,w:RecordWorkspace,proofId:string,key:unknown,revision:unknown,input:unknown){
 const b=strictBody(input,['templateId','version','definitionSha256','subjectId','dueAt','reason']),id=textField(b.templateId,'templateId',40),reason=textField(b.reason,'reason',1000);
 if(!Number.isInteger(b.version)||Number(b.version)<1||Number(b.version)>9999||typeof b.definitionSha256!=='string'||!/^[a-f0-9]{64}$/.test(b.definitionSha256))throw new DomainError('INVALID_TEMPLATE_VERSION','Review a published version and digest.',400);
 await current(deps,deps.db,w,true);
 return recordCommand(deps.db,deps.clock,w,proofId,'template-assignment:'+proofId,key,revision,b,async(tx,authorized)=>{
  await current(deps,tx,authorized,true);
  const row=(await tx.query<Template>('SELECT * FROM record_requirement_templates WHERE template_id=$1 AND version=$2 AND organization_id=$3 AND environment=$4',[id,b.version,w.organizationId,w.environment])).rows[0];
  view(row);if(b.definitionSha256!==row.definition_sha256)throw new DomainError('TEMPLATE_VERSION_CONFLICT','Review the exact template version and digest before assignment.',412);
  const subjectId=b.subjectId==null?proofId:textField(b.subjectId,'subjectId');
  if((await tx.query('SELECT 1 FROM record_requirement_assignments WHERE proof_id=$1 AND subject_id=$2 AND template_id=$3 AND template_version=$4',[proofId,subjectId,id,b.version])).rows[0])throw new DomainError('TEMPLATE_ALREADY_ASSIGNED','This template version is already assigned to this subject.',409);
  const requirementIds:string[]=[];let nextRevision=0;
  for(const rule of row.definition.rules){
   const created=await addRequirement(tx,deps.clock,authorized,proofId,{subjectId,stage:rule.stage,title:rule.title,templateVersion:id+'@'+row.version+':'+row.definition_sha256,acceptedEvidenceTypes:rule.acceptedEvidenceTypes,dueAt:b.dueAt??null,gracePeriodMs:rule.gracePeriodMs,reason});
   requirementIds.push(created.id);nextRevision=created.revision;
  }
  const assignmentId=newId('ra');
  await tx.query('INSERT INTO record_requirement_assignments(id,proof_id,subject_id,template_id,template_version,definition_sha256,requirement_ids,actor_user_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)',[assignmentId,proofId,subjectId,id,row.version,row.definition_sha256,JSON.stringify(requirementIds),w.userId,reason,deps.clock.now().toISOString()]);
  await enqueueRecoveryEvent(tx,deps.clock,{operationId:'requirement-assignment:'+assignmentId,kind:'REQUIREMENT_TEMPLATE_ASSIGNED',proofId,actorUserId:w.userId,payload:await buildProofRecoverySnapshot(tx,proofId)});
  return {id:assignmentId,proofId,revision:nextRevision,templateId:id,version:row.version,definitionSha256:row.definition_sha256,requirementIds};
 });
}
export function createRequirementTemplatesRouter(deps:AppDependencies){
 const router=express.Router(),run=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>void fn(r,s).catch(n);
 async function workspace(r:Request,write=false){const a=await deps.auth.authenticate(r.headers);return requireRecordWorkspace(deps.db,a.userId,r.query.organizationId,r.query.environment,write);}
 router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});
 router.get('/requirement-templates',run(async(r,s)=>{s.json(await listRequirementTemplates(deps,await workspace(r)));}));
 router.post('/requirement-templates',run(async(r,s)=>{const result=await publishRequirementTemplate(deps,await workspace(r,true),r.header('Idempotency-Key'),r.body);s.setHeader('Idempotency-Replayed',String(result.replayed));s.status(201).json(result.value);}));
 router.post('/:proofId/requirement-template-assignments',run(async(r,s)=>{const result=await assignRequirementTemplate(deps,await workspace(r,true),r.params.proofId,r.header('Idempotency-Key'),r.header('If-Match'),r.body);s.setHeader('Idempotency-Replayed',String(result.replayed));s.status(201).json(result.value);}));
 return router;
}
