import {createHmac,timingSafeEqual} from 'node:crypto';
import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {requireRecordAccess,type RecordWorkspace} from './access.js';
import {requireCaseAccess,requireCaseWorkspace,caseScopeSql,currentCaseObservationSql,currentCaseObservationProjectionSql,currentCaseAssertionSql,currentCaseRelationshipSql,currentCaseEntitySql,caseObservationSupersededSql,readCaseIdentityMappingsForProjection} from './cases.js';
import {readProjectionSourceCounter,projectionSourceDependencies} from './projection-store.js';
import {referencedRuleSources,type SourceRulePolicies} from './source-rule-policy.js';
import {projectionReferenceResolver,identityMappingDependencies,type ProjectionIdentityMappings} from './identity-projection.js';
import {readCompleteCaseLinks,hasRestrictedCaseAliases} from './case-associations.js';
import type {TypedSourceReference,TypedSourceObservation,TypedSourceCompleteness} from './source-contracts.js';
import {deriveSourceCoverage,type SourceCoverage,type SourceCoverageInput} from './coverage.js';
import {evaluateReconstructionRules,RECONSTRUCTION_RULE_VERSION,type ReconstructionAssertion} from './reconstruction-rules.js';
import {reconstructionFeatureEnabled,typedCollectorVersionSupported} from './reconstruction-features.js';

export const RECONSTRUCTION_PROFILE='packproof.operational-reconstruction/v1' as const;
type Section='assertions'|'relationships'|'timeline'|'comparisons'|'caseLinks'|'aliases'|'identityRules'|'proofs';
type Json=Record<string,unknown>;
const iso=(value:Date|string|null|undefined)=>value==null?null:new Date(value).toISOString();
const json=<T>(value:T|string):T=>typeof value==='string'?JSON.parse(value):value;
const refKey=(r:TypedSourceReference)=>canonicalize([r.namespace,r.type,r.externalId,r.parentExternalId??null]);
const reference=(row:{namespace:string;entity_type:TypedSourceReference['type'];external_id:string;parent_external_id?:string}):TypedSourceReference=>({namespace:row.namespace,type:row.entity_type,externalId:row.external_id,...(row.entity_type==='order_line'?{parentExternalId:row.parent_external_id}: {})});
const actorScope=(w:RecordWorkspace)=>({userId:w.userId,membershipId:w.membershipId,credentialId:w.partner?.credentialId??null,delegationId:w.partner?.delegationGrantId??null});
// The immutable entity ledger can retain an earlier association. Lists, exact
// reference search and detail must use the same current case membership rule.
// Superseded observations within the same case remain legitimate history.
export const CURRENT_CASE_ENTITY=currentCaseEntitySql('e');

export function boundedLimit(value:unknown){const n=value==null?50:Number(value);if(!Number.isInteger(n)||n<1||n>100)throw new DomainError('INVALID_LIMIT','limit must be from 1 to 100',400);return n;}
function cursorKey(){const key=Buffer.from(process.env.PACKPROOF_EVENT_CURSOR_KEY??'','base64');if(key.length!==32)throw new DomainError('RECORD_CURSOR_UNAVAILABLE','Record pagination is waiting for cursor configuration',503);return key;}
export function encodeCursor(scope:string,position:Json,clock:Clock){const body=Buffer.from(canonicalize({v:1,scope,position,expires:clock.now().getTime()+3600000})).toString('base64url');return `${body}.${createHmac('sha256',cursorKey()).update(body).digest('base64url')}`;}
export function decodeCursor(input:unknown,scope:string,clock:Clock):Json {
 try{if(typeof input!=='string'||input.length>4000)throw 0;const [body,sig,extra]=input.split('.'),actual=Buffer.from(sig??'','base64url'),expected=createHmac('sha256',cursorKey()).update(body).digest();if(extra||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw 0;const result=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));if(result.v!==1||result.scope!==scope||!result.position||!Number.isSafeInteger(result.expires))throw 0;if(result.expires<=clock.now().getTime())throw new DomainError('RECORD_CURSOR_EXPIRED','Refresh the case to start a new page',410);return result.position as Json;}catch(error){if(error instanceof DomainError)throw error;throw new DomainError('INVALID_CURSOR','Use a cursor from this case, workspace and filter',400);}
}

/** Visibility is applied before search, totals and traversal. Delegated partners
 * and old installation principals have no implicit authority over case groups. */
async function currentWorkspace(db:Database,clock:Clock,w:RecordWorkspace) {
 return requireCaseWorkspace(db,clock,w);
}

