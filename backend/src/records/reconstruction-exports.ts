import type {AppDependencies} from '../app.js';
import type {RecordWorkspace} from './access.js';
import {requireCaseAccess} from './cases.js';
import {loadOperationalCaseProjection} from './reconstruction.js';
import {requireReconstructionFeature} from './reconstruction-features.js';
import {DomainError} from '../domain/errors.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {auditOrganization} from '../platform/organizations.js';
import type {TypedSourceLocator} from './source-contracts.js';
import {loadOperationalCaseIssueHistory} from './reconstruction-issues.js';
import {getCaseRetentionSummary} from './source-retention.js';

type Deps=Pick<AppDependencies,'db'|'clock'|'objectStore'>;
export const RECONSTRUCTION_EXPORT_PROFILE='packproof.reconstruction-investigation/v1' as const;
interface ExtractRow {id:string;batch_id:string;source_locator:TypedSourceLocator;value:unknown;connection_id:string;mapping_version:string;source_revision:string;original_name:string;original_sha256:string;original_byte_size:number;original_object_key:string;original_version_id:string;source_values:unknown;}
async function assertHumanCase(deps:Deps,w:RecordWorkspace,id:string){
 if(w.partner)throw new DomainError('HUMAN_AUTHENTICATION_REQUIRED','Investigation extracts require a current human case session',403);
 return requireCaseAccess(deps.db,deps.clock,w,id);
}
/** A single validated field is derived from an authorized case. The batch's
 * other rows and unmapped fields never become case-level download authority. */
export async function readCaseAssertionSource(deps:Deps,w:RecordWorkspace,caseId:string,assertionId:string){
 await assertHumanCase(deps,w,caseId);
 const row=(await deps.db.query<ExtractRow>(`SELECT a.id,a.batch_id,a.source_locator,a.value,a.connection_id,a.mapping_version,a.source_revision,b.original_name,b.original_sha256,b.original_byte_size,b.original_object_key,b.original_version_id,r.source_values FROM record_case_assertions a JOIN record_typed_rows r ON r.id=a.observation_id AND r.case_id=a.case_id AND r.status='accepted_linked' JOIN record_typed_batches b ON b.id=a.batch_id WHERE a.id=$1 AND a.case_id=$2 AND b.organization_id=$3 AND b.environment=$4`,[assertionId,caseId,w.organizationId,w.environment])).rows[0];
 if(!row)throw new DomainError('CASE_ASSERTION_NOT_FOUND','Source assertion not found',404);
 const unavailable=(await deps.db.query("SELECT 1 FROM record_typed_retention_events WHERE batch_id=$1 AND action='unavailable' LIMIT 1",[row.batch_id])).rows[0];
 // An observed outage is historical evidence, not a permanent deletion claim.
 // A restored exact version may be retrievable again on the next request.
 const original=await deps.objectStore.get(row.original_object_key,{versionId:row.original_version_id});
 const originalAvailable=!!original&&original.body.length===Number(row.original_byte_size)&&sha256Hex(original.body)===row.original_sha256;
 const locator=typeof row.source_locator==='string'?JSON.parse(row.source_locator) as TypedSourceLocator:row.source_locator;
 let sourceValue:unknown=null;
 if(originalAvailable){
  if(locator.jsonPointer){
   try{let value:unknown=JSON.parse(original!.body.toString('utf8'));for(const key of locator.jsonPointer.split('/').slice(1).map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))){if(!value||typeof value!=='object'||!Object.hasOwn(value,key))throw 0;value=(value as Record<string,unknown>)[key];}sourceValue=value;}catch{throw new DomainError('SOURCE_LOCATOR_UNAVAILABLE','The original no longer agrees with its stored locator',409);}
  }else{
   const values=typeof row.source_values==='string'?JSON.parse(row.source_values):row.source_values;
   if(!values||typeof values!=='object'||!Object.hasOwn(values,locator.field))throw new DomainError('SOURCE_LOCATOR_UNAVAILABLE','The original field cannot be extracted under this profile',409);
   sourceValue=(values as Record<string,unknown>)[locator.field];
  }
 }
 await assertHumanCase(deps,w,caseId);
 return {assertionId:row.id,original:{name:row.original_name,sha256:row.original_sha256},locator,value:row.value,sourceValue,source:{connectionId:row.connection_id,mappingVersion:row.mapping_version,revision:row.source_revision},extraction:'case_scoped' as const,originalAvailable,retrievalHistory:{unavailabilityObserved:!!unavailable},omission:originalAvailable?null:'Original unavailable or integrity check failed. Preserved assertion does not establish current original retrievability.'};
}
/** New explicitly unsigned investigation profile. Existing signed Proof and
 * operational-snapshot formats remain byte-for-byte untouched. External signed
 * distribution remains gated on the separate signing qualification. */
