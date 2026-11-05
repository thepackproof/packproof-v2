import express,{type Request,type Response,type NextFunction} from 'express';
import {createHmac,timingSafeEqual} from 'node:crypto';
import type {AppDependencies} from '../app.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {appendAudit} from '../domain/audit.js';
import {newId} from '../ids.js';
import {canonicalize} from '../canonical.js';
import {sha256Hex} from '../hash.js';
import {textField} from '../platform/tenants.js';
import {auditOrganization,reauthorizePartner,authorizePartnerProof,strictBody,type PartnerActor,type PartnerScope} from '../platform/organizations.js';
import {idempotent} from '../platform/idempotency.js';
import {retryWebhookDelivery} from '../platform/webhooks.js';
import {CSV_LIMITS} from './csv.js';
import {connectionHealth} from './connections.js';
import {requireRecordAccess,type RecordWorkspace} from './access.js';
import {readRecordIssues,recordCommand,actOnIssue} from './service.js';
import {listRecordReviewers,assignRecordIssue} from './issue-assignments.js';

type PartnerRequest=Request&{partnerActor:PartnerActor};
type Position={createdAt:string;id:string};
const run=(fn:(r:Request,s:Response)=>Promise<void>)=>(r:Request,s:Response,n:NextFunction)=>{void fn(r,s).catch(n);};
const iso=(value:string|Date|null)=>value==null?null:new Date(value).toISOString();
function instant(value:unknown,name:string) {
  if(value==null||value==='')return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new DomainError('INVALID_DATE',`${name} must include a time zone`,400);
  return new Date(value).toISOString();
}
function limit(value:unknown){const n=value==null?50:Number(value);if(!Number.isInteger(n)||n<1||n>100)throw new DomainError('INVALID_LIMIT','limit must be from 1 to 100',400);return n;}
function optional(value:unknown,name:string){return value==null||value===''?null:textField(value,name,200);}
// An audit resource is not necessarily a Proof ID. Resolve only supported
// relationships; unknown delegated resources have no inferred read authority.
const AUDIT_RESOURCE_PROOFS=`
 SELECT p.proof_id FROM platform_proof_ownership p WHERE p.proof_id=x.resource_id
 UNION ALL SELECT e.proof_id FROM shipment_events e WHERE e.id=x.resource_id
 UNION ALL SELECT i.proof_id FROM record_issues i WHERE i.id=x.resource_id
 UNION ALL SELECT e.proof_id FROM evidence e WHERE e.id=x.resource_id
 UNION ALL SELECT e.proof_id FROM record_entities e WHERE e.id=x.resource_id
 UNION ALL SELECT e.proof_id FROM record_amendments e WHERE e.id=x.resource_id
 UNION ALL SELECT e.proof_id FROM record_requirements e WHERE e.id=x.resource_id
 UNION ALL SELECT r.proof_id FROM record_requirement_waivers w JOIN record_requirements r ON r.id=w.requirement_id WHERE w.id=x.resource_id
 UNION ALL SELECT i.proof_id FROM record_issue_actions a JOIN record_issues i ON i.id=a.issue_id WHERE a.id=x.resource_id
 UNION ALL SELECT c.proof_id FROM capture_intents c WHERE c.id=x.resource_id
 UNION ALL SELECT j.proof_id FROM integrity_envelope_jobs j WHERE j.operation_id=x.resource_id
 UNION ALL SELECT a.proof_id FROM record_source_artifacts a WHERE a.id=x.resource_id
 UNION ALL SELECT a.proof_id FROM record_source_artifact_operations op JOIN record_source_artifacts a ON a.id=op.artifact_id WHERE op.id=x.resource_id
 UNION ALL SELECT o.proof_id FROM api_webhook_deliveries d JOIN proof_outbox o ON o.id=d.event_id WHERE d.id=x.resource_id
 UNION ALL SELECT r.proof_id FROM record_source_receipts r WHERE r.id=x.resource_id OR r.operation_id=x.resource_id OR r.operation_id=x.request_id`;