export async function listOperationalCases(db:Database,clock:Clock,w:RecordWorkspace,input:Record<string,unknown>={}) {
 const current=await currentWorkspace(db,clock,w),limit=boundedLimit(input.limit);
 const q=input.q==null?'':typeof input.q==='string'?input.q:'';
 if(q.length>200||input.q!=null&&typeof input.q!=='string')throw new DomainError('INVALID_SEARCH','Use an exact reference of at most 200 characters',400);
 const location=input.locationId==null?null:typeof input.locationId==='string'?input.locationId:null;
 if(input.locationId!=null&&location===null)throw new DomainError('INVALID_LOCATION','Use an authorized location identifier',400);
 const scope=sha256Hex(canonicalize({kind:'operational_cases',organizationId:w.organizationId,environment:w.environment,actor:actorScope(current),limit,q,location}));
 const after=input.cursor?decodeCursor(input.cursor,scope,clock):null;
 if(after&&(!Number.isFinite(Date.parse(String(after.updatedAt)))||typeof after.id!=='string'))throw new DomainError('INVALID_CURSOR','Use the current case-list cursor',400);
 const access=caseScopeSql(current),filters=`${access.sql} AND ($6::text IS NULL OR c.location_id=$6) AND ($7::text='' OR c.root_external_id=$7 OR EXISTS(SELECT 1 FROM record_case_entities e WHERE e.case_id=c.id AND e.external_id=$7 AND ${CURRENT_CASE_ENTITY}))`;
 const params=[...access.params,location,q];
 const total=Number((await db.query<{total:number}>(`SELECT COUNT(*)::integer AS total FROM record_cases c WHERE ${filters}`,params)).rows[0]?.total??0);
 const rows=(await db.query<{id:string;root_external_id:string;location_id:string;revision:string|number;created_at:Date|string;updated_at:Date|string;shipment_count:number;proof_count:number}>(`SELECT c.*,
  (SELECT COUNT(*)::integer FROM record_case_entities e WHERE e.case_id=c.id AND e.entity_type='shipment' AND ${CURRENT_CASE_ENTITY}) AS shipment_count,
  (SELECT COUNT(DISTINCT m.proof_id)::integer FROM record_case_members m JOIN record_typed_rows membership_source ON membership_source.id=m.source_row_id JOIN platform_proof_ownership member_owner ON member_owner.proof_id=m.proof_id AND member_owner.merchant_id=m.organization_id AND member_owner.environment=m.environment JOIN record_state member_state ON member_state.proof_id=m.proof_id WHERE m.case_id=c.id AND member_owner.operator_membership_id=c.operator_membership_id AND member_state.location_id=c.location_id AND ${currentCaseObservationSql('membership_source','m.case_id')} AND NOT ${caseObservationSupersededSql('membership_source.id','m.case_id')}) AS proof_count
  FROM record_cases c WHERE ${filters} AND ($8::timestamptz IS NULL OR (c.updated_at,c.id)<($8::timestamptz,$9::text)) ORDER BY c.updated_at DESC,c.id DESC LIMIT $10`,[...params,after?.updatedAt??null,after?.id??null,limit+1])).rows;
 const page=rows.slice(0,limit),last=page.at(-1);
 await currentWorkspace(db,clock,current);
 return {schema:RECONSTRUCTION_PROFILE,resourceType:'operational_case' as const,cases:page.map(row=>({id:row.id,reference:row.root_external_id,type:(row as typeof row&{root_type:string}).root_type,locationId:row.location_id,state:row.shipment_count?'reconstructed':'provisional',revision:Number(row.revision),updatedAt:iso(row.updated_at)!,createdAt:iso(row.created_at)!,shipmentCount:Number(row.shipment_count),proofCount:Number(row.proof_count),issueCount:null})),total,returnedCount:page.length,hasMore:rows.length>limit,nextCursor:rows.length>limit&&last?encodeCursor(scope,{updatedAt:iso(last.updated_at)!,id:last.id},clock):null,measuredAt:clock.now().toISOString()};
}

export interface AssertionRow {
 id:string;entity_id:string;namespace:string;entity_type:TypedSourceReference['type'];external_id:string;parent_external_id:string;property:string;value:ReconstructionAssertion['value'];unit:string|null;
 observation_id:string;connection_id:string;batch_id:string;row_number:number;source_locator:ReconstructionAssertion['source']['locator'];mapping_version:string;source_revision:string;source_namespace:string;
 occurred_at:Date|string|null;source_as_of:Date|string|null;time_quality:string;origin:{originSystem:string|null;copiedFromSource:string|null};received_at:Date|string;
 normalized:TypedSourceObservation;history_eligibility:'within_bounds'|'unknown'|'out_of_bounds';source_event_id:string;original_sha256:string;subscription_id:string;active:boolean;
}
interface EntityRow {id:string;namespace:string;entity_type:TypedSourceReference['type'];external_id:string;parent_external_id:string}
interface RelationRow {id:string;from_entity_id:string;to_entity_id:string;relation_type:string;quantity:unknown;assertion_row_id:string;row_number:number;active:boolean}
export interface CaseRow {id:string;root_external_id:string;root_namespace:string;root_type:string;location_id:string;operator_membership_id:string;revision:number|string;created_at:Date|string;updated_at:Date|string}

/** Internal complete projection used by both the paginated portal and the new
 * export profile. There is no first-500 truncation and no raw shared-file URL. */