export async function exportOperationalCase(deps:Deps,w:RecordWorkspace,caseId:string){
 requireReconstructionFeature('exports');await assertHumanCase(deps,w,caseId);
 const projection=await loadOperationalCaseProjection(deps.db,deps.clock,w,caseId);
 const issueHistory=await loadOperationalCaseIssueHistory(deps.db,deps.clock,w,caseId);
 const sourceRetention=await getCaseRetentionSummary(deps,w,caseId);
 const extracts=[];
 for(const assertion of projection.assertions)extracts.push(await readCaseAssertionSource(deps,w,caseId,assertion.id));
 const decisions=(await deps.db.query(`SELECT d.id,d.observation_id AS "observationId",d.supersedes_id AS "supersedesId",d.basis,d.created_at AS "createdAt" FROM record_case_association_decisions d JOIN record_typed_rows r ON r.id=d.observation_id WHERE d.case_id=$1 AND r.case_id=d.case_id AND r.status='accepted_linked' ORDER BY d.created_at,d.id`,[caseId])).rows;
 const artifactManifest=extracts.map(e=>({assertionId:e.assertionId,kind:'derived_field_extract',sourceSha256:e.original.sha256,locator:e.locator,sha256:sha256Hex(canonicalize(e)),originalAvailable:e.originalAvailable}));
 const omissions=[{kind:'shared_originals',reason:'Complete source batches can include unrelated records and are excluded from case-level access.'},...extracts.filter(e=>!e.originalAvailable).map(e=>({kind:'unavailable_original',assertionId:e.assertionId,reason:e.omission}))];
 const {measuredAt,...frozenProjection}=projection;
 const payload={schema:RECONSTRUCTION_EXPORT_PROFILE,integrity:{profile:'sha256-canonical-json',signed:false,scope:'internal_investigation'},projection:frozenProjection,sourceHealthMeasuredAt:measuredAt,associationDecisions:decisions,issueHistory,extracts,artifactManifest,omissions,retention:{sourceRetention,originalDispositionExecutionAvailable:false,backupErasure:'not_claimed'},limitations:projection.limitations};
 const canonical=canonicalize(payload),sha256=sha256Hex(canonical),id=`reconstruction_export_${sha256Hex(canonicalize([w.membershipId,sha256]))}`;
 await deps.db.transaction(async tx=>{
  const current=await requireCaseAccess(tx,deps.clock,w,caseId);
  if(Number(current.revision)!==projection.case.revision)throw new DomainError('CASE_PROJECTION_CHANGED','The case changed while preparing its package. Refresh and export the current revision.',409);
  await tx.query(`INSERT INTO record_reconstruction_exports(id,case_id,organization_id,environment,projection_version,profile,actor_membership_id,payload_canonical,payload_sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(case_id,actor_membership_id,payload_sha256) DO NOTHING`,[id,caseId,w.organizationId,w.environment,projection.projectionVersion,RECONSTRUCTION_EXPORT_PROFILE,w.membershipId,canonical,sha256,deps.clock.now().toISOString()]);
  await auditOrganization(tx,deps.clock,{userId:w.userId,merchantId:w.organizationId,requestId:id,operation:'CASE_INVESTIGATION_EXPORTED',resourceId:caseId});
 });
 await assertHumanCase(deps,w,caseId);
 return {id,sha256,filename:`PackProof-${caseId}-investigation.json`,bytes:Buffer.from(canonical,'utf8'),profile:RECONSTRUCTION_EXPORT_PROFILE};
}
