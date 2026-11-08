import { createHmac,timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { appendAudit } from '../domain/audit.js';
import { asRequiredIso } from '../domain/types.js';
import { strictBody } from '../platform/organizations.js';
import { textField } from '../platform/tenants.js';
import { requireRecordAccess,requireRecordLocation,requireRecordWorkspace,reauthorizeRecordWorkspace,type RecordWorkspace } from './access.js';
import type { RecordSummary,RecordEvidence,RecordRequirement,RecordIssue,RecordTimelineEvent } from './types.js';
import {normalizeQuantityComparison,normalizeItemAllocation} from './quantities.js';

const json=(v:unknown):any=>typeof v==='string'?JSON.parse(v):v;
const date=(v:unknown)=>v==null?null:asRequiredIso(v as string|Date);
const SECRET=/authorization|token|password|secret|credential|cookie|signed.?url|object.?key|launch/i;
export function safeRecordData(value:unknown,depth=0):any {
  if(depth>8)return '[nested data omitted]';
  if(Array.isArray(value))return value.slice(0,100).map(v=>safeRecordData(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!SECRET.test(k)).map(([k,v])=>[k,safeRecordData(v,depth+1)]));
  return typeof value==='string'?value.slice(0,2000):value;
}
function instant(v:unknown,name:string) {
  if(v==null||v==='')return null;
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))throw new DomainError('INVALID_DATE',`${name} must include a time zone`,400);
  return new Date(v).toISOString();
}
function optionalText(v:unknown,name:string,max=200):string|null {
  if(v==null)return null;return textField(v,name,max);
}
export function expectedRevision(value:unknown):number {
  const raw=typeof value==='string'?value.replace(/^"|"$/g,''):'';
  if(!/^[1-9]\d{0,8}$/.test(raw))throw new DomainError('REVISION_REQUIRED','Send the current record revision in If-Match',428);
  return Number(raw);
}
const FROM=`FROM platform_proof_ownership o JOIN proofs p ON p.id=o.proof_id JOIN transactions t ON t.id=p.transaction_id
  LEFT JOIN transaction_shipping sh ON sh.transaction_id=t.id LEFT JOIN record_state s ON s.proof_id=p.id`;
const VISIBLE=`o.merchant_id=$1 AND o.environment=$2 AND ($3::text<>'OPERATOR' OR o.operator_membership_id=$4)
  AND ($5::boolean=false OR EXISTS(SELECT 1 FROM record_membership_locations lg WHERE lg.membership_id=$4 AND lg.organization_id=o.merchant_id AND lg.location_id=s.location_id))`;
const BASE=`SELECT p.id,p.created_at,GREATEST(p.updated_at,COALESCE(s.updated_at,p.updated_at)) AS updated_at,
  COALESCE(s.title,t.item_title) AS title,COALESCE(s.reference,t.external_reference) AS reference,sh.tracking_number,sh.carrier,
  COALESCE(s.revision,1) AS revision,COALESCE(s.lifecycle,'open') AS lifecycle,COALESCE(s.review_state,'unreviewed') AS review_state,
  s.location_id,p.manifest_id,p.status AS core_status,o.merchant_id,o.environment,o.operator_membership_id,
  COALESCE((SELECT jsonb_object_agg(ec.kind,ec.quantity) FROM (SELECT e.kind,count(*)::integer AS quantity FROM record_entities e WHERE e.proof_id=p.id
    AND NOT EXISTS(SELECT 1 FROM record_entities newer WHERE newer.proof_id=p.id AND newer.supersedes_id=e.id) GROUP BY e.kind) ec),'{}'::jsonb) AS entity_counts,
  COALESCE((SELECT a.provider FROM platform_external_bindings b JOIN platform_integration_accounts a ON a.id=b.integration_account_id
    WHERE b.proof_id=p.id ORDER BY b.created_at,b.external_id LIMIT 1),'API') AS source_name`;
const scopeParams=(w:RecordWorkspace):unknown[]=>[w.organizationId,w.environment,w.partner?'SERVICE':w.role,w.membershipId,w.locationScoped];
const actorScope=(w:RecordWorkspace)=>({userId:w.userId,membershipId:w.membershipId,credentialId:w.partner?.credentialId??null,delegationId:w.partner?.delegationGrantId??null});