export async function loadOperationalCaseProjection(db:Database,clock:Clock,w:RecordWorkspace,caseId:string,options:{evaluation?:boolean}={}) {
 await currentWorkspace(db,clock,w);
 const c=await requireCaseAccess(db,clock,w,caseId) as CaseRow;
 const [assertionResult,entityResult,relationResult,membersResult,observationResult]=await Promise.all([
  db.query<AssertionRow>(`SELECT a.*,e.namespace,e.entity_type,e.external_id,e.parent_external_id,${currentCaseObservationProjectionSql('r','a.case_id')} AS normalized,r.history_eligibility,r.source_event_id,b.original_sha256,b.subscription_id,
   NOT ${caseObservationSupersededSql('a.observation_id','a.case_id')} AS active
   FROM record_case_assertions a JOIN record_case_entities e ON e.id=a.entity_id AND e.case_id=a.case_id
   JOIN record_typed_rows r ON r.id=a.observation_id JOIN record_typed_batches b ON b.id=a.batch_id
   WHERE a.case_id=$1 AND ${currentCaseAssertionSql('a','r','a.case_id')} ${options.evaluation?`AND NOT ${caseObservationSupersededSql('a.observation_id','a.case_id')}`:''} AND b.organization_id=$2 AND b.environment=$3 ORDER BY a.received_at,a.id`,[caseId,w.organizationId,w.environment]),
  db.query<EntityRow>(`SELECT e.id,e.namespace,e.entity_type,e.external_id,e.parent_external_id FROM record_case_entities e WHERE e.case_id=$1 AND e.organization_id=$2 AND e.environment=$3 AND ${CURRENT_CASE_ENTITY} ${options.evaluation?`AND (EXISTS(SELECT 1 FROM record_case_assertions active_a JOIN record_typed_rows active_r ON active_r.id=active_a.observation_id WHERE active_a.entity_id=e.id AND ${currentCaseAssertionSql('active_a','active_r','e.case_id')} AND NOT ${caseObservationSupersededSql('active_r.id','e.case_id')}) OR EXISTS(SELECT 1 FROM record_case_relations active_rel JOIN record_typed_rows active_r ON active_r.id=active_rel.assertion_row_id WHERE active_rel.case_id=e.case_id AND (active_rel.from_entity_id=e.id OR active_rel.to_entity_id=e.id) AND ${currentCaseRelationshipSql('active_rel','active_r','e.case_id')} AND NOT ${caseObservationSupersededSql('active_r.id','e.case_id')}))`:''} ORDER BY e.id`,[caseId,w.organizationId,w.environment]),
  db.query<RelationRow>(`SELECT rel.*,r.row_number,NOT ${caseObservationSupersededSql('rel.assertion_row_id','rel.case_id')} AS active FROM record_case_relations rel JOIN record_typed_rows r ON r.id=rel.assertion_row_id WHERE rel.case_id=$1 AND ${currentCaseRelationshipSql('rel','r','rel.case_id')} ${options.evaluation?`AND NOT ${caseObservationSupersededSql('rel.assertion_row_id','rel.case_id')}`:''} ORDER BY rel.id`,[caseId]),
  options.evaluation?Promise.resolve({rows:[],rowCount:0}):db.query<{proof_id:string}>(`SELECT DISTINCT m.proof_id FROM record_case_members m JOIN record_typed_rows membership_source ON membership_source.id=m.source_row_id JOIN platform_proof_ownership member_owner ON member_owner.proof_id=m.proof_id AND member_owner.merchant_id=m.organization_id AND member_owner.environment=m.environment JOIN record_state member_state ON member_state.proof_id=m.proof_id WHERE m.case_id=$1 AND m.organization_id=$2 AND m.environment=$3 AND EXISTS(SELECT 1 FROM record_cases current_case WHERE current_case.id=m.case_id AND current_case.operator_membership_id=member_owner.operator_membership_id AND current_case.location_id=member_state.location_id) AND ${currentCaseObservationSql('membership_source','m.case_id')} AND NOT ${caseObservationSupersededSql('membership_source.id','m.case_id')} ORDER BY m.proof_id`,[caseId,w.organizationId,w.environment]),
  db.query<{id:string;normalized:TypedSourceObservation;connection_id:string;subscription_id:string;source_namespace:string;received_at:Date|string;active:boolean}>(`SELECT r.id,${currentCaseObservationProjectionSql('r','$1')} AS normalized,b.connection_id,b.subscription_id,b.source_namespace,r.received_at,NOT ${caseObservationSupersededSql('r.id','$1')} AS active FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE r.id IN ${caseObservationCandidatesSql('$1')} AND ${currentCaseObservationSql('r','$1')} ${options.evaluation?'AND false':''} AND b.organization_id=$2 AND b.environment=$3 ORDER BY r.received_at,r.id`,[caseId,w.organizationId,w.environment])
 ]);
 const entities=entityResult.rows,entityMap=new Map(entities.map(entity=>[entity.id,entity]));
 // Only explicit same_as relations participate in identity equivalence. Stable
 // lexical representatives make this rebuild independent of receipt order.
 const aliases=new Map<string,string>();
 const find=(key:string):string=>{const parent=aliases.get(key);if(!parent||parent===key)return key;const result=find(parent);aliases.set(key,result);return result;};
 const unite=(a:string,b:string)=>{const x=find(a),y=find(b);if(x!==y)aliases.set(x<y?y:x,x<y?x:y);};
 for(const row of relationResult.rows.filter(row=>row.active&&row.relation_type==='same_as')){
  const from=entityMap.get(row.from_entity_id),to=entityMap.get(row.to_entity_id);
  if(from&&to&&from.entity_type===to.entity_type)unite(refKey(reference(from)),refKey(reference(to)));
 }
 const identityMappings=reconstructionFeatureEnabled('crossCase')?await readCaseIdentityMappingsForProjection(db,clock,w,caseId):{aliases:[],rules:[]};
 const assertions=assertionResult.rows.map(row=>hydrateReconstructionAssertion(row,c.id,find,identityMappings));
 const relationships=relationResult.rows.map(row=>{const from=entityMap.get(row.from_entity_id)!,to=entityMap.get(row.to_entity_id)!;return {id:row.id,from:{id:from.id,...reference(from)},to:{id:to.id,...reference(to)},type:row.relation_type,quantity:row.quantity==null?null:json(row.quantity),sourceReceiptId:row.assertion_row_id,row:row.row_number,active:row.active,restricted:false};});
 const sourceKeys=await readCaseSourceKeys(db,w,c);
 const sources:SourceCoverage[]=[];
 const sourceHealthAvailable=reconstructionFeatureEnabled('sourceHealth'),rulesAvailable=sourceHealthAvailable&&reconstructionFeatureEnabled('rules');
 if(sourceHealthAvailable)for(const key of sourceKeys){const [subscriptionId,connectionId,namespace]=JSON.parse(key) as string[];sources.push(await readCaseSourceCoverage(db,clock,w,c,subscriptionId,connectionId,namespace));}
 await includePolicySourceCoverage(db,clock,w,c,sources);
 const comparisons=rulesAvailable?evaluateReconstructionRules(assertions,sources,{now:clock.now()}):[];
 const grouped=new Map<string,ReconstructionAssertion[]>();for(const assertion of assertions){const list=grouped.get(assertion.source.observationId)??[];list.push(assertion);grouped.set(assertion.source.observationId,list);}
 let latestReported=-Infinity;
 const timeline=observationResult.rows.map(row=>{const n=json(row.normalized),values=grouped.get(row.id)??[],reportedAt=iso(n.occurredAt),sourceAsOf=iso(n.sourceAsOf);return {id:row.id,observationKind:n.observationKind,reportedAt,sourceAsOf,originalReportedAt:n.occurredAt,originalSourceAsOf:n.sourceAsOf,receivedAt:iso(row.received_at)!,timeQuality:n.timeQuality,late:false,sourceConnectionId:row.connection_id,sourceNamespace:row.source_namespace,assertionIds:values.map(value=>value.id).sort(),active:row.active,timeBasis:reportedAt?'event_time':sourceAsOf?'snapshot_as_of':'unknown'};}).sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.id.localeCompare(b.id));
 for(const event of timeline){const sourceTime=event.reportedAt??event.sourceAsOf;if(sourceTime){const at=Date.parse(sourceTime);event.late=at<latestReported;latestReported=Math.max(latestReported,at);}}
 const permittedMembers:string[]=[];let restrictedMembers=false;for(const member of membersResult.rows){try{await requireRecordAccess(db,w,member.proof_id);permittedMembers.push(member.proof_id);}catch(error){if(error instanceof DomainError&&[403,404].includes(error.httpStatus))restrictedMembers=true;else throw error;}}
 const projectionVersion=sha256Hex(canonicalize({profile:RECONSTRUCTION_PROFILE,ruleVersion:RECONSTRUCTION_RULE_VERSION,caseId,revision:Number(c.revision),assertionIds:assertions.map(a=>[a.id,a.active]),identityMappings:identityMappingDependencies(identityMappings),relationshipIds:relationships.map(r=>[r.id,r.active]),comparisons:comparisons.map(c=>({id:c.id,outcome:c.outcome,ruleVersion:c.ruleVersion,policyVersion:c.policyVersion??null,deadlineAt:c.deadlineAt??null})),sources:projectionSourceDependencies(sources)}));
 const associations=options.evaluation?{caseLinks:[],restrictedCaseLinks:false,caseLinksTotal:0}:await readCompleteCaseLinks(db,clock,w,caseId);
 const restrictedAliases=options.evaluation?false:await hasRestrictedCaseAliases(db,clock,w,caseId);
 const after=await requireCaseAccess(db,clock,w,caseId) as CaseRow;
 if(Number(after.revision)!==Number(c.revision))throw new DomainError('CASE_PROJECTION_CHANGED','This case changed during reconstruction. Refresh to view one consistent revision.',409);
 return {schema:RECONSTRUCTION_PROFILE,resourceType:'operational_case' as const,projectionVersion,
  case:{id:c.id,reference:c.root_external_id,namespace:c.root_namespace,type:c.root_type,locationId:c.location_id,state:entities.some(entity=>entity.entity_type==='shipment')?'reconstructed':'provisional',revision:Number(c.revision),createdAt:iso(c.created_at)!,updatedAt:iso(c.updated_at)!,shipmentCount:entities.filter(entity=>entity.entity_type==='shipment').length,issueCount:rulesAvailable?comparisons.filter(comparison=>comparison.outcome==='different').length:null,proofIds:permittedMembers,restrictedMembers},
  assertions,relationships,comparisons,timeline,sources,identityMappings,aliases:identityMappings.aliases,identityRules:identityMappings.rules,restrictedAliases,...associations,ruleCapabilities:{quantityDisagreement:rulesAvailable?'prerequisites_required':'disabled',serialDisagreement:rulesAvailable?'explicit_unit_context_required':'disabled',sourceIdentityConflict:'enforced_at_typed_intake',sourceCoverage:sourceHealthAvailable?'qualified_source_boundaries_required':'disabled',labelWithoutAcceptance:rulesAvailable?'qualified_policy_required':'disabled',handlingUnitHandoffGap:rulesAvailable?'qualified_policy_required':'disabled'},sourceHealthStatus:{available:sourceHealthAvailable,reason:sourceHealthAvailable?null:'Source health is awaiting qualification and activation.'},rulesStatus:{available:rulesAvailable,reason:rulesAvailable?null:'Operational comparisons require activated source health and qualified rules.'},measuredAt:clock.now().toISOString(),
  limitations:['Values are source assertions. Physical contents, custody, responsibility and fraud are not established.','A source-reported completeness marker requires an approved source-owner qualification.','Case access permits scoped source extracts, not complete shared original files.','Source independence is unknown unless declared lineage establishes otherwise.']};
}

