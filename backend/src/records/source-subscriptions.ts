import type {Database} from '../db/database.js';
import type {Clock} from '../clock.js';
import {DomainError} from '../domain/errors.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {idempotent} from '../platform/idempotency.js';
import {organizationAdmin,reauthorizePartner,strictBody,auditOrganization,type PartnerActor} from '../platform/organizations.js';
import {requireRecordLocation,reauthorizeRecordWorkspace,type RecordWorkspace} from './access.js';
import {explicitInstant} from './csv-semantics.js';
import {SOURCE_PROFILES,TYPED_SOURCE_LIMITS,SOURCE_CSV_FIELDS,SOURCE_PROPERTIES} from './source-profiles.js';
import {requireReconstructionFeature,reconstructionFeatureEnabled,typedCollectorVersionSupported} from './reconstruction-features.js';

export interface SourceSubscriptionConfig {
 transport:'local_ntfs'|'partner_api';displayName:string;sourceProfile:string;mappingVersion:string;sourceNamespace:string;
 mapping:Record<string,string>;constants:Record<string,string>;wholeFileConsent:true;
 folderDigest:string|null;initialFileName:string|null;initialOriginalSha256:string|null;expectedHeaders:string[];
 historyFrom:string;historyTo:string|null;unknownTimePolicy:'quarantine'|'retain_unknown';maxBytes:number;maxRows:number;offlineWindowHours:number;expectedIntervalSeconds:number|null;
 completenessPolicy:{kind:'unknown'|'snapshot'|'sequence';scope:'shipment_line';sourceOwnerQualified:boolean;qualificationReference:string|null};
}
interface SubscriptionRow {
 id:string;organization_id:string;environment:'sandbox'|'live';connection_id:string;principal_id:string;installation_id:string|null;
 operator_membership_id:string;location_id:string;configuration_revision:number;grant_revision:number;
 state:'proposed'|'approved'|'active'|'paused'|'revoked';configuration:SourceSubscriptionConfig;configuration_sha256:string;
 verified_batch_id:string|null;recurring_approved_by:string|null;
 last_check_at:Date|string|null;source_as_of:Date|string|null;heartbeat:Record<string,unknown>;updated_at:Date|string;
}
const invalid=(message:string)=>new DomainError('INVALID_SOURCE_SUBSCRIPTION',message,400);
function text(value:unknown,name:string,max=200){if(typeof value!=='string'||!value.trim()||value.length>max||value!==value.trim())throw invalid(`Supply an exact ${name} of at most ${max} characters`);return value;}
function digest(value:unknown,name:string){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw invalid(`Supply the SHA-256 ${name}`);return value;}
function timestamp(value:unknown,name:string){if(typeof value!=='string'||explicitInstant(value)===null)throw invalid(`Supply ${name} with an explicit UTC offset`);return value;}
function stringMap(value:unknown,name:string){const b=value??{};if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length>50||Object.entries(b).some(([k,v])=>!k||k.length>100||typeof v!=='string'||!v||v.length>200))throw invalid(`Supply a bounded ${name}`);return b as Record<string,string>;}
export function parseSourceSubscriptionConfig(input:unknown):SourceSubscriptionConfig {
 const c=strictBody(input,['transport','displayName','sourceProfile','mappingVersion','sourceNamespace','mapping','constants','wholeFileConsent','folderDigest','initialFileName','initialOriginalSha256','expectedHeaders','historyFrom','historyTo','unknownTimePolicy','maxBytes','maxRows','offlineWindowHours','expectedIntervalSeconds','completenessPolicy']);
 if(c.transport!=='local_ntfs'&&c.transport!=='partner_api')throw invalid('Choose a qualified local export or partner API transport');
 if(!SOURCE_PROFILES.some(p=>p.id===c.sourceProfile))throw invalid('Choose a supported source profile version');
 if(c.wholeFileConsent!==true)throw invalid('Approve upload of the whole original, including unmapped fields');
 const headers=c.expectedHeaders??[];
 if(!Array.isArray(headers)||headers.length>50||headers.some(h=>typeof h!=='string'||!h||h.length>200)||new Set(headers).size!==headers.length)throw invalid('Confirm at most 50 exact unique source headers');
 const mapping=stringMap(c.mapping,'mapping'),constants=stringMap(c.constants,'mapping constants');
 if(Object.keys(mapping).some(field=>!(SOURCE_CSV_FIELDS as readonly string[]).includes(field))||Object.keys(constants).some(field=>!['observationKind','property','timeQuality'].includes(field)))throw invalid('Approve only documented source fields and semantic constants');
 if(new Set(Object.values(mapping)).size!==Object.keys(mapping).length||Object.keys(constants).some(field=>Object.hasOwn(mapping,field)))throw invalid('Each source column or semantic constant must have one explicit field meaning');
 if(headers.length&&Object.values(mapping).some(header=>!headers.includes(header)))throw invalid('Every mapped column must name an exact approved original heading');
 if(constants.observationKind&&!['event','snapshot','correction','tombstone'].includes(constants.observationKind)||constants.timeQuality&&!['event_time','snapshot_time_only','unknown'].includes(constants.timeQuality)||constants.property&&!(SOURCE_PROPERTIES as readonly string[]).includes(constants.property))throw invalid('Source constants must use the versioned profile vocabulary');
 if(constants.property&&!SOURCE_PROFILES.find(p=>p.id===c.sourceProfile)!.allowedProperties.includes(constants.property as typeof SOURCE_PROPERTIES[number]))throw invalid('The declared property is unsupported by this source profile');
 const local=c.transport==='local_ntfs';
 const folderDigest=local?digest(c.folderDigest,'approved source path digest'):null;
 const initialFileName=local?text(c.initialFileName,'initial file name',255):null;
 if(initialFileName&&(!/\.csv$/i.test(initialFileName)||/[\\/:]/.test(initialFileName)))throw invalid('The approved initial file must be a plain CSV filename');
 const initialOriginalSha256=c.initialOriginalSha256==null?null:digest(c.initialOriginalSha256,'initial original digest');
 if(local&&(!initialOriginalSha256||!headers.length))throw invalid('Review the exact first original and its complete header schema');
 const historyFrom=timestamp(c.historyFrom,'history start'),historyTo=c.historyTo==null?null:timestamp(c.historyTo,'history end');
 if(historyTo&&Date.parse(historyTo)<Date.parse(historyFrom))throw invalid('History end must follow history start');
 const unknownTimePolicy=c.unknownTimePolicy??'quarantine';if(!['quarantine','retain_unknown'].includes(String(unknownTimePolicy)))throw invalid('Choose quarantine or explicitly retain unknown source times');
 const maxBytes=c.maxBytes??TYPED_SOURCE_LIMITS.bytes,maxRows=c.maxRows??TYPED_SOURCE_LIMITS.rows,offlineWindowHours=c.offlineWindowHours??24,expectedIntervalSeconds=c.expectedIntervalSeconds??null;
 if(!Number.isSafeInteger(maxBytes)||Number(maxBytes)<1||Number(maxBytes)>TYPED_SOURCE_LIMITS.bytes||!Number.isSafeInteger(maxRows)||Number(maxRows)<1||Number(maxRows)>TYPED_SOURCE_LIMITS.rows)throw invalid('Keep source byte and row limits inside the qualified bounded transport');
 if(!Number.isSafeInteger(offlineWindowHours)||Number(offlineWindowHours)<1||Number(offlineWindowHours)>168)throw invalid('Choose a one to 168 hour offline policy');
 if(expectedIntervalSeconds!==null&&(!Number.isSafeInteger(expectedIntervalSeconds)||Number(expectedIntervalSeconds)<60||Number(expectedIntervalSeconds)>604800))throw invalid('Choose a known source cadence from one minute to seven days or leave it unknown');
 const p=strictBody(c.completenessPolicy??{kind:'unknown',scope:'shipment_line',sourceOwnerQualified:false,qualificationReference:null},['kind','scope','sourceOwnerQualified','qualificationReference']);
 if(!['unknown','snapshot','sequence'].includes(String(p.kind))||p.scope!=='shipment_line'||typeof p.sourceOwnerQualified!=='boolean')throw invalid('Declare the source completeness policy separately from its latest receipt');
 const qualificationReference=p.qualificationReference==null?null:text(p.qualificationReference,'source-owner qualification reference',500);
 if(p.sourceOwnerQualified&&(p.kind==='unknown'||!qualificationReference))throw invalid('Source-owner qualification requires a documented completeness contract');
 return {transport:c.transport,displayName:text(c.displayName,'source name',100),sourceProfile:String(c.sourceProfile),mappingVersion:text(c.mappingVersion,'mapping version'),sourceNamespace:text(c.sourceNamespace,'source namespace'),mapping,constants,wholeFileConsent:true,folderDigest,initialFileName,initialOriginalSha256,expectedHeaders:headers as string[],historyFrom,historyTo,unknownTimePolicy:unknownTimePolicy as 'quarantine'|'retain_unknown',maxBytes:Number(maxBytes),maxRows:Number(maxRows),offlineWindowHours:Number(offlineWindowHours),expectedIntervalSeconds:expectedIntervalSeconds===null?null:Number(expectedIntervalSeconds),completenessPolicy:{kind:p.kind as 'unknown'|'snapshot'|'sequence',scope:'shipment_line',sourceOwnerQualified:p.sourceOwnerQualified,qualificationReference}};
}
const select=`SELECT s.*,r.configuration,r.configuration_sha256 FROM record_source_subscriptions s JOIN record_source_subscription_revisions r ON r.subscription_id=s.id AND r.revision=s.configuration_revision`;
const iso=(v:Date|string|null)=>v===null?null:new Date(v).toISOString();
function view(r:SubscriptionRow){return {id:r.id,subscriptionId:r.id,configurationRevision:Number(r.configuration_revision),grantRevision:Number(r.grant_revision),state:r.state,installationId:r.installation_id,connectionId:r.connection_id,locationId:r.location_id,operatorMembershipId:r.operator_membership_id,config:r.configuration,configurationSha256:r.configuration_sha256,lastCheckAt:iso(r.last_check_at),sourceAsOf:iso(r.source_as_of),heartbeat:r.heartbeat,updatedAt:iso(r.updated_at),capabilities:{typedCollection:r.state==='active'&&reconstructionFeatureEnabled('multiSourceAgent')&&reconstructionFeatureEnabled('typedIntake'),preview:['approved','active'].includes(r.state),wholeOriginal:true,maximumBytes:r.configuration.maxBytes,maximumRows:r.configuration.maxRows}};}
async function currentOperator(db:Database,r:SubscriptionRow){
 const ok=(await db.query(`SELECT 1 FROM platform_memberships m JOIN users u ON u.id=m.user_id JOIN platform_integration_accounts a ON a.id=$4 AND a.merchant_id=m.organization_id AND a.environment=$5 LEFT JOIN record_connection_state s ON s.connection_id=a.id WHERE m.id=$1 AND m.organization_id=$2 AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN','OPERATOR') AND u.status='ACTIVE' AND COALESCE(s.paused,false)=false AND (m.location_scoped=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=m.id AND g.organization_id=m.organization_id AND g.location_id=$3))`,[r.operator_membership_id,r.organization_id,r.location_id,r.connection_id,r.environment])).rows[0];
 if(!ok)throw new DomainError('SOURCE_AUTHORIZATION_REQUIRED','The source needs current operator, location and connection approval',403);
}
async function human(db:Database,w:RecordWorkspace,write=false){requireReconstructionFeature('sourceSubscriptions');if(w.partner)throw new DomainError('HUMAN_AUTHENTICATION_REQUIRED','Source approvals require an administrator session',403);const current=await reauthorizeRecordWorkspace(db,w,write);if(write)await organizationAdmin(db,current.userId,current.organizationId);return current;}
async function owned(db:Database,w:RecordWorkspace,id:string,lock=false){const r=(await db.query<SubscriptionRow>(`${select} WHERE s.id=$1 AND s.organization_id=$2 AND s.environment=$3${lock?' FOR UPDATE OF s':''}`,[id,w.organizationId,w.environment])).rows[0];if(!r)throw new DomainError('SOURCE_SUBSCRIPTION_NOT_FOUND','Source subscription not found',404);await requireRecordLocation(db,w,r.location_id);if(w.role==='OPERATOR'&&r.operator_membership_id!==w.membershipId)throw new DomainError('SOURCE_SUBSCRIPTION_NOT_FOUND','Source subscription not found',404);return r;}
export async function listSourceSubscriptions(db:Database,w:RecordWorkspace,query:Record<string,unknown>={}){
 const current=await human(db,w);const limit=50,cursor=typeof query.cursor==='string'?query.cursor:'';
 const rows=(await db.query<SubscriptionRow>(`${select} WHERE s.organization_id=$1 AND s.environment=$2 AND s.id>$3 AND ($4::text<>'OPERATOR' OR s.operator_membership_id=$5) AND ($6::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.organization_id=s.organization_id AND g.membership_id=$5 AND g.location_id=s.location_id)) ORDER BY s.id LIMIT $7`,[current.organizationId,current.environment,cursor,current.role,current.membershipId,current.locationScoped,limit+1])).rows;
 return {schema:'packproof.source-subscriptions/v1',subscriptions:rows.slice(0,limit).map(view),nextCursor:rows.length>limit?rows[limit-1].id:null};
}
export async function getSourceSubscription(db:Database,w:RecordWorkspace,id:string,initialBatchId?:unknown){
 const current=await human(db,w),row=await owned(db,current,id);
 let firstBatch:unknown=null;
 if(initialBatchId!=null){
  const batchId=text(initialBatchId,'initial receipt ID');
  const b=(await db.query<{id:string;state:string;original_sha256:string;row_count:number}>(`SELECT id,state,original_sha256,row_count FROM record_typed_batches WHERE id=$1 AND subscription_id=$2 AND configuration_revision=$3 AND organization_id=$4 AND environment=$5`,[batchId,id,row.configuration_revision,current.organizationId,current.environment])).rows[0];
  if(!b)throw new DomainError('TYPED_IMPORT_NOT_FOUND','This receipt is not part of the current approved source',404);
  const counts=(await db.query<{status:string;n:string}>('SELECT status,COUNT(*)::text n FROM record_typed_rows WHERE batch_id=$1 GROUP BY status',[batchId])).rows;
  const linkedCases=(await db.query<{id:string;reference:string}>(`SELECT DISTINCT c.id,c.root_external_id reference FROM record_cases c JOIN record_typed_rows r ON r.case_id=c.id WHERE r.batch_id=$1 AND r.status='accepted_linked' AND c.organization_id=$2 AND c.environment=$3 AND c.location_id=$4 AND c.operator_membership_id=$5 ORDER BY c.id`,[batchId,current.organizationId,current.environment,row.location_id,row.operator_membership_id])).rows;
  const accounting=Object.fromEntries(counts.map(c=>[c.status,Number(c.n)]));
  const total=counts.reduce((n,c)=>n+Number(c.n),0),errors=counts.some(c=>!['accepted_linked','duplicate'].includes(c.status));
  firstBatch={id:b.id,state:b.state,originalSha256:b.original_sha256,linkedCases,counts:accounting,eligibleForRecurring:b.state==='succeeded'&&total===Number(b.row_count)&&Number(accounting.accepted_linked)>0&&!errors&&(!row.configuration.initialOriginalSha256||b.original_sha256===row.configuration.initialOriginalSha256)};
 }
 return {...view(row),firstBatch};
}
/** Called inside the existing human command transaction/idempotency boundary. */
export async function proposeSourceSubscription(db:Database,clock:Clock,w:RecordWorkspace,input:unknown,requestId:string){
 const current=await human(db,w,true),b=strictBody(input,['organizationId','environment','connectionId','principalId','installationId','operatorMembershipId','locationId','config']),config=parseSourceSubscriptionConfig(b.config);
 const connectionId=text(b.connectionId,'connection ID'),principalId=text(b.principalId,'service principal ID'),operatorMembershipId=text(b.operatorMembershipId,'operator membership ID'),locationId=await requireRecordLocation(db,current,text(b.locationId,'site ID')),installationId=b.installationId==null?null:text(b.installationId,'installation ID');
 if((config.transport==='local_ntfs')!==!!installationId)throw invalid('Local export sources must bind an existing installation; API sources use their own principal');
 const id=newId('source_subscription'),now=clock.now().toISOString();
 await db.query(`INSERT INTO record_source_subscriptions(id,organization_id,environment,connection_id,principal_id,installation_id,operator_membership_id,location_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,[id,current.organizationId,current.environment,connectionId,principalId,installationId,operatorMembershipId,locationId,now]);
 await db.query('INSERT INTO record_source_subscription_revisions(subscription_id,revision,configuration,configuration_sha256,created_by,created_at) VALUES($1,1,$2::jsonb,$3,$4,$5)',[id,JSON.stringify(config),sha256Hex(canonicalize(config)),current.userId,now]);
 await currentOperator(db,await owned(db,current,id));
 await auditOrganization(db,clock,{userId:current.userId,merchantId:current.organizationId,requestId,operation:'SOURCE_SUBSCRIPTION_PROPOSED',resourceId:id});return view(await owned(db,current,id));
}
/** Installations may propose their own local source; only a human can grant it.
 * No new path is read or accepted by this command and no existing CSV grant is
 * expanded. The local service separately checks the selected NTFS directory. */
export async function proposeAgentSourceSubscription(db:Database,clock:Clock,actor:PartnerActor,input:unknown,key:unknown){
 requireReconstructionFeature('multiSourceAgent');requireReconstructionFeature('sourceSubscriptions');
 const b=strictBody(input,['config']),config=parseSourceSubscriptionConfig(b.config);
 if(config.transport!=='local_ntfs')throw invalid('An installation may propose only a local NTFS export source');
 const authority=async(tx:Database)=>{
  await reauthorizePartner(tx,clock,actor,'imports:write');
  const i=(await tx.query<{id:string;organization_id:string;environment:string;principal_id:string;credential_id:string;operator_membership_id:string;integration_account_id:string;location_id:string|null;status:string;enrollment_acknowledged_at:unknown;renewal_credential_id:string|null}>('SELECT * FROM record_agent_installations WHERE principal_id=$1 AND organization_id=$2 AND environment=$3 FOR SHARE',[actor.principalId,actor.merchantId,actor.environment])).rows[0];
  if(!i||!['ready','active'].includes(i.status)||i.credential_id!==actor.credentialId||i.renewal_credential_id||!i.enrollment_acknowledged_at||!i.location_id||actor.delegationGrantId)throw new DomainError('AGENT_AUTHORIZATION_REQUIRED','Approve this installation and its site before adding a source',403);
  return i;
 };
 await authority(db);
 const result=await idempotent(db,clock,actor.tenantId,`source-proposal:${actor.principalId}:${actor.credentialId}`,key,input,async tx=>{
  const i=await authority(tx),id=newId('source_subscription'),now=clock.now().toISOString();
  await tx.query('INSERT INTO record_source_subscriptions(id,organization_id,environment,connection_id,principal_id,installation_id,operator_membership_id,location_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',[id,actor.merchantId,actor.environment,i.integration_account_id,actor.principalId,i.id,i.operator_membership_id,i.location_id,now]);
  await tx.query('INSERT INTO record_source_subscription_revisions(subscription_id,revision,configuration,configuration_sha256,created_by,created_at) VALUES($1,1,$2::jsonb,$3,$4,$5)',[id,JSON.stringify(config),sha256Hex(canonicalize(config)),actor.actorUserId,now]);
  await auditOrganization(tx,clock,{actor,requestId:actor.requestId,operation:'SOURCE_SUBSCRIPTION_PROPOSED',resourceId:id});
  return {subscriptionId:id,configurationRevision:1,state:'proposed',installationId:i.id,approvalPath:`/app/records/connect/approve?installationId=${encodeURIComponent(i.id)}&subscriptionId=${encodeURIComponent(id)}`};
 });
 await authority(db);return {...result.value,replayed:result.replayed};
}
export async function actOnSourceSubscription(db:Database,clock:Clock,w:RecordWorkspace,id:string,input:unknown,requestId:string){
 const current=await human(db,w,true),b=strictBody(input,['organizationId','environment','action','configurationRevision','configurationSha256','wholeFileConsent','recurringConsent','initialBatchId','reason','config']);
 // Match installed-agent authority lock ordering: principal, then source row.
 // Workers share the principal lock without gaining UPDATE on grant columns.
 const prior=await owned(db,current,id);
 await db.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[prior.principal_id]);
 const row=await owned(db,current,id,true);
 if(b.configurationRevision!==Number(row.configuration_revision))throw new DomainError('SOURCE_CONFIGURATION_CHANGED','Review the current source configuration before approving this action',412);
 if(row.state==='revoked')throw new DomainError('SOURCE_REVOKED','Revoked sources require a new explicit subscription',409);
 const now=clock.now().toISOString();
 if(b.action==='revise'){
  const config=parseSourceSubscriptionConfig(b.config),revision=Number(row.configuration_revision)+1;
  await db.query('INSERT INTO record_source_subscription_revisions(subscription_id,revision,configuration,configuration_sha256,created_by,created_at) VALUES($1,$2,$3::jsonb,$4,$5,$6)',[id,revision,JSON.stringify(config),sha256Hex(canonicalize(config)),current.userId,now]);
  await db.query("UPDATE record_source_subscriptions SET configuration_revision=$2,grant_revision=grant_revision+1,state='proposed',approved_by=NULL,recurring_approved_by=NULL,verified_batch_id=NULL,last_check_at=NULL,source_as_of=NULL,heartbeat='{}',updated_at=$3 WHERE id=$1",[id,revision,now]);
 }else if(b.action==='approve'){
  await currentOperator(db,row);
  if(row.state!=='proposed'||b.configurationSha256!==row.configuration_sha256||b.wholeFileConsent!==true)throw invalid('Review and approve the exact whole-original source configuration');
  await db.query("UPDATE record_source_subscriptions SET state='approved',approved_by=$2,grant_revision=grant_revision+1,updated_at=$3 WHERE id=$1",[id,current.userId,now]);
 }else if(b.action==='activate'){
  await currentOperator(db,row);
  if(row.state!=='approved'||b.recurringConsent!==true)throw invalid('Approve recurring collection separately after the first real case is available');
  const batchId=text(b.initialBatchId,'initial receipt ID');
  const batch=(await db.query<{original_sha256:string;state:string;row_count:number;total:string;linked:string;bad:string}>(`SELECT b.original_sha256,b.state,b.row_count,COUNT(*)::text total,COUNT(*) FILTER(WHERE r.status='accepted_linked')::text linked,COUNT(*) FILTER(WHERE r.status NOT IN ('accepted_linked','duplicate'))::text bad FROM record_typed_batches b JOIN record_typed_rows r ON r.batch_id=b.id WHERE b.id=$1 AND b.subscription_id=$2 AND b.configuration_revision=$3 AND b.organization_id=$4 AND b.environment=$5 GROUP BY b.id`,[batchId,id,row.configuration_revision,row.organization_id,row.environment])).rows[0];
  if(!batch||batch.state!=='succeeded'||Number(batch.total)!==Number(batch.row_count)||Number(batch.linked)<1||Number(batch.bad)>0||(row.configuration.initialOriginalSha256&&batch.original_sha256!==row.configuration.initialOriginalSha256))throw new DomainError('SOURCE_FIRST_RECORD_REQUIRED','The exact approved first original must finish with linked records before recurring collection',409);
  await db.query("UPDATE record_source_subscriptions SET state='active',recurring_approved_by=$2,verified_batch_id=$3,grant_revision=grant_revision+1,updated_at=$4 WHERE id=$1",[id,current.userId,batchId,now]);
 }else if(['pause','resume','revoke'].includes(String(b.action))){
  text(b.reason,'reason',500);
  if(b.action==='resume'){await currentOperator(db,row);if(row.state!=='paused'||!row.verified_batch_id||!row.recurring_approved_by)throw invalid('Resume requires an existing recurring approval and verified receipt');}
  const state=b.action==='pause'?'paused':b.action==='resume'?'active':'revoked';
  await db.query('UPDATE record_source_subscriptions SET state=$2,grant_revision=grant_revision+1,updated_at=$3 WHERE id=$1',[id,state,now]);
 }else throw invalid('Choose approve, revise, activate, pause, resume or revoke');
 await auditOrganization(db,clock,{userId:current.userId,merchantId:current.organizationId,requestId,operation:`SOURCE_SUBSCRIPTION_${String(b.action).toUpperCase()}`,resourceId:id});return view(await owned(db,current,id));
}
export interface TypedSourceAuthorityInput {subscriptionId:string|null;configurationRevision:number|null;grantRevision?:number|null;connectionId:string;locationId:string;sourceProfile:string;mappingVersion:string;sourceNamespace:string;mapping?:unknown;constants?:unknown;originalSha256?:string;originalName?:string;originalMediaType?:string;headers?:string[];wholeFileConsent?:boolean;}
export async function requireTypedSourceAuthority(db:Database,clock:Clock,actor:PartnerActor,input:TypedSourceAuthorityInput,operation:'preview'|'commit'|'read'|'replay'|'export'){
 requireReconstructionFeature('sourceSubscriptions');await reauthorizePartner(db,clock,actor,operation==='read'?'imports:read':'imports:write');
 await db.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[actor.principalId]);
 if(actor.delegationGrantId||actor.principalOrganizationId!==actor.merchantId)throw new DomainError('SOURCE_DELEGATION_UNQUALIFIED','Delegated operational source authority has not been qualified',403);
 const row=(await db.query<SubscriptionRow>(`${select} WHERE s.id=$1 AND s.organization_id=$2 AND s.environment=$3 AND s.principal_id=$4`,[input.subscriptionId,actor.merchantId,actor.environment,actor.principalId])).rows[0];
 if(!row||Number(row.configuration_revision)!==input.configurationRevision||!['approved','active'].includes(row.state))throw new DomainError('SOURCE_AUTHORIZATION_REQUIRED','Use the current approved source revision',403);
 const c=row.configuration;
 if(row.connection_id!==input.connectionId||row.location_id!==input.locationId||c.sourceProfile!==input.sourceProfile||c.mappingVersion!==input.mappingVersion||c.sourceNamespace!==input.sourceNamespace||(input.mapping!==undefined&&canonicalize(c.mapping)!==canonicalize(input.mapping))||(input.constants!==undefined&&canonicalize(c.constants)!==canonicalize(input.constants))||input.wholeFileConsent===false)throw new DomainError('SOURCE_SCOPE_DENIED','The input differs from its approved source configuration',403);
 if(operation==='export')throw new DomainError('SOURCE_OPERATION_DENIED','Collector grants do not authorize investigation sharing',403);
 if(['preview','commit','replay'].includes(operation)){
  if(!Number.isSafeInteger(input.grantRevision)||input.grantRevision!==Number(row.grant_revision))throw new DomainError('SOURCE_GRANT_CHANGED','Use the exact current approved source grant revision; retained work requires explicit recovery',403);
  if(c.transport==='local_ntfs'&&input.originalMediaType!=='text/csv')throw new DomainError('SOURCE_TRANSPORT_DENIED','This approved local export source accepts CSV originals only',403);
  if(input.originalMediaType==='text/csv'&&(!c.expectedHeaders.length||input.headers===undefined||canonicalize(c.expectedHeaders)!==canonicalize(input.headers)))throw new DomainError('SOURCE_SCHEMA_CHANGED','The complete original headers differ from the approved source revision',409);
  if(input.originalMediaType==='application/json'&&c.expectedHeaders.length)throw new DomainError('SOURCE_TRANSPORT_DENIED','This approved source declares a CSV header schema',403);
  if(row.state==='approved'&&c.initialFileName&&input.originalName!==c.initialFileName)throw new DomainError('SOURCE_INITIAL_ORIGINAL_CHANGED','Review the exact named initial original before collection',409);
 }

 if(row.state==='approved'&&['preview','commit','replay'].includes(operation)&&c.initialOriginalSha256&&input.originalSha256!==c.initialOriginalSha256)throw new DomainError('SOURCE_INITIAL_ORIGINAL_CHANGED','Review the exact approved initial file before collection',409);
 await currentOperator(db,row);
 if(row.installation_id){
  requireReconstructionFeature('multiSourceAgent');
  const install=(await db.query<{status:string;version:string;credential_id:string;renewal_credential_id:string|null;enrollment_acknowledged_at:unknown}>('SELECT status,version,credential_id,renewal_credential_id,enrollment_acknowledged_at FROM record_agent_installations WHERE id=$1 AND principal_id=$2 AND organization_id=$3 AND environment=$4',[row.installation_id,actor.principalId,actor.merchantId,actor.environment])).rows[0];
  if(!install||install.status==='revoked'||install.status==='paused'||install.credential_id!==actor.credentialId||install.renewal_credential_id||!install.enrollment_acknowledged_at)throw new DomainError('AGENT_AUTHORIZATION_REQUIRED','This installation requires current source approval',403);
  if(!typedCollectorVersionSupported(install.version))throw new DomainError('SOURCE_COLLECTOR_VERSION_UNSUPPORTED','Install the matching qualified collector candidate before using this source profile',409);
 }
 return {subscriptionId:row.id,configurationRevision:Number(row.configuration_revision),grantRevision:Number(row.grant_revision),operatorMembershipId:row.operator_membership_id,installationId:row.installation_id,config:c};
}
export async function listAgentSourceSubscriptions(db:Database,clock:Clock,actor:PartnerActor,query:Record<string,unknown>={}){
 requireReconstructionFeature('multiSourceAgent');requireReconstructionFeature('sourceSubscriptions');await reauthorizePartner(db,clock,actor,'imports:read');
 const cursor=typeof query.cursor==='string'?query.cursor:'',rows=(await db.query<SubscriptionRow>(`${select} WHERE s.organization_id=$1 AND s.environment=$2 AND s.principal_id=$3 AND s.id>$4 ORDER BY s.id LIMIT 51`,[actor.merchantId,actor.environment,actor.principalId,cursor])).rows;
 const subscriptions=[];
 for(const r of rows.slice(0,50)){try{await currentOperator(db,r);subscriptions.push(view(r));}catch{subscriptions.push({...view(r),state:'paused',capabilities:{typedCollection:false,preview:false,wholeOriginal:true,maximumBytes:r.configuration.maxBytes,maximumRows:r.configuration.maxRows},authorization:'current_policy_denied'});}}
 const credential=(await db.query<{expires_at:Date|string}>('SELECT expires_at FROM platform_credentials WHERE id=$1',[actor.credentialId])).rows[0];
 await reauthorizePartner(db,clock,actor,'imports:read');
 return {schema:'packproof.source-subscriptions/v1',capabilities:{typedCollection:reconstructionFeatureEnabled('typedIntake')},subscriptions,nextCursor:rows.length>50?rows[49].id:null,serverTime:clock.now().toISOString(),credentialExpiresAt:credential?iso(credential.expires_at):null};
}
export async function heartbeatSourceSubscription(db:Database,clock:Clock,actor:PartnerActor,id:string,input:unknown,key:unknown){
 const b=strictBody(input,['configurationRevision','grantRevision','state','sourceAsOf','checkpoint','errorCode','backlog','oldestPendingAt']);
 if(!['checked','quiet','delayed','mapping_drift','source_unreadable','storage_pressure'].includes(String(b.state)))throw invalid('Report a documented source check state');
 if(b.sourceAsOf!==null&&b.sourceAsOf!==undefined)timestamp(b.sourceAsOf,'source as-of time');
 if(b.checkpoint!=null&&String(b.checkpoint).length>256)throw invalid('Use a bounded opaque checkpoint');
 if(b.errorCode!=null&&!/^[A-Z0-9_]{1,100}$/.test(String(b.errorCode)))throw invalid('Use a safe diagnostic code');
 if(!Number.isSafeInteger(b.backlog)||Number(b.backlog)<0)throw invalid('Report a nonnegative backlog');
 if(b.oldestPendingAt!=null)timestamp(b.oldestPendingAt,'oldest backlog receipt time');
 const row=(await db.query<SubscriptionRow>(`${select} WHERE s.id=$1 AND s.organization_id=$2 AND s.environment=$3 AND s.principal_id=$4`,[id,actor.merchantId,actor.environment,actor.principalId])).rows[0];
 if(!row)throw new DomainError('SOURCE_SUBSCRIPTION_NOT_FOUND','Source subscription not found',404);
 const identity={subscriptionId:id,configurationRevision:Number(b.configurationRevision),grantRevision:Number(b.grantRevision),connectionId:row.connection_id,locationId:row.location_id,sourceProfile:row.configuration.sourceProfile,mappingVersion:row.configuration.mappingVersion,sourceNamespace:row.configuration.sourceNamespace};
 const authorized=await requireTypedSourceAuthority(db,clock,actor,identity,'read');if(!Number.isSafeInteger(b.grantRevision)||authorized.grantRevision!==identity.grantRevision)throw new DomainError('SOURCE_GRANT_CHANGED','Report this source under its exact current approved grant revision',403);
 const result=await idempotent(db,clock,actor.tenantId,`source-heartbeat:${actor.principalId}:${actor.credentialId}:${id}`,key,input,async tx=>{const current=await requireTypedSourceAuthority(tx,clock,actor,identity,'read');if(current.grantRevision!==identity.grantRevision)throw new DomainError('SOURCE_GRANT_CHANGED','Source approval changed before this source check was recorded',403);await tx.query('UPDATE record_source_subscriptions SET last_check_at=$2,source_as_of=$3,heartbeat=$4::jsonb,updated_at=$2 WHERE id=$1',[id,clock.now().toISOString(),b.sourceAsOf??null,JSON.stringify(b)]);return {subscriptionId:id,accepted:true,serverTime:clock.now().toISOString()};});
 const current=await requireTypedSourceAuthority(db,clock,actor,identity,'read');if(current.grantRevision!==identity.grantRevision)throw new DomainError('SOURCE_GRANT_CHANGED','Source approval changed before this source check was returned',403);return {...result.value,replayed:result.replayed};
}