function cursorKey(){const key=Buffer.from(process.env.PACKPROOF_EVENT_CURSOR_KEY??'','base64');if(key.length!==32)throw new DomainError('CURSOR_SIGNING_UNAVAILABLE','Cursor signing is not configured',503);return key;}
function cursorScope(actor:PartnerActor,resource:string,filters:unknown,pageSize:number) {
  return sha256Hex(canonicalize({resource,filters,pageSize,merchantId:actor.merchantId,environment:actor.environment,principalId:actor.principalId,credentialId:actor.credentialId,delegationId:actor.delegationGrantId}));
}
function encodeCursor(scope:string,position:Position,now:Date) {
  const body=Buffer.from(JSON.stringify({v:1,scope,...position,expiresAt:now.getTime()+3600000})).toString('base64url');
  return `${body}.${createHmac('sha256',cursorKey()).update(`partner-operations/v1:${body}`).digest('base64url')}`;
}
function decodeCursor(raw:unknown,scope:string,now:Date):Position|null {
  if(raw==null)return null;
  try{
    if(typeof raw!=='string'||raw.length>2048)throw 0;
    const [body,signature,extra]=raw.split('.'),got=Buffer.from(signature??'','base64url'),expected=createHmac('sha256',cursorKey()).update(`partner-operations/v1:${body}`).digest();
    if(extra||got.length!==expected.length||!timingSafeEqual(got,expected))throw 0;
    const value=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(value.v!==1||value.scope!==scope||typeof value.id!=='string'||value.id.length>300||!Number.isFinite(Date.parse(value.createdAt))||!Number.isSafeInteger(value.expiresAt))throw 0;
    if(value.expiresAt<=now.getTime())throw new DomainError('CURSOR_EXPIRED','Restart this authorized listing',410);
    return {createdAt:value.createdAt,id:value.id};
  }catch(error){if(error instanceof DomainError)throw error;throw new DomainError('INVALID_CURSOR','Use a cursor from this principal, resource and filter',400);}
}