export async function readCaseSourceCoverage(db:Database,clock:Clock,w:RecordWorkspace,c:CaseRow,subscriptionId:string,connectionId:string,namespace:string):Promise<SourceCoverage> {
 const subscription=subscriptionId?(await db.query<{state:SourceCoverageInput['state'];configuration:Json;configuration_revision:number;last_check_at:Date|string|null;source_as_of:Date|string|null;heartbeat:Json;authority_current:boolean;installation_id:string|null;collector_version:string|null;installation_authority:boolean}>(`SELECT s.installation_id,i.version collector_version,(s.installation_id IS NULL OR (i.id IS NOT NULL AND i.organization_id=s.organization_id AND i.environment=s.environment AND i.principal_id=s.principal_id AND i.integration_account_id=s.connection_id AND i.operator_membership_id=s.operator_membership_id AND i.location_id=s.location_id AND i.status IN ('ready','active') AND i.enrollment_acknowledged_at IS NOT NULL AND i.renewal_credential_id IS NULL AND EXISTS(SELECT 1 FROM platform_credentials installed_credential WHERE installed_credential.id=i.credential_id AND installed_credential.principal_id=s.principal_id AND installed_credential.revoked_at IS NULL AND installed_credential.expires_at>$6 AND installed_credential.scopes ?& ARRAY['imports:read','imports:write']))) installation_authority,s.state,s.last_check_at,s.source_as_of,s.heartbeat,s.configuration_revision,r.configuration,
   (p.revoked_at IS NULL AND principal_user.status='ACTIVE' AND m.revoked_at IS NULL AND u.status='ACTIVE' AND m.role IN ('OWNER','ADMIN','OPERATOR') AND COALESCE(cs.paused,false)=false AND (m.location_scoped=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.organization_id=s.organization_id AND g.membership_id=m.id AND g.location_id=s.location_id)) AND EXISTS(SELECT 1 FROM platform_credentials credential WHERE credential.principal_id=p.id AND credential.revoked_at IS NULL AND credential.expires_at>$6 AND credential.scopes ? 'imports:write')) AS authority_current
   FROM record_source_subscriptions s JOIN record_source_subscription_revisions r ON r.subscription_id=s.id AND r.revision=s.configuration_revision
   JOIN platform_principals p ON p.id=s.principal_id JOIN users principal_user ON principal_user.id=p.actor_user_id JOIN platform_memberships m ON m.id=s.operator_membership_id JOIN users u ON u.id=m.user_id
   LEFT JOIN record_connection_state cs ON cs.connection_id=s.connection_id LEFT JOIN record_agent_installations i ON i.id=s.installation_id
   WHERE s.id=$1 AND s.organization_id=$2 AND s.environment=$3 AND s.location_id=$4 AND s.operator_membership_id=$5`,[subscriptionId,w.organizationId,w.environment,c.location_id,c.operator_membership_id,clock.now().toISOString()])).rows[0]:undefined;
 if(!subscription)throw new DomainError('SOURCE_SUBSCRIPTION_NOT_FOUND','Source subscription not found in the current case scope',404);
 const config=json(subscription.configuration),heartbeat=json(subscription.heartbeat);
 // Subscription totals include unlinked and rejected rows. Case totals are kept
 // separately; a successful case subset cannot hide a gap in its source feed.
 const batches=(await db.query<{contract:Json;received_at:Date|string;configuration_revision:number}>(`SELECT b.contract,b.received_at,b.configuration_revision FROM record_typed_batches b WHERE b.subscription_id=$1 AND b.organization_id=$2 AND b.environment=$3 AND b.location_id=$4 AND b.operator_membership_id=$5 AND b.source_namespace=$6 ORDER BY b.received_at DESC,b.id DESC LIMIT 1`,[subscriptionId??'',w.organizationId,w.environment,c.location_id,c.operator_membership_id,namespace])).rows;
 let counter=await readProjectionSourceCounter(db,subscriptionId);
 if(!reconstructionFeatureEnabled('pagedProjections')){
  const rows=(await db.query<{status:string;n:number;unknown_count:number}>(`SELECT r.status,COUNT(*)::integer n,COUNT(*) FILTER(WHERE r.history_eligibility='unknown' AND r.status IN ('accepted_linked','accepted_unlinked'))::integer unknown_count FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE b.subscription_id=$1 GROUP BY r.status`,[subscriptionId])).rows;
  const n=(status:string)=>Number(rows.find(r=>r.status===status)?.n??0);
  counter={subscriptionId,ready:true,counts:{received:rows.reduce((s,r)=>s+Number(r.n),0),processing:n('processing'),acceptedLinked:n('accepted_linked'),acceptedUnlinked:n('accepted_unlinked'),duplicate:n('duplicate'),conflict:n('conflict'),quarantined:n('quarantined'),rejected:n('rejected')},unknownTimeCount:rows.reduce((s,r)=>s+Number(r.unknown_count),0)};
 }
 const caseCounts=(await db.query<{n:number}>(`SELECT COUNT(*)::integer n FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE b.subscription_id=$1 AND r.id IN ${caseObservationCandidatesSql('$2')} AND ${currentCaseObservationSql('r','$2')}`,[subscriptionId,c.id])).rows[0]?.n??0;
 const latestContract=batches[0]?json(batches[0].contract):{},complete=(latestContract.completeness??{kind:'unknown',asOf:null,marker:null}) as TypedSourceCompleteness;
 const installationError=subscription.installation_id?(!reconstructionFeatureEnabled('multiSourceAgent')||!subscription.installation_authority?'AGENT_AUTHORIZATION_REQUIRED':!typedCollectorVersionSupported(subscription.collector_version??'',typeof config.batchSchema==='string'?config.batchSchema:'packproof.typed-source-batch/v1')?'SOURCE_COLLECTOR_VERSION_UNSUPPORTED':null):null;
 const errorCode=installationError??(!subscription?.authority_current?'SOURCE_AUTHORIZATION_REQUIRED':batches[0]&&Number(batches[0].configuration_revision)!==Number(subscription.configuration_revision)?'MAPPING_REVISION_CHANGED':typeof heartbeat.errorCode==='string'?heartbeat.errorCode:null);
 const unknownTimes=counter.unknownTimeCount>0;
 const result=deriveSourceCoverage({connectionId,sourceNamespace:namespace,state:subscription?.state,lastReceivedAt:iso(batches[0]?.received_at),sourceAsOf:iso(subscription?.source_as_of)??complete.asOf,lastCheckedAt:iso(subscription?.last_check_at),expectedIntervalSeconds:typeof config.expectedIntervalSeconds==='number'?config.expectedIntervalSeconds:null,errorCode,reportedState:typeof heartbeat.state==='string'?heartbeat.state:null,collectorBacklog:typeof heartbeat.backlog==='number'?heartbeat.backlog:null,oldestPendingAt:typeof heartbeat.oldestPendingAt==='string'?heartbeat.oldestPendingAt:null,completeness:complete,completenessPolicy:unknownTimes||!counter.ready?null:config.completenessPolicy as SourceCoverageInput['completenessPolicy'],counts:counter.counts},clock.now());
 return {...result,...(unknownTimes?{coverage:'unknown',state:'coverage_unknown',label:'Source interval includes unknown source times',nextAction:'The original rows are retained, but their history interval cannot be established. Resolve source times before using completeness-dependent rules.'}:{}),displayName:typeof config.displayName==='string'?config.displayName:namespace,subscriptionId:subscriptionId??null,configurationRevision:subscription?.configuration_revision??null,accountingGrain:'source_subscription',accountingAvailable:counter.ready,caseAccounting:{received:Number(caseCounts),acceptedLinked:Number(caseCounts),processing:0,acceptedUnlinked:0,duplicate:0,conflict:0,quarantined:0,rejected:0},rulePolicies:(reconstructionFeatureEnabled('sourceRulePolicies')?config.rulePolicies??null:null) as SourceRulePolicies|null} as SourceCoverage;
}