function cursorKey() {
  const key=Buffer.from(process.env.PACKPROOF_EVENT_CURSOR_KEY??'','base64');
  if(key.length!==32)throw new DomainError('RECORD_CURSOR_UNAVAILABLE','Record pagination is waiting for cursor configuration',503);return key;
}
function encodeCursor(scope:string,position:{updatedAt:string;id:string},clock:Clock) {
  const body=Buffer.from(JSON.stringify({v:1,scope,...position,expires:clock.now().getTime()+3600000})).toString('base64url');
  return `${body}.${createHmac('sha256',cursorKey()).update(body).digest('base64url')}`;
}
function decodeCursor(value:unknown,scope:string,clock:Clock) {
  try{
    if(typeof value!=='string'||value.length>2000)throw 0;
    const [body,sig,extra]=value.split('.'),actual=Buffer.from(sig??'','base64url'),expected=createHmac('sha256',cursorKey()).update(body).digest();
    if(extra||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw 0;
    const c=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(c.v!==1||c.scope!==scope||!Number.isFinite(Date.parse(c.updatedAt))||typeof c.id!=='string'||!Number.isSafeInteger(c.expires))throw 0;
    if(c.expires<=clock.now().getTime())throw new DomainError('RECORD_CURSOR_EXPIRED','Refresh the record list to start a new page',410);
    return c as {updatedAt:string;id:string};
  }catch(e){if(e instanceof DomainError)throw e;throw new DomainError('INVALID_CURSOR','Use the cursor from this workspace and filter',400);}
}
export async function readRecordRequirements(db:Database,clock:Clock,proofId:string):Promise<RecordRequirement[]> {
  const rows=(await db.query<any>(`SELECT r.*,w.id AS waiver_id,w.reason AS waiver_reason,w.actor_user_id AS waiver_actor,w.created_at AS waiver_created,
    ARRAY(SELECT matching.id FROM (SELECT e.id,e.committed_at AS accepted_at FROM evidence e WHERE e.proof_id=r.proof_id AND e.validation_status='COMMITTED' AND r.accepted_evidence_types ? e.evidence_type
      AND (r.due_at IS NULL OR e.committed_at<=r.due_at+make_interval(secs=>r.grace_period_ms::double precision/1000))
      AND (r.subject_id=r.proof_id OR EXISTS(SELECT 1 FROM record_evidence_links el WHERE el.evidence_id=e.id AND el.proof_id=r.proof_id AND el.subject_id=r.subject_id))
      UNION ALL SELECT a.id,ar.accepted_at FROM record_source_artifacts a JOIN record_source_artifact_results ar ON ar.artifact_id=a.id
      WHERE a.proof_id=r.proof_id AND a.subject_id=r.subject_id AND r.accepted_evidence_types ? 'SOURCE_ARTIFACT'
        AND (r.due_at IS NULL OR ar.accepted_at<=r.due_at+make_interval(secs=>r.grace_period_ms::double precision/1000))) matching
      ORDER BY matching.accepted_at,matching.id LIMIT 100) AS matching_evidence
    FROM record_requirements r LEFT JOIN record_requirement_waivers w ON w.requirement_id=r.id WHERE r.proof_id=$1 ORDER BY r.stage,r.id`,[proofId])).rows;
  return rows.map(r=>{
    const accepted=json(r.accepted_evidence_types) as string[];
    const matches=r.matching_evidence as string[];
    const due=r.due_at?Date.parse(date(r.due_at)!)+Number(r.grace_period_ms):null;
    return {id:r.id,subjectId:r.subject_id,stage:r.stage,title:r.title,templateVersion:r.template_version,acceptedEvidenceTypes:accepted,dueAt:date(r.due_at),gracePeriodMs:Number(r.grace_period_ms),
      status:r.waiver_id?'waived':matches.length?'satisfied':due==null||due>clock.now().getTime()?'not_yet_due':'missing',evidenceIds:matches,
      waiver:r.waiver_id?{id:r.waiver_id,reason:r.waiver_reason,actorId:r.waiver_actor,createdAt:date(r.waiver_created)!}:null};
  });
}
export async function readRecordEvidence(db:Database,proofId:string,limit=100,after:{updatedAt:string;id:string}|null=null):Promise<RecordEvidence[]> {
  const rows=(await db.query<any>(`SELECT e.id,e.evidence_type,e.content_type,e.byte_size,e.sha256,e.validation_status,e.created_at,c.recorded_at AS capture_reported_at,
    COALESCE((SELECT jsonb_agg(l.subject_id ORDER BY l.subject_id) FROM record_evidence_links l WHERE l.proof_id=e.proof_id AND l.evidence_id=e.id),'[]'::jsonb) AS subjects
    FROM evidence e LEFT JOIN capture_sessions c ON c.id=e.capture_session_id WHERE e.proof_id=$1
    AND ($2::timestamptz IS NULL OR (e.created_at,e.id)<($2::timestamptz,$3::text)) ORDER BY e.created_at DESC,e.id DESC LIMIT $4`,[proofId,after?.updatedAt??null,after?.id??null,Math.min(limit,101)])).rows;
  return rows.map(r=>({id:r.id,type:r.evidence_type,contentType:r.content_type,byteSize:r.byte_size==null?null:Number(r.byte_size),sha256:r.sha256,
    state:r.validation_status==='COMMITTED'?'available':r.validation_status==='REJECTED'?'rejected':'pending',receivedAt:date(r.created_at)!,reportedAt:date(r.capture_reported_at),source:'Original capture',subjectIds:[proofId,...json(r.subjects)],original:true}));
}
export async function pageRecordEvidence(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:Record<string,unknown>={}) {
  await requireRecordAccess(db,w,proofId);
  const limit=input.limit==null?50:Number(input.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('INVALID_LIMIT','limit must be from 1 to 100',400);
  const scope=sha256Hex(canonicalize({resource:'record_evidence',proofId,organizationId:w.organizationId,environment:w.environment,actor:actorScope(w),limit}));
  const cursor=input.cursor?decodeCursor(input.cursor,scope,clock):null,rows=await readRecordEvidence(db,proofId,limit+1,cursor),evidence=rows.slice(0,limit),last=evidence.at(-1);
  await requireRecordAccess(db,w,proofId);
  return {evidence,nextCursor:rows.length>limit&&last?encodeCursor(scope,{updatedAt:last.receivedAt,id:last.id},clock):null,hasMore:rows.length>limit};
}
export async function readRecordIssues(db:Database,proofId:string,issueIds:string[]|null=null):Promise<RecordIssue[]> {
  const rows=(await db.query<any>(`SELECT * FROM record_issues WHERE proof_id=$1 AND ($2::text[] IS NULL OR id=ANY($2)) ORDER BY (COALESCE((SELECT a.action FROM record_issue_actions a WHERE a.issue_id=record_issues.id AND a.action<>'note' ORDER BY a.sequence DESC LIMIT 1),'reopen')<>'resolve') DESC,created_at DESC,id DESC LIMIT 500`,[proofId,issueIds])).rows;
  if(!rows.length)return [];
  const actions=(await db.query<any>('SELECT * FROM record_issue_actions WHERE issue_id=ANY($1::text[]) ORDER BY sequence',[rows.map(r=>r.id)])).rows;
  const assignments=(await db.query<any>('SELECT DISTINCT ON(a.issue_id) a.*, (m.id IS NOT NULL AND m.revoked_at IS NULL) AS membership_active FROM record_issue_assignments a LEFT JOIN platform_memberships m ON m.id=a.assignee_membership_id WHERE a.issue_id=ANY($1::text[]) ORDER BY a.issue_id,a.sequence DESC',[rows.map(r=>r.id)])).rows;
  return rows.map(r=>{
    const own=actions.filter(a=>a.issue_id===r.id),last=own.filter(a=>a.action!=='note').at(-1),assignment=assignments.find(a=>a.issue_id===r.id);
    return {id:r.id,proofId:r.proof_id,category:r.category,severity:r.severity,title:r.title,subjectId:r.subject_id,ruleVersion:r.rule_version,comparedSources:safeRecordData(r.compared_sources),
      status:last?.action==='resolve'?'resolved':last?.action==='acknowledge'?'acknowledged':'open',createdAt:date(r.created_at)!,updatedAt:date(own.at(-1)?.created_at??r.created_at)!,
      assignment:assignment?{membershipId:assignment.assignee_membership_id,userId:assignment.assignee_user_id,membershipActive:assignment.membership_active,assignedBy:assignment.actor_user_id,assignedAt:date(assignment.created_at)!,reason:assignment.reason}:null,
      actions:own.map(a=>({id:a.id,action:a.action,reason:a.reason,actorId:a.actor_user_id,createdAt:date(a.created_at)!}))};
  });
}
export async function readRecordTimeline(db:Database,proofId:string,limit=100,after:{updatedAt:string;id:string}|null=null):Promise<RecordTimelineEvent[]> {
  const rows=(await db.query<any>(`SELECT id,event_type AS type,created_at AS received_at,NULL::timestamptz AS reported_at,actor_user_id,'PackProof history' AS source,event_data AS data
    FROM audit_events WHERE proof_id=$1 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text))
    UNION ALL SELECT id,event_type,created_at,occurred_at,NULL::text,provider,event_data FROM shipment_events WHERE proof_id=$1 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text))
    ORDER BY received_at DESC,id DESC LIMIT $2`,[proofId,Math.min(limit,101),after?.updatedAt??null,after?.id??null])).rows;
  return rows.map(r=>({id:r.id,type:r.type,receivedAt:date(r.received_at)!,reportedAt:date(r.reported_at),source:r.source,actorId:r.actor_user_id,subjectId:proofId,data:safeRecordData(r.data)}));
}
export async function pageRecordTimeline(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:Record<string,unknown>={}) {
  await requireRecordAccess(db,w,proofId);
  const limit=input.limit==null?50:Number(input.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('INVALID_LIMIT','limit must be from 1 to 100',400);
  const scope=sha256Hex(canonicalize({resource:'record_timeline',proofId,organizationId:w.organizationId,environment:w.environment,actor:actorScope(w),limit}));
  const cursor=input.cursor?decodeCursor(input.cursor,scope,clock):null,rows=await readRecordTimeline(db,proofId,limit+1,cursor),timeline=rows.slice(0,limit),last=timeline.at(-1);
  await requireRecordAccess(db,w,proofId);
  return {timeline,nextCursor:rows.length>limit&&last?encodeCursor(scope,{updatedAt:last.receivedAt,id:last.id},clock):null,hasMore:rows.length>limit};
}
function coverage(requirements:RecordRequirement[]) {
  return {total:requirements.length,satisfied:requirements.filter(r=>r.status==='satisfied').length,waived:requirements.filter(r=>r.status==='waived').length,missing:requirements.filter(r=>r.status==='missing').length,notYetDue:requirements.filter(r=>r.status==='not_yet_due').length};
}
async function summarize(db:Database,clock:Clock,row:any):Promise<RecordSummary> {
  let checks:RecordSummary['coverage'],issueCount:number;
  if(row.required_count!==undefined){
    checks={total:Number(row.required_count)+Number(row.waived_count),satisfied:Number(row.required_count)-Number(row.unsatisfied_count),waived:Number(row.waived_count),missing:Number(row.missing_count),notYetDue:Number(row.unsatisfied_count)-Number(row.missing_count)};
    issueCount=Number(row.issue_count);
  }else{
    const [requirements,count]=await Promise.all([readRecordRequirements(db,clock,row.id),db.query<{n:number}>("SELECT COUNT(*)::integer AS n FROM record_issues i WHERE i.proof_id=$1 AND COALESCE((SELECT a.action FROM record_issue_actions a WHERE a.issue_id=i.id AND a.action<>'note' ORDER BY a.sequence DESC LIMIT 1),'reopen')<>'resolve'",[row.id])]);
    checks=coverage(requirements);issueCount=count.rows[0].n;
  }
  return {id:row.id,proofId:row.id,organizationId:row.merchant_id,environment:row.environment,reference:row.reference,title:row.title,trackingNumber:row.tracking_number,carrier:row.carrier,
    createdAt:date(row.created_at)!,updatedAt:date(row.updated_at)!,revision:Number(row.revision),lifecycle:row.lifecycle,sample:false,locationId:row.location_id,sourceName:row.source_name,entityCounts:json(row.entity_counts??{}),
    coverage:checks,integrity:row.manifest_id?'sealed':'not_sealed',review:issueCount||checks.missing?'needs_attention':row.review_state,issueCount};
}
/** A single SQL cohort supplies both rows and totals. Access predicates are applied
 * before counts, search, pagination or summary projection. */
export async function listRecords(db:Database,clock:Clock,w:RecordWorkspace,input:Record<string,unknown>={}) {
  await reauthorizeRecordWorkspace(db,w);
  const q=input.q==null||input.q===''?'':textField(input.q,'q',200).trim(),view=String(input.view??'all');
  const views=['all','open','closed','needs_attention','missing','ready','processing','handoffs'];
  if(!views.includes(view))throw new DomainError('INVALID_VIEW','Choose a supported record view',400);
  const from=instant(input.from,'from'),to=instant(input.to,'to');if(from&&to&&from>to)throw new DomainError('INVALID_DATE_RANGE','The end must follow the start',400);
  const location=input.locationId==null||input.locationId===''?null:await requireRecordLocation(db,w,input.locationId);
  const limit=input.limit==null?50:Number(input.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('INVALID_LIMIT','limit must be from 1 to 100',400);
  const scope=sha256Hex(canonicalize({organizationId:w.organizationId,environment:w.environment,actor:actorScope(w),role:w.role,locationScoped:w.locationScoped,q,view,from,to,location,limit}));
  const cursor=input.cursor?decodeCursor(input.cursor,scope,clock):null;
  const params=[...scopeParams(w),q,from,to,location,clock.now().toISOString()];
  const cohort=`WITH cohort AS (${BASE},
    (SELECT count(*)::integer FROM record_requirements r WHERE r.proof_id=p.id AND NOT EXISTS(SELECT 1 FROM record_requirement_waivers rw WHERE rw.requirement_id=r.id)) AS required_count,
    (SELECT count(*)::integer FROM record_requirements r JOIN record_requirement_waivers rw ON rw.requirement_id=r.id WHERE r.proof_id=p.id) AS waived_count,
    (SELECT count(*)::integer FROM record_requirements r WHERE r.proof_id=p.id AND r.due_at+make_interval(secs=>r.grace_period_ms::double precision/1000)<=$10::timestamptz
      AND NOT EXISTS(SELECT 1 FROM record_requirement_waivers rw WHERE rw.requirement_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED' AND r.accepted_evidence_types ? e.evidence_type
        AND e.committed_at<=r.due_at+make_interval(secs=>r.grace_period_ms::double precision/1000)
        AND (r.subject_id=p.id OR EXISTS(SELECT 1 FROM record_evidence_links el WHERE el.evidence_id=e.id AND el.proof_id=p.id AND el.subject_id=r.subject_id)))
      AND NOT EXISTS(SELECT 1 FROM record_source_artifacts a JOIN record_source_artifact_results ar ON ar.artifact_id=a.id
        WHERE a.proof_id=p.id AND a.subject_id=r.subject_id AND r.accepted_evidence_types ? 'SOURCE_ARTIFACT'
        AND ar.accepted_at<=r.due_at+make_interval(secs=>r.grace_period_ms::double precision/1000))) AS missing_count,
    (SELECT count(*)::integer FROM record_requirements r WHERE r.proof_id=p.id AND NOT EXISTS(SELECT 1 FROM record_requirement_waivers rw WHERE rw.requirement_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED' AND r.accepted_evidence_types ? e.evidence_type
        AND (r.due_at IS NULL OR e.committed_at<=r.due_at+make_interval(secs=>r.grace_period_ms::double precision/1000))
        AND (r.subject_id=p.id OR EXISTS(SELECT 1 FROM record_evidence_links el WHERE el.evidence_id=e.id AND el.proof_id=p.id AND el.subject_id=r.subject_id)))
      AND NOT EXISTS(SELECT 1 FROM record_source_artifacts a JOIN record_source_artifact_results ar ON ar.artifact_id=a.id
        WHERE a.proof_id=p.id AND a.subject_id=r.subject_id AND r.accepted_evidence_types ? 'SOURCE_ARTIFACT'
        AND (r.due_at IS NULL OR ar.accepted_at<=r.due_at+make_interval(secs=>r.grace_period_ms::double precision/1000)))) AS unsatisfied_count,
    (SELECT count(*)::integer FROM record_issues i WHERE i.proof_id=p.id AND COALESCE((SELECT a.action FROM record_issue_actions a WHERE a.issue_id=i.id AND a.action<>'note' ORDER BY a.sequence DESC LIMIT 1),'reopen')<>'resolve') AS issue_count,
    EXISTS(SELECT 1 FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='PENDING') AS processing
    ${FROM} WHERE ${VISIBLE} AND ($6='' OR position(lower($6) in lower(concat_ws(' ',p.id,COALESCE(s.reference,t.external_reference),COALESCE(s.title,t.item_title),sh.tracking_number,sh.carrier)))>0)
      AND ($7::timestamptz IS NULL OR p.created_at>=$7) AND ($8::timestamptz IS NULL OR p.created_at<$8) AND ($9::text IS NULL OR s.location_id=$9)
      AND (${w.partner?.delegationGrantId?'s.location_id IS NULL':'true'}))`;
  const counts=(await db.query<any>(`${cohort} SELECT count(*)::integer AS total,count(*) FILTER(WHERE lifecycle='open')::integer AS open,
    count(*) FILTER(WHERE lifecycle='closed')::integer AS closed,count(*) FILTER(WHERE missing_count>0 OR issue_count>0)::integer AS "needsAttention",
    count(*) FILTER(WHERE required_count+waived_count>0 AND unsatisfied_count=0)::integer AS "policyComplete" FROM cohort`,params)).rows[0];
  const conditions:Record<string,string>={all:'true',open:"lifecycle='open'",closed:"lifecycle='closed'",needs_attention:'(missing_count>0 OR issue_count>0)',missing:'missing_count>0',ready:'required_count+waived_count>0 AND unsatisfied_count=0 AND issue_count=0',processing:'processing',handoffs:"missing_count>0 AND EXISTS(SELECT 1 FROM record_requirements r WHERE r.proof_id=cohort.id AND r.stage IN ('handoff','delivery','customer_pickup'))"};
  const rows=(await db.query<any>(`${cohort} SELECT * FROM cohort WHERE ${conditions[view]} AND ($11::timestamptz IS NULL OR (updated_at,id)<($11::timestamptz,$12::text)) ORDER BY updated_at DESC,id DESC LIMIT $13`,[...params,cursor?.updatedAt??null,cursor?.id??null,limit+1])).rows;
  const selected=rows.slice(0,limit),records:RecordSummary[]=[];
  for(const row of selected)records.push(await summarize(db,clock,row));
  const last=records.at(-1);
  await reauthorizeRecordWorkspace(db,w);
  return {schema:'packproof.records/v1',records,counts,nextCursor:rows.length>limit&&last?encodeCursor(scope,{updatedAt:last.updatedAt,id:last.id},clock):null,updatedAt:clock.now().toISOString()};
}
export async function getRecord(db:Database,clock:Clock,w:RecordWorkspace,proofId:string) {
  const current=await requireRecordAccess(db,w,proofId);
  const row=(await db.query<any>(`${BASE} ${FROM} WHERE p.id=$1`,[proofId])).rows[0];
  const record=await summarize(db,clock,row);
  const [timelinePage,evidencePage,requirements,issues,relationships]=await Promise.all([pageRecordTimeline(db,clock,w,proofId),pageRecordEvidence(db,clock,w,proofId),readRecordRequirements(db,clock,proofId),readRecordIssues(db,proofId),
    db.query<any>('SELECT id,kind,external_reference AS "externalReference",parent_id AS "parentId",attributes,supersedes_id AS "supersedesId",created_at AS "createdAt" FROM record_entities WHERE proof_id=$1 ORDER BY created_at,id LIMIT 500',[proofId]).then(r=>r.rows.map(e=>({...e,attributes:safeRecordData(e.attributes),createdAt:date(e.createdAt)})))]);
  await requireRecordAccess(db,current,proofId);
  return {schema:'packproof.records/v1',record,timeline:timelinePage.timeline,evidence:evidencePage.evidence,timelineNextCursor:timelinePage.nextCursor,evidenceNextCursor:evidencePage.nextCursor,requirements,issues,relationships,
    assurance:{coreManifest:row.manifest_id?'present':'absent',operationalView:'not_a_signed_snapshot',physicalCondition:'not_established',explanation:'A core evidence package covers the original files and history listed in its frozen manifest. Later operational notes, relationships, requirements and review actions are separate from that signed inventory.'},
    sourceHealth:{state:record.sourceName==='csv'?'not_applicable':'freshness_unknown',message:record.sourceName==='csv'?'A spreadsheet import is a one-time source.':'Source freshness has not been established.'},
    capabilities:{edit:current.role!=='REVIEWER',review:!current.partner&&current.role!=='REVIEWER',waive:!current.partner&&['OWNER','ADMIN'].includes(current.role),export:!current.partner&&['OWNER','ADMIN'].includes(current.role)&&row.core_status==='FINALIZED'&&Boolean(row.manifest_id),operationalSnapshots:false,downloadOriginal:!current.partner,capture:!current.partner&&current.role!=='REVIEWER'&&current.membershipId===row.operator_membership_id}};
}
export async function ensureRecordState(db:Database,clock:Clock,w:RecordWorkspace,proofId:string) {
  await db.query(`INSERT INTO record_state(proof_id,organization_id,environment,updated_at) SELECT proof_id,merchant_id,environment,$2 FROM platform_proof_ownership WHERE proof_id=$1 ON CONFLICT DO NOTHING`,[proofId,clock.now().toISOString()]);
  return (await db.query<{revision:number;lifecycle:string}>('SELECT revision,lifecycle FROM record_state WHERE proof_id=$1 FOR UPDATE',[proofId])).rows[0];
}
export async function emitRecordChange(db:Database,clock:Clock,proofId:string,actorUserId:string,type:string,data:Record<string,unknown>) {
  const id=await appendAudit(db,{proofId,actorUserId,eventType:type,eventData:data,at:clock.now()});
  const eventType=type.startsWith('RECORD_ISSUE')?'issue.updated':'record.updated';
  await db.query('INSERT INTO proof_outbox(id,proof_id,audit_id,event_type,created_at) VALUES($1,$2,$3,$4,$5)',[`${id}:${eventType}`,proofId,id,eventType,clock.now().toISOString()]);
}
export async function recordCommand<T>(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,operation:string,key:unknown,revision:unknown,body:unknown,fn:(tx:Database,workspace:RecordWorkspace)=>Promise<T>):Promise<{value:T;replayed:boolean}> {
  if(typeof key!=='string'||!key.trim())throw new DomainError('IDEMPOTENCY_KEY_REQUIRED','Send a stable Idempotency-Key for this command',400);
  const keyHash=sha256Hex(textField(key,'Idempotency-Key',200)),requestHash=sha256Hex(canonicalize({revision,body}));
  const actorId=w.partner?`${w.userId}:${w.partner.credentialId}:${w.partner.delegationGrantId??'direct'}`:w.userId;
  await requireRecordAccess(db,w,proofId,true);
  const result=await db.transaction(async tx=>{
    const current=await requireRecordAccess(tx,w,proofId,true);
    await tx.query('INSERT INTO record_command_results(organization_id,environment,actor_id,operation,key_hash,request_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[w.organizationId,w.environment,actorId,operation,keyHash,requestHash,clock.now().toISOString()]);
    const prior=(await tx.query<{request_hash:string;response:unknown}>('SELECT request_hash,response FROM record_command_results WHERE organization_id=$1 AND environment=$2 AND actor_id=$3 AND operation=$4 AND key_hash=$5 FOR UPDATE',[w.organizationId,w.environment,actorId,operation,keyHash])).rows[0];
    if(prior.request_hash!==requestHash)throw new DomainError('IDEMPOTENCY_CONFLICT','This key was already used with different input',409);
    if(prior.response!=null)return {value:json(prior.response) as T,replayed:true};
    const expected=expectedRevision(revision),state=await ensureRecordState(tx,clock,w,proofId);
    if(state.revision!==expected)throw new DomainError('REVISION_CONFLICT','This record changed. Refresh before saving your action.',412);
    const value=await fn(tx,current);
    await tx.query('UPDATE record_state SET revision=revision+1,updated_at=$2 WHERE proof_id=$1',[proofId,clock.now().toISOString()]);
    await tx.query('UPDATE record_command_results SET response=$6::jsonb WHERE organization_id=$1 AND environment=$2 AND actor_id=$3 AND operation=$4 AND key_hash=$5',[w.organizationId,w.environment,actorId,operation,keyHash,JSON.stringify(value)]);
    return {value,replayed:false};
  });
  await requireRecordAccess(db,w,proofId,true);return result;
}
export async function patchRecord(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:unknown) {
  const b=strictBody(input,['title','reference','locationId','reason']),reason=textField(b.reason,'reason',1000),patch:Record<string,unknown>={};
  for(const k of ['title','reference'] as const)if(Object.hasOwn(b,k))patch[k]=optionalText(b[k],k);
  if(Object.hasOwn(b,'locationId'))patch.locationId=await requireRecordLocation(db,w,b.locationId);
  if(!Object.keys(patch).length)throw new DomainError('INVALID_REQUEST','Choose a title, reference or location to update',400);
  if(Object.hasOwn(patch,'locationId')&&!['OWNER','ADMIN'].includes(w.role))throw new DomainError('RECORD_PERMISSION_DENIED','An administrator must change the location',403);
  await db.query(`UPDATE record_state SET title=CASE WHEN $2 THEN $3 ELSE title END,reference=CASE WHEN $4 THEN $5 ELSE reference END,location_id=CASE WHEN $6 THEN $7 ELSE location_id END WHERE proof_id=$1`,[proofId,Object.hasOwn(patch,'title'),patch.title??null,Object.hasOwn(patch,'reference'),patch.reference??null,Object.hasOwn(patch,'locationId'),patch.locationId??null]);
  await emitRecordChange(db,clock,proofId,w.userId,'RECORD_METADATA_AMENDED',{patch,reason});return {proofId,revision:(await revisionOf(db,proofId))+1};
}
const revisionOf=async(db:Database,id:string)=>Number((await db.query<{revision:number}>('SELECT revision FROM record_state WHERE proof_id=$1',[id])).rows[0].revision);
export async function changeRecordLifecycle(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,action:'close'|'reopen',input:unknown) {
  const b=strictBody(input,['reason']),reason=textField(b.reason,'reason',1000),state=(await db.query<{lifecycle:string}>('SELECT lifecycle FROM record_state WHERE proof_id=$1',[proofId])).rows[0];
  if(state.lifecycle===(action==='close'?'closed':'open'))throw new DomainError('INVALID_RECORD_TRANSITION',`The record is already ${state.lifecycle}`,409);
  if(action==='close'){
    const reqs=await readRecordRequirements(db,clock,proofId),issues=await readRecordIssues(db,proofId);
    if(reqs.some(r=>r.status==='missing'||r.status==='not_yet_due')||issues.some(i=>i.status!=='resolved'))throw new DomainError('RECORD_HAS_OPEN_REQUIREMENTS','Resolve or waive outstanding evidence requirements and issues before closing',409);
  }
  await db.query('UPDATE record_state SET lifecycle=$2 WHERE proof_id=$1',[proofId,action==='close'?'closed':'open']);
  await emitRecordChange(db,clock,proofId,w.userId,action==='close'?'RECORD_CLOSED':'RECORD_REOPENED',{reason});return {proofId,lifecycle:action==='close'?'closed':'open',revision:(await revisionOf(db,proofId))+1};
}
export async function reviewRecord(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:unknown) {
  const b=strictBody(input,['action','reason']),reason=textField(b.reason,'reason',1000);
  if(w.partner)throw new DomainError('HUMAN_AUTHENTICATION_REQUIRED','Operational review requires a human session',403);
  if(!['mark_reviewed','reset_review'].includes(String(b.action)))throw new DomainError('INVALID_REVIEW_ACTION','Choose mark_reviewed or reset_review',400);
  const state=b.action==='mark_reviewed'?'reviewed':'unreviewed';
  await db.query('UPDATE record_state SET review_state=$2 WHERE proof_id=$1',[proofId,state]);
  await emitRecordChange(db,clock,proofId,w.userId,'RECORD_REVIEW_RECORDED',{action:b.action,reason,meaning:'Review is a recorded human action; it does not establish physical condition or evidence completeness.'});
  return {proofId,review:state,revision:(await revisionOf(db,proofId))+1};
}
export async function addRequirement(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:unknown) {
  if(!['OWNER','ADMIN'].includes(w.role))throw new DomainError('RECORD_PERMISSION_DENIED','An administrator must set evidence requirements',403);
  const b=strictBody(input,['subjectId','stage','title','templateVersion','acceptedEvidenceTypes','dueAt','gracePeriodMs','reason']);
  const subjectId=b.subjectId==null?proofId:textField(b.subjectId,'subjectId');await requireSubject(db,proofId,subjectId);
  if(!Array.isArray(b.acceptedEvidenceTypes)||!b.acceptedEvidenceTypes.length||b.acceptedEvidenceTypes.length>20||b.acceptedEvidenceTypes.some(x=>typeof x!=='string'||!/^[A-Z_]{2,80}$/.test(x)))throw new DomainError('INVALID_REQUIREMENT','Choose supported evidence types',400);
  const grace=b.gracePeriodMs??0;if(!Number.isInteger(grace)||Number(grace)<0||Number(grace)>2592000000)throw new DomainError('INVALID_REQUIREMENT','Grace period must be a bounded number of milliseconds',400);
  const id=newId('req'),reason=textField(b.reason,'reason',1000);
  await db.query('INSERT INTO record_requirements(id,proof_id,subject_id,stage,title,template_version,accepted_evidence_types,due_at,grace_period_ms,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)',[id,proofId,subjectId,textField(b.stage,'stage',80),textField(b.title,'title',200),textField(b.templateVersion,'templateVersion',100),JSON.stringify([...new Set(b.acceptedEvidenceTypes)]),instant(b.dueAt,'dueAt'),grace,clock.now().toISOString()]);
  await emitRecordChange(db,clock,proofId,w.userId,'RECORD_REQUIREMENT_ADDED',{requirementId:id,subjectId,reason});return {id,proofId,revision:(await revisionOf(db,proofId))+1};
}
export async function waiveRequirement(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,requirementId:string,input:unknown) {
  if(!['OWNER','ADMIN'].includes(w.role))throw new DomainError('RECORD_PERMISSION_DENIED','An administrator must approve a waiver',403);
  const reason=textField(strictBody(input,['reason']).reason,'reason',1000);
  if(!(await db.query('SELECT 1 FROM record_requirements WHERE id=$1 AND proof_id=$2',[requirementId,proofId])).rows[0])throw new DomainError('REQUIREMENT_NOT_FOUND','Requirement not found',404);
  if((await db.query('SELECT 1 FROM record_requirement_waivers WHERE requirement_id=$1',[requirementId])).rows[0])throw new DomainError('REQUIREMENT_ALREADY_WAIVED','This requirement already has a recorded waiver',409);
  const id=newId('waiver');await db.query('INSERT INTO record_requirement_waivers(id,requirement_id,reason,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5)',[id,requirementId,reason,w.userId,clock.now().toISOString()]);
  await emitRecordChange(db,clock,proofId,w.userId,'RECORD_REQUIREMENT_WAIVED',{requirementId,waiverId:id,reason});return {id,proofId,revision:(await revisionOf(db,proofId))+1};
}
export async function actOnIssue(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,issueId:string,input:unknown) {
  const b=strictBody(input,['action','reason']);if(!['acknowledge','resolve','reopen','note'].includes(String(b.action)))throw new DomainError('INVALID_ISSUE_ACTION','Choose acknowledge, resolve, reopen or note',400);
  const reason=textField(b.reason,'reason',1000);
  if(!(await db.query('SELECT 1 FROM record_issues WHERE id=$1 AND proof_id=$2',[issueId,proofId])).rows[0])throw new DomainError('ISSUE_NOT_FOUND','Issue not found',404);
  const id=newId('action');await db.query('INSERT INTO record_issue_actions(id,issue_id,action,reason,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,issueId,b.action,reason,w.userId,clock.now().toISOString()]);
  await emitRecordChange(db,clock,proofId,w.userId,'RECORD_ISSUE_ACTION',{issueId,action:b.action,reason});return {id,proofId,revision:(await revisionOf(db,proofId))+1};
}
export async function appendAmendment(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:unknown) {
  const b=strictBody(input,['supersedesId','assertion','reason']),supersedesId=textField(b.supersedesId,'supersedesId'),reason=textField(b.reason,'reason',1000);
  if(!b.assertion||typeof b.assertion!=='object'||Array.isArray(b.assertion)||Buffer.byteLength(JSON.stringify(b.assertion))>8192)throw new DomainError('INVALID_AMENDMENT','Supply an assertion of at most 8 KiB',400);
  const target=(await db.query('SELECT 1 FROM audit_events WHERE id=$1 AND proof_id=$2 UNION ALL SELECT 1 FROM shipment_events WHERE id=$1 AND proof_id=$2 UNION ALL SELECT 1 FROM record_amendments WHERE id=$1 AND proof_id=$2 UNION ALL SELECT 1 FROM record_entities WHERE id=$1 AND proof_id=$2 LIMIT 1',[supersedesId,proofId])).rows[0];
  if(!target)throw new DomainError('ASSERTION_NOT_FOUND','The superseded assertion does not belong to this record',404);
  const id=newId('amendment');await db.query('INSERT INTO record_amendments(id,proof_id,supersedes_id,assertion,reason,actor_user_id,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',[id,proofId,supersedesId,JSON.stringify(b.assertion),reason,w.userId,clock.now().toISOString()]);
  await emitRecordChange(db,clock,proofId,w.userId,'RECORD_ASSERTION_AMENDED',{amendmentId:id,supersedesId,assertion:safeRecordData(b.assertion),reason});return {id,proofId,revision:(await revisionOf(db,proofId))+1};
}
async function requireSubject(db:Database,proofId:string,id:string) {
  if(id!==proofId&&!(await db.query('SELECT 1 FROM record_entities WHERE id=$1 AND proof_id=$2',[id,proofId])).rows[0])throw new DomainError('RECORD_SUBJECT_NOT_FOUND','Subject does not belong to this record',404);
}
export async function resolveRecordEntityReference(db:Database,w:RecordWorkspace,proofId:string,reference:unknown){
 await requireRecordAccess(db,w,proofId);const value=textField(reference,'reference',200);
 const rows=(await db.query<{id:string;kind:string;externalReference:string}>('SELECT e.id,e.kind,e.external_reference AS "externalReference" FROM record_entities e WHERE e.proof_id=$1 AND e.external_reference=$2 AND NOT EXISTS(SELECT 1 FROM record_entities newer WHERE newer.supersedes_id=e.id) ORDER BY e.id LIMIT 11',[proofId,value])).rows;
 await requireRecordAccess(db,w,proofId);return {reference:value,outcome:rows.length===0?'not_found':rows.length===1?'matched':'ambiguous',matches:rows.slice(0,10),hasMore:rows.length>10,automaticMatch:rows.length===1?rows[0].id:null,matchingPolicy:'EXACT_CURRENT_REFERENCE_ONLY'};
}
export async function addRecordEntity(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:unknown) {
  const b=strictBody(input,['kind','externalReference','parentId','attributes','supersedesId','reason']);
  if(!['shipment','stop','package','pallet','item','return'].includes(String(b.kind)))throw new DomainError('INVALID_ENTITY','Choose a shipment, stop, package, pallet, item or return',400);
  const rawAttributes=b.attributes??{};if(typeof rawAttributes!=='object'||Array.isArray(rawAttributes)||Buffer.byteLength(JSON.stringify(rawAttributes))>8192)throw new DomainError('INVALID_ENTITY','Entity attributes must be an object of at most 8 KiB',400);
  const attributes={...rawAttributes as Record<string,unknown>};
  if(attributes.quantityComparison!=null)attributes.quantityComparison=normalizeQuantityComparison(attributes.quantityComparison);
  if(attributes.itemAllocation!=null){
    if(b.kind!=='item')throw new DomainError('INVALID_ENTITY','Typed item allocations belong to an item entity.',400);
    const item=normalizeItemAllocation(attributes.itemAllocation);
    for(const allocation of item.allocations)if(!(await db.query("SELECT 1 FROM record_entities e WHERE e.id=$1 AND e.proof_id=$2 AND e.kind IN ('package','pallet') AND NOT EXISTS(SELECT 1 FROM record_entities newer WHERE newer.supersedes_id=e.id)",[allocation.handlingUnitId,proofId])).rows[0])throw new DomainError('RECORD_SUBJECT_NOT_FOUND','Every allocation must identify a current package or pallet in this same record.',404);
    attributes.itemAllocation=item;
  }
  if(Buffer.byteLength(JSON.stringify(attributes))>8192)throw new DomainError('INVALID_ENTITY','Normalized entity attributes exceed the 8 KiB limit.',400);
  for(const field of ['parentId','supersedesId'] as const)if(b[field]!=null){
    const target=textField(b[field],field);
    const prior=(await db.query<{kind:string}>('SELECT kind FROM record_entities WHERE id=$1 AND proof_id=$2',[target,proofId])).rows[0];
    if(!prior)throw new DomainError('RECORD_SUBJECT_NOT_FOUND','Related entity does not belong to this record',404);
    if(field==='supersedesId'&&prior.kind!==b.kind)throw new DomainError('INVALID_ENTITY','A correction must keep the entity kind',400);
    if(field==='supersedesId'&&(await db.query('SELECT 1 FROM record_entities WHERE supersedes_id=$1',[target])).rows[0])throw new DomainError('ENTITY_ALREADY_SUPERSEDED','Correct the current entity version; history cannot branch silently.',409);
  }
  const id=newId('entity'),reason=textField(b.reason,'reason',1000);
  await db.query('INSERT INTO record_entities(id,proof_id,kind,external_reference,parent_id,attributes,actor_user_id,supersedes_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)',[id,proofId,b.kind,optionalText(b.externalReference,'externalReference'),b.parentId??null,JSON.stringify(attributes),w.userId,b.supersedesId??null,clock.now().toISOString()]);
  const a=attributes as Record<string,unknown>;
  for(const field of ['quantityComparison','itemAllocation'] as const){
    const comparison=attributes[field] as ReturnType<typeof normalizeQuantityComparison>|ReturnType<typeof normalizeItemAllocation>|undefined;
    if(comparison&&comparison.evaluation.outcome!=='within_tolerance')await createRecordIssue(db,clock,proofId,{category:comparison.evaluation.outcome==='not_comparable'?'quantity_not_comparable':'quantity_mismatch',severity:'warning',title:comparison.evaluation.outcome==='not_comparable'?'Reported units need review':'Reported quantities exceed the declared tolerance',subjectId:id,ruleVersion:comparison.evaluation.ruleVersion,comparedSources:comparison});
  }
  if(typeof a.expectedQuantity==='number'&&typeof a.observedQuantity==='number'&&Number.isFinite(a.expectedQuantity)&&Number.isFinite(a.observedQuantity)&&a.expectedQuantity!==a.observedQuantity)
    await createRecordIssue(db,clock,proofId,{category:'quantity_mismatch',severity:'warning',title:'Reported quantities differ',subjectId:id,ruleVersion:'quantity-equality/v1',comparedSources:{expected:{value:a.expectedQuantity,source:a.expectedSource??'unattributed assertion'},observed:{value:a.observedQuantity,source:a.observedSource??'unattributed assertion'},units:a.units??'unspecified',uncertainty:'Source assertions are not independent physical verification.'}});
  await emitRecordChange(db,clock,proofId,w.userId,'RECORD_ENTITY_ADDED',{entityId:id,kind:b.kind,reason});return {id,proofId,revision:(await revisionOf(db,proofId))+1};
}
export async function createRecordIssue(db:Database,clock:Clock,proofId:string,input:{category:string;severity:'info'|'warning'|'critical';title:string;subjectId:string;ruleVersion:string;comparedSources:unknown}) {
  const id=newId('issue');await db.query('INSERT INTO record_issues(id,proof_id,category,severity,title,subject_id,rule_version,compared_sources,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[id,proofId,input.category,input.severity,input.title,input.subjectId,input.ruleVersion,JSON.stringify(input.comparedSources),clock.now().toISOString()]);return id;
}
export async function linkRecordEvidence(db:Database,clock:Clock,w:RecordWorkspace,proofId:string,input:unknown) {
  const b=strictBody(input,['evidenceId','subjectId','reason']),evidenceId=textField(b.evidenceId,'evidenceId'),subjectId=textField(b.subjectId,'subjectId'),reason=textField(b.reason,'reason',1000);
  await requireSubject(db,proofId,subjectId);
  if(!(await db.query('SELECT 1 FROM evidence WHERE id=$1 AND proof_id=$2',[evidenceId,proofId])).rows[0])throw new DomainError('EVIDENCE_NOT_FOUND','Evidence does not belong to this record',404);
  const id=newId('link');await db.query('INSERT INTO record_evidence_links(id,proof_id,evidence_id,subject_id,reason,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(proof_id,evidence_id,subject_id) DO NOTHING',[id,proofId,evidenceId,subjectId,reason,w.userId,clock.now().toISOString()]);
  await emitRecordChange(db,clock,proofId,w.userId,'RECORD_EVIDENCE_ASSOCIATED',{evidenceId,subjectId,reason});return {proofId,evidenceId,subjectId,revision:(await revisionOf(db,proofId))+1};
}