/** All endpoints run behind the established organization credential middleware. */
export function createPartnerOperationsRouter(deps:AppDependencies) {
  const router=express.Router();
  function actor(r:Request) {const value=(r as PartnerRequest).partnerActor;if(!value)throw new DomainError('UNAUTHENTICATED','An organization service credential is required',401);return value;}
  function workspace(a:PartnerActor):RecordWorkspace {return {organizationId:a.merchantId,environment:a.environment,tenantId:a.tenantId,membershipId:'',userId:a.actorUserId,role:'OPERATOR',enabled:true,locationScoped:false,partner:a,authorizationClock:deps.clock};}
  async function authorize(a:PartnerActor,scope:PartnerScope,db=deps.db){await reauthorizePartner(db,deps.clock,a,scope);}
  function page(resource:string,a:PartnerActor,r:Request,filters:unknown) {const pageSize=limit(r.query.limit),scope=cursorScope(a,resource,filters,pageSize);return {pageSize,scope,after:decodeCursor(r.query.cursor,scope,deps.clock.now())};}
  function receipt<T>(rows:T[],pageSize:number,scope:string,position:(row:T)=>Position) {const selected=rows.slice(0,pageSize),last=selected.at(-1);return {selected,nextCursor:rows.length>pageSize&&last?encodeCursor(scope,position(last),deps.clock.now()):null,hasMore:rows.length>pageSize};}
  router.use((_r,s,n)=>{s.setHeader('Cache-Control','private, no-store');n();});

  router.get('/limits',run(async(r,s)=>{
    const a=actor(r),effectiveScopes:PartnerScope[]=[];
    for(const scope of a.scopes){try{await authorize(a,scope);effectiveScopes.push(scope);}catch(error){if(!(error instanceof DomainError)||error.code!=='INSUFFICIENT_SCOPE')throw error;}}
    if(!effectiveScopes.length)throw new DomainError('INSUFFICIENT_SCOPE','No currently authorized scope remains',403);
    s.json({schema:'packproof.partner-limits/v1',profile:'packproof.partner/v1',merchantId:a.merchantId,environment:a.environment,effectiveScopes,
      limits:{recordPageSize:100,timelinePageSize:100,evidencePageSize:100,eventPageSize:100,activeWebhookEndpoints:10,webhookAutomaticAttempts:10,webhookTimeoutMs:10000,
        canonicalPackage:{maximumMediaBytes:200*1024*1024,maximumArchiveBytes:220*1024*1024},
        csv:{...CSV_LIMITS,access:'organization_credential',requiredScopes:['imports:read','imports:write','proofs:read','proofs:write'],automaticSynchronization:false}},
      capabilities:{humanAttestationRequired:true,automaticConnectorCatalog:'pilot_validation_required',auditRead:effectiveScopes.includes('audit:read'),connectionAdministration:false}});
  }));

  router.get('/issues',run(async(r,s)=>{
    const a=actor(r);await authorize(a,'proofs:read');
    const status=String(r.query.status??'unresolved'),proofId=optional(r.query.proofId,'proofId');
    if(!['unresolved','open','acknowledged','resolved','all'].includes(status))throw new DomainError('INVALID_ISSUE_STATUS','Choose a documented issue status',400);
    const w=workspace(a);if(proofId)await requireRecordAccess(deps.db,w,proofId);
    const p=page('issues',a,r,{status,proofId});
    const rows=(await deps.db.query<{id:string;proof_id:string;created_at:string|Date}>(`WITH authorized AS (
      SELECT i.*,COALESCE((SELECT x.action FROM record_issue_actions x WHERE x.issue_id=i.id AND x.action<>'note' ORDER BY x.sequence DESC LIMIT 1),'reopen') AS last_action
      FROM record_issues i JOIN platform_proof_ownership o ON o.proof_id=i.proof_id LEFT JOIN record_state rs ON rs.proof_id=i.proof_id
      WHERE o.merchant_id=$1 AND o.environment=$2 AND ($3::text IS NULL OR i.proof_id=$3)
        AND ($4::boolean=false OR rs.location_id IS NULL)
    ) SELECT id,proof_id,created_at FROM authorized WHERE ($5='all' OR ($5='unresolved' AND last_action<>'resolve') OR ($5='open' AND last_action='reopen') OR ($5='acknowledged' AND last_action='acknowledge') OR ($5='resolved' AND last_action='resolve'))
      AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::text)) ORDER BY created_at DESC,id DESC LIMIT $8`,[a.merchantId,a.environment,proofId,!!a.delegationGrantId,status,p.after?.createdAt??null,p.after?.id??null,p.pageSize+1])).rows;
    const selected=receipt(rows,p.pageSize,p.scope,row=>({createdAt:iso(row.created_at)!,id:row.id})),byProof=new Map<string,string[]>();
    for(const row of selected.selected)byProof.set(row.proof_id,[...(byProof.get(row.proof_id)??[]),row.id]);
    const issues=[];
    for(const [id,ids]of byProof){await requireRecordAccess(deps.db,w,id);issues.push(...await readRecordIssues(deps.db,id,ids));}
    const order=new Map(selected.selected.map((row,i)=>[row.id,i]));issues.sort((x,y)=>order.get(x.id)!-order.get(y.id)!);
    await authorize(a,'proofs:read');s.json({issues,nextCursor:selected.nextCursor,hasMore:selected.hasMore});
  }));
  router.get('/proofs/:proofId/issue-reviewers',run(async(r,s)=>{s.json(await listRecordReviewers(deps.db,deps.clock,workspace(actor(r)),r.params.proofId));}));
  router.post('/issues/:issueId/assignment',run(async(r,s)=>{
    const a=actor(r);await authorize(a,'issues:assign');await authorize(a,'proofs:write');
    const row=(await deps.db.query<{proof_id:string}>('SELECT i.proof_id FROM record_issues i JOIN platform_proof_ownership o ON o.proof_id=i.proof_id WHERE i.id=$1 AND o.merchant_id=$2 AND o.environment=$3',[r.params.issueId,a.merchantId,a.environment])).rows[0];if(!row)throw new DomainError('ISSUE_NOT_FOUND','Issue not found.',404);
    const w=workspace(a),result=await recordCommand(deps.db,deps.clock,w,row.proof_id,'partner:assignment:'+r.params.issueId,r.header('Idempotency-Key'),r.header('If-Match'),r.body,(tx,current)=>assignRecordIssue(tx,deps.clock,current,row.proof_id,r.params.issueId,r.body));
    s.setHeader('Idempotency-Replayed',String(result.replayed));s.json(result.value);
  }));
  router.post('/issues/:issueId/actions',run(async(r,s)=>{
    const a=actor(r);await authorize(a,'proofs:write');
    const row=(await deps.db.query<{proof_id:string}>(`SELECT i.proof_id FROM record_issues i JOIN platform_proof_ownership o ON o.proof_id=i.proof_id LEFT JOIN record_state rs ON rs.proof_id=i.proof_id
      WHERE i.id=$1 AND o.merchant_id=$2 AND o.environment=$3 AND ($4::boolean=false OR rs.location_id IS NULL)`,[r.params.issueId,a.merchantId,a.environment,!!a.delegationGrantId])).rows[0];
    if(!row)throw new DomainError('ISSUE_NOT_FOUND','Issue not found',404);
    const w=workspace(a),result=await recordCommand(deps.db,deps.clock,w,row.proof_id,`partner:POST ${r.path}`,r.header('Idempotency-Key'),r.header('If-Match'),r.body,tx=>actOnIssue(tx,deps.clock,w,row.proof_id,r.params.issueId,r.body));
    s.setHeader('Idempotency-Replayed',String(result.replayed));s.json(result.value);
  }));

  router.get('/connections',run(async(r,s)=>{
    const a=actor(r);await authorize(a,'proofs:read');const p=page('connections',a,r,{});
    const rows=(await deps.db.query<any>(`SELECT c.id,c.provider,c.created_at,cs.paused,cs.last_success_at,cs.watermark_checked_at,cs.expected_interval_seconds,cs.last_error_code
      FROM platform_integration_accounts c LEFT JOIN record_connection_state cs ON cs.connection_id=c.id
      WHERE c.merchant_id=$1 AND c.environment=$2 AND ($3::boolean=false OR EXISTS(SELECT 1 FROM platform_external_bindings b LEFT JOIN record_state rs ON rs.proof_id=b.proof_id WHERE b.integration_account_id=c.id AND rs.location_id IS NULL))
      AND ($4::timestamptz IS NULL OR (c.created_at,c.id)<($4::timestamptz,$5::text)) ORDER BY c.created_at DESC,c.id DESC LIMIT $6`,[a.merchantId,a.environment,!!a.delegationGrantId,p.after?.createdAt??null,p.after?.id??null,p.pageSize+1])).rows;
    const selected=receipt(rows,p.pageSize,p.scope,row=>({createdAt:iso(row.created_at)!,id:row.id}));
    await authorize(a,'proofs:read');s.json({connections:selected.selected.map(row=>({id:row.id,provider:row.provider,...connectionHealth(row,deps.clock.now()),
      createdAt:iso(row.created_at),lastSuccessfulSyncAt:iso(row.last_success_at??null),lastWatermarkCheckAt:iso(row.watermark_checked_at??null),
      expectedIntervalSeconds:row.expected_interval_seconds??null,errorCode:typeof row.last_error_code==='string'&&/^[A-Z0-9_]{1,64}$/.test(row.last_error_code)?row.last_error_code:null,
      mappingVersion:null,capability:/^(csv|spreadsheet|file)$/i.test(row.provider)?'one_time_import':'pilot',capabilities:{automaticSync:false,manage:false}})),nextCursor:selected.nextCursor,hasMore:selected.hasMore});
  }));

  router.get('/audit-events',run(async(r,s)=>{
    const a=actor(r);await authorize(a,'audit:read');
    const operation=optional(r.query.operation,'operation'),resourceId=optional(r.query.resourceId,'resourceId'),from=instant(r.query.from,'from'),to=instant(r.query.to,'to');
    if(from&&to&&from>=to)throw new DomainError('INVALID_DATE_RANGE','The end must follow the start',400);
    const p=page('audit-events',a,r,{operation,resourceId,from,to});
    const rows=(await deps.db.query<any>(`SELECT x.id,x.actor_user_id AS "actorUserId",x.principal_id AS "principalId",x.credential_id AS "credentialId",x.delegation_id AS "delegationId",x.request_id AS "requestId",x.operation,x.resource_id AS "resourceId",x.policy_version AS "policyVersion",x.created_at AS "createdAt",visibility.proof_ids AS authorization_proof_ids
      FROM platform_action_audit x LEFT JOIN LATERAL (
        SELECT count(*) AS resource_count,array_agg(DISTINCT targets.proof_id) AS proof_ids,
          bool_and(COALESCE(po.merchant_id=$1 AND po.environment=$11,false) AND rs.location_id IS NULL) AS authorized
        FROM (${AUDIT_RESOURCE_PROOFS}) targets LEFT JOIN platform_proof_ownership po ON po.proof_id=targets.proof_id
        LEFT JOIN record_state rs ON rs.proof_id=targets.proof_id
      ) visibility ON $2::text IS NOT NULL
      WHERE x.merchant_id=$1 AND ($2::text IS NULL OR (x.delegation_id=$2 AND x.principal_id=$3))
      AND ($4::text IS NULL OR x.operation=$4) AND ($5::text IS NULL OR x.resource_id=$5)
      AND ($6::timestamptz IS NULL OR x.created_at>=$6) AND ($7::timestamptz IS NULL OR x.created_at<$7)
      AND ($8::timestamptz IS NULL OR (x.created_at,x.id)<($8::timestamptz,$9::text))
      AND ($2::text IS NULL OR (visibility.resource_count>0 AND visibility.authorized))
      ORDER BY x.created_at DESC,x.id DESC LIMIT $10`,[a.merchantId,a.delegationGrantId,a.principalId,operation,resourceId,from,to,p.after?.createdAt??null,p.after?.id??null,p.pageSize+1,a.environment])).rows;
    const selected=receipt(rows,p.pageSize,p.scope,row=>({createdAt:iso(row.createdAt)!,id:row.id}));
    await authorize(a,'audit:read');
    if(a.delegationGrantId){
      const proofs=[...new Set(selected.selected.flatMap(row=>row.authorization_proof_ids??[]))];
      if(proofs.length){const visible=(await deps.db.query<{count:number}>(`SELECT count(*)::integer AS count FROM platform_proof_ownership po LEFT JOIN record_state rs ON rs.proof_id=po.proof_id
        WHERE po.proof_id=ANY($1::text[]) AND po.merchant_id=$2 AND po.environment=$3 AND rs.location_id IS NULL`,[proofs,a.merchantId,a.environment])).rows[0].count;
        if(visible!==proofs.length)throw new DomainError('AUDIT_SCOPE_CHANGED','Record scope changed during this audit query; refresh the authorized listing',409);}
    }
    s.json({events:selected.selected.map(({authorization_proof_ids,...row})=>({...row,createdAt:iso(row.createdAt)})),nextCursor:selected.nextCursor,hasMore:selected.hasMore});
  }));

  async function ownedDelivery(db:Database,a:PartnerActor,id:string,lock=false) {
    await authorize(a,'webhooks:manage',db);
    const row=(await db.query<any>(`SELECT d.id,d.webhook_id,d.event_id,d.state,d.attempts,d.next_attempt_at,d.last_status,d.delivered_at,o.proof_id,o.event_type,o.created_at,
      w.revoked_at FROM api_webhook_deliveries d JOIN api_webhooks w ON w.id=d.webhook_id
      JOIN platform_webhook_authorizations wa ON wa.webhook_id=w.id JOIN proof_outbox o ON o.id=d.event_id
      JOIN platform_proof_ownership po ON po.proof_id=o.proof_id LEFT JOIN record_state rs ON rs.proof_id=po.proof_id
      WHERE d.id=$1 AND w.tenant_id=$2 AND wa.merchant_id=$3 AND wa.credential_id=$4 AND wa.delegation_id IS NOT DISTINCT FROM $5::text
      AND po.merchant_id=$3 AND po.environment=$6 AND ($5::text IS NULL OR rs.location_id IS NULL) ${lock?'FOR UPDATE OF d':''}`,[id,a.tenantId,a.merchantId,a.credentialId,a.delegationGrantId,a.environment])).rows[0];
    if(!row||row.revoked_at)throw new DomainError('WEBHOOK_DELIVERY_NOT_FOUND','Active authorized webhook delivery not found',404);return row;
  }
  router.get('/webhook-deliveries',run(async(r,s)=>{
    const a=actor(r);await authorize(a,'webhooks:manage');
    const state=optional(r.query.state,'state'),webhookId=optional(r.query.webhookId,'webhookId');
    if(state&&!['pending','sending','delivered','dead'].includes(state))throw new DomainError('INVALID_DELIVERY_STATE','Choose a documented delivery state',400);
    const p=page('webhook-deliveries',a,r,{state,webhookId});
    const rows=(await deps.db.query<any>(`SELECT d.id,d.webhook_id,d.event_id,d.state,d.attempts,d.next_attempt_at,d.last_status,d.delivered_at,o.proof_id,o.event_type,o.created_at
      FROM api_webhook_deliveries d JOIN api_webhooks w ON w.id=d.webhook_id JOIN platform_webhook_authorizations wa ON wa.webhook_id=w.id
      JOIN proof_outbox o ON o.id=d.event_id JOIN platform_proof_ownership po ON po.proof_id=o.proof_id LEFT JOIN record_state rs ON rs.proof_id=po.proof_id
      WHERE w.tenant_id=$1 AND wa.merchant_id=$2 AND wa.credential_id=$3 AND wa.delegation_id IS NOT DISTINCT FROM $4::text AND w.revoked_at IS NULL
      AND po.merchant_id=$2 AND po.environment=$5 AND ($4::text IS NULL OR rs.location_id IS NULL)
      AND ($6::text IS NULL OR d.state=$6) AND ($7::text IS NULL OR d.webhook_id=$7)
      AND ($8::timestamptz IS NULL OR (o.created_at,d.id)<($8::timestamptz,$9::text)) ORDER BY o.created_at DESC,d.id DESC LIMIT $10`,[a.tenantId,a.merchantId,a.credentialId,a.delegationGrantId,a.environment,state,webhookId,p.after?.createdAt??null,p.after?.id??null,p.pageSize+1])).rows;
    const selected=receipt(rows,p.pageSize,p.scope,row=>({createdAt:iso(row.created_at)!,id:row.id})),ids=selected.selected.map(row=>row.id);
    const history=ids.length?(await deps.db.query<any>(`SELECT id,event_data,created_at FROM audit_events WHERE event_type='WEBHOOK_DELIVERY_REPLAY_REQUESTED' AND actor_user_id=$1 AND event_data->>'deliveryId'=ANY($2::text[]) ORDER BY created_at DESC,id DESC LIMIT 500`,[a.actorUserId,ids])).rows:[];
    const deliveries=[];
    for(const row of selected.selected){await ownedDelivery(deps.db,a,row.id);deliveries.push({id:row.id,webhookId:row.webhook_id,eventId:row.event_id,proofId:row.proof_id,eventType:row.event_type,state:row.state,attempts:row.attempts,
      nextAttemptAt:row.state==='pending'||row.state==='sending'?iso(row.next_attempt_at):null,lastStatus:row.last_status,deliveredAt:iso(row.delivered_at),eventCreatedAt:iso(row.created_at),
      replays:history.filter(h=>h.event_data.deliveryId===row.id).slice(0,10).map(h=>({id:h.event_data.replayId,priorAttemptCount:h.event_data.priorAttemptCount,reason:h.event_data.reason,requestedAt:iso(h.created_at)}))});}
    await authorize(a,'webhooks:manage');s.json({deliveries,nextCursor:selected.nextCursor,hasMore:selected.hasMore});
  }));
  router.post('/webhook-deliveries/:deliveryId/replay',run(async(r,s)=>{
    const a=actor(r),body=strictBody(r.body,['reason']),reason=textField(body.reason,'reason',1000);
    await ownedDelivery(deps.db,a,r.params.deliveryId);
    if(!r.header('Idempotency-Key'))throw new DomainError('IDEMPOTENCY_KEY_REQUIRED','Send a stable Idempotency-Key for this replay request',400);
    const operation=`partner-operations:${a.environment}:${a.principalId}:${a.credentialId}:${a.delegationGrantId??'direct'}:POST ${r.path}`;
    const result=await idempotent(deps.db,deps.clock,a.tenantId,operation,r.header('Idempotency-Key'),body,async tx=>{
      const delivery=await ownedDelivery(tx,a,r.params.deliveryId,true),replayId=newId('replay');
      await retryWebhookDelivery(tx,deps.clock,a.tenantId,delivery.id);
      const value={replayId,deliveryId:delivery.id,webhookId:delivery.webhook_id,eventId:delivery.event_id,proofId:delivery.proof_id,state:'pending',priorAttemptCount:delivery.attempts,reason,requestedAt:deps.clock.now().toISOString(),signatureTimestamp:'generated_at_dispatch'};
      await appendAudit(tx,{proofId:delivery.proof_id,actorUserId:a.actorUserId,eventType:'WEBHOOK_DELIVERY_REPLAY_REQUESTED',eventData:{...value,principalId:a.principalId,credentialId:a.credentialId,delegationId:a.delegationGrantId},at:deps.clock.now()});
      await auditOrganization(tx,deps.clock,{actor:a,requestId:a.requestId,operation:'WEBHOOK_DELIVERY_REPLAY_REQUESTED',resourceId:delivery.id});return value;
    });
    await ownedDelivery(deps.db,a,r.params.deliveryId);s.setHeader('Idempotency-Replayed',String(result.replayed));s.status(202).json(result.value);
  }));
  return router;
}