export async function getOperationalCase(db:Database,clock:Clock,w:RecordWorkspace,caseId:string,input:Record<string,unknown>={}) {
 if(reconstructionFeatureEnabled('pagedProjections')){const {getPagedOperationalCase}=await import('./reconstruction-pages.js');return getPagedOperationalCase(db,clock,w,caseId,input);}
 const projection=await loadOperationalCaseProjection(db,clock,w,caseId),limit=boundedLimit(input.limit);
 const section=(input.section??'assertions') as Section;if(!['assertions','relationships','timeline','comparisons','caseLinks','aliases','identityRules','proofs'].includes(section))throw new DomainError('INVALID_CASE_SECTION','Choose assertions, relationships, timeline, comparisons, caseLinks, aliases, identityRules or proofs',400);
 const timelineOrder=input.timelineOrder??'operational';if(timelineOrder!=='operational'&&timelineOrder!=='received')throw new DomainError('INVALID_TIMELINE_ORDER','Choose operational or received history',400);
 const cursorScope={kind:'operational_case_detail',caseId,organizationId:w.organizationId,environment:w.environment,actor:actorScope(w),limit,section,timelineOrder};
 const scope=sha256Hex(canonicalize(cursorScope)),proofScope=sha256Hex(canonicalize({...cursorScope,section:'proofs'}));
 const position=input.cursor?decodeCursor(input.cursor,scope,clock):null;
 if(position&&(position.projectionVersion!==projection.projectionVersion||!Number.isSafeInteger(position.offset)||Number(position.offset)<0))throw new DomainError('CASE_PROJECTION_CHANGED','This case changed. Refresh before continuing through its pages.',409);
 const offset=Number(position?.offset??0);
 const operational=[...projection.timeline].sort((a,b)=>{const x=a.reportedAt??a.sourceAsOf,y=b.reportedAt??b.sourceAsOf;return x===null?(y===null?a.id.localeCompare(b.id):1):y===null?-1:x.localeCompare(y)||a.id.localeCompare(b.id);});
 const collections={proofs:projection.case.proofIds.map(id=>({id,proofId:id})),identityRules:projection.identityRules,caseLinks:projection.caseLinks,aliases:projection.aliases,assertions:projection.assertions,relationships:projection.relationships,comparisons:projection.comparisons,timeline:timelineOrder==='operational'?operational:projection.timeline};
 const total=collections[section].length;
 if(section==='proofs'&&position&&Number(position.proofCount)!==collections.proofs.length)throw new DomainError('CASE_PROJECTION_CHANGED','The current shipment evidence memberships changed. Refresh before continuing through their pages.',409);
 const next=offset+limit<total?encodeCursor(scope,{offset:offset+limit,projectionVersion:projection.projectionVersion,...(section==='proofs'?{proofCount:collections.proofs.length}:{})},clock):null;
 const pages=Object.fromEntries(Object.entries(collections).map(([name,rows])=>[name,{total:rows.length,returnedCount:rows.slice(name===section?offset:0,(name===section?offset:0)+limit).length,hasMore:(name===section?offset:0)+limit<rows.length}]));
 return {...projection,case:{...projection.case,proofCount:collections.proofs.length,proofIds:collections.proofs.slice(section==='proofs'?offset:0,(section==='proofs'?offset:0)+limit).map(p=>p.proofId)},proofPagination:{section:'proofs',limit,total:collections.proofs.length,returnedCount:collections.proofs.slice(section==='proofs'?offset:0,(section==='proofs'?offset:0)+limit).length,hasMore:(section==='proofs'?offset:0)+limit<collections.proofs.length,nextCursor:(section==='proofs'?offset:0)+limit<collections.proofs.length?encodeCursor(proofScope,{offset:(section==='proofs'?offset:0)+limit,projectionVersion:projection.projectionVersion,proofCount:collections.proofs.length},clock):null,projectionVersion:projection.projectionVersion},...Object.fromEntries(Object.entries(collections).map(([name,rows])=>[name,rows.slice(name===section?offset:0,(name===section?offset:0)+limit)])),pages,totals:Object.fromEntries(Object.entries(collections).map(([name,rows])=>[name,rows.length])),pagination:{section,limit,total,returnedCount:collections[section].slice(offset,offset+limit).length,hasMore:next!==null,nextCursor:next,projectionVersion:projection.projectionVersion},timelineOrder};
}

export function hydrateReconstructionAssertion(row:AssertionRow,caseId:string,find:(key:string)=>string=key=>key,mappings:ProjectionIdentityMappings={aliases:[],rules:[]}):ReconstructionAssertion {
 const n=json(row.normalized),source=json(row.origin),subject=reference(row),resolve=projectionReferenceResolver(mappings,iso(row.occurred_at)??iso(row.source_as_of)),canonicalSubject=resolve(subject);
 const unique=(type:TypedSourceReference['type'])=>{const keys=[...new Set(n.references.filter(ref=>ref.type===type).map(ref=>find(resolve(ref).key)))];return keys.length===1?keys[0]:null;};
 const line=subject.type==='order_line'?find(canonicalSubject.key):null,shipment=unique('shipment');
 const hasReturn=n.references.some(ref=>ref.type==='return')||n.relationships.some(rel=>rel.type==='return_of');
 return {id:row.id,subject,property:row.property,value:row.value,unit:row.unit,active:row.active,
  source:{subscriptionId:row.subscription_id,connectionId:row.connection_id,receiptId:row.batch_id,observationId:row.observation_id,sourceEventId:row.source_event_id,historyEligibility:row.history_eligibility,observationKind:n.observationKind,row:row.row_number,field:json(row.source_locator).field,locator:json(row.source_locator),mappingVersion:row.mapping_version,revision:row.source_revision,reportedAt:iso(row.occurred_at),sourceAsOf:iso(row.source_as_of),receivedAt:iso(row.received_at)!,timeQuality:row.time_quality,originalSha256:row.original_sha256,sourceNamespace:row.source_namespace,...(n.identityDerivation?{identityDerivation:n.identityDerivation}:{}),identityBasis:canonicalSubject.basis,comparisonIdentity:{subject:canonicalSubject.reference,fields:n.references.map(ref=>({reference:ref,canonicalReference:resolve(ref).reference,basis:resolve(ref).basis}))},originSystem:source.originSystem??null,copiedFromSource:source.copiedFromSource??null},
  comparisonScope:{caseId,line,shipment,direction:hasReturn?'return':shipment?'outbound':'unknown',tracking:unique('tracking'),load:unique('load'),stop:unique('stop'),subjectNamespace:canonicalSubject.reference.namespace,handlingUnit:unique('handling_unit'),serializedUnit:unique('serialized_unit')}};
}
export async function readCaseSourceKeys(db:Database,w:RecordWorkspace,c:CaseRow):Promise<string[]> {
 const rows=(await db.query<{subscription_id:string;connection_id:string;source_namespace:string}>(`SELECT DISTINCT b.subscription_id,b.connection_id,b.source_namespace FROM record_typed_rows r JOIN record_typed_batches b ON b.id=r.batch_id WHERE r.id IN ${caseObservationCandidatesSql('$1')} AND ${currentCaseObservationSql('r','$1')} AND b.organization_id=$2 AND b.environment=$3 AND b.location_id=$4 AND b.operator_membership_id=$5 ORDER BY b.subscription_id,b.connection_id,b.source_namespace LIMIT 501`,[c.id,w.organizationId,w.environment,c.location_id,c.operator_membership_id])).rows;
 if(rows.length>500)throw new DomainError('CASE_SOURCE_LIMIT','This case exceeds the supported 500-source dependency profile. Review its source grants before reconstructing it.',409);
 return rows.map(row=>canonicalize([row.subscription_id,row.connection_id,row.source_namespace]));
}
export async function includePolicySourceCoverage(db:Database,clock:Clock,w:RecordWorkspace,c:CaseRow,sources:SourceCoverage[]) {
 const seen=new Set(sources.map(s=>s.subscriptionId));
 for(let index=0;index<sources.length;index++)for(const binding of referencedRuleSources(sources[index].rulePolicies)){
  if(seen.has(binding.subscriptionId))continue;seen.add(binding.subscriptionId);
  const s=(await db.query<{connection_id:string;source_namespace:string}>(`SELECT s.connection_id,revision.configuration->>'sourceNamespace' source_namespace FROM record_source_subscriptions s JOIN record_source_subscription_revisions revision ON revision.subscription_id=s.id AND revision.revision=s.configuration_revision WHERE s.id=$1 AND s.organization_id=$2 AND s.environment=$3 AND s.location_id=$4 AND s.operator_membership_id=$5 AND revision.configuration->>'sourceNamespace'=$6`,[binding.subscriptionId,w.organizationId,w.environment,c.location_id,c.operator_membership_id,binding.sourceNamespace])).rows[0];
  if(s&&sources.length>=500)throw new DomainError('CASE_SOURCE_LIMIT','This case exceeds the supported 500-source dependency profile. Review its source grants before reconstructing it.',409);
  if(s)sources.push(await readCaseSourceCoverage(db,clock,w,c,binding.subscriptionId,s.connection_id,s.source_namespace));
 }
}

/** Candidate IDs use the case indexes before authoritative current-head checks.
 * The union includes multi-case rows whose legacy primary pointer is null. */
export function caseObservationCandidatesSql(caseExpression:string){
 return `(SELECT candidate_projection.observation_id FROM record_case_row_projections candidate_projection WHERE candidate_projection.case_id=${caseExpression} AND candidate_projection.state='linked' AND NOT EXISTS(SELECT 1 FROM record_case_row_projections candidate_successor WHERE candidate_successor.supersedes_id=candidate_projection.id) UNION SELECT candidate_row.id FROM record_typed_rows candidate_row WHERE candidate_row.case_id=${caseExpression} AND candidate_row.status='accepted_linked' AND NOT EXISTS(SELECT 1 FROM record_case_row_projections candidate_any WHERE candidate_any.observation_id=candidate_row.id))`;
}
