import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { auditOrganization, strictBody } from '../platform/organizations.js';
import { requireRecordWorkspace, type RecordWorkspace } from './access.js';

type HealthInput = {
 provider: string; paused?: boolean; last_success_at?: string | Date | null;
 watermark_checked_at?: string | Date | null; expected_interval_seconds?: number | null;
 last_error_code?: string | null;
};
const asIso = (v: string | Date | null | undefined) => {
 if(!v)return null;const date=new Date(v);return Number.isFinite(date.getTime())?date.toISOString():null;
};
export function connectionHealth(row: HealthInput, now: Date) {
 if (/^(csv|spreadsheet|file)$/i.test(row.provider)) return {state:'not_applicable',label:'Continuous sync not applicable',action:'View imported records'};
 if (row.paused) return {state:'paused',label:'Paused',action:'Resume synchronization'};
 if (row.last_error_code) return {state:'action_needed',label:'Action needed',action:'Review connection setup'};
 const interval=row.expected_interval_seconds;
 if (!row.last_success_at || !row.watermark_checked_at || typeof interval!=='number' || !Number.isInteger(interval) || interval<60 || interval>604800)
  return {state:'freshness_unknown',label:'Freshness unknown',action:'Test the source connection'};
 const success = new Date(row.last_success_at).getTime(), watermark = new Date(row.watermark_checked_at).getTime();
 const age = now.getTime() - Math.min(success,watermark);
 if (!Number.isFinite(age) || success>now.getTime() || watermark>now.getTime()) return {state:'freshness_unknown',label:'Freshness unknown',action:'Review source clock and health measurements'};
 if (age > interval*1000) return {state:'delayed',label:'Delayed',action:'Reconcile missing source updates'};
 return {state:'up_to_date',label:'Up to date',action:'View records'};
}

export async function listRecordConnections(db: Database, clock: Clock, workspace: RecordWorkspace) {
 const current=await requireRecordWorkspace(db,workspace.userId,workspace.organizationId,workspace.environment);
 // Accounts do not yet declare a location subset. Do not expose organization-wide
 // account identifiers to a membership whose authority is limited to selected sites.
 if(current.locationScoped)throw new DomainError('CONNECTION_SCOPE_UNAVAILABLE','Source connections require organization-wide access until their location scope is configured',403);
 const measuredAt=clock.now(),limit=100;
 const rows = (await db.query<{id:string;provider:string;external_account_id:string;created_at:string|Date;total:number;current_needs_action:number} & HealthInput>(`
  SELECT a.id,a.provider,a.external_account_id,a.created_at,s.paused,s.last_success_at,s.watermark_checked_at,
   s.expected_interval_seconds,s.last_error_code,(COUNT(*) OVER())::integer AS total,
   (COUNT(*) FILTER(WHERE a.provider !~* '^(csv|spreadsheet|file)$' AND COALESCE(s.paused,false)=false AND
    (NULLIF(s.last_error_code,'') IS NOT NULL OR
     (s.last_success_at IS NOT NULL AND s.watermark_checked_at IS NOT NULL AND s.expected_interval_seconds BETWEEN 60 AND 604800
      AND isfinite(s.last_success_at) AND isfinite(s.watermark_checked_at)
      AND s.last_success_at<=$3 AND s.watermark_checked_at<=$3
      AND LEAST(s.last_success_at,s.watermark_checked_at)<$3::timestamptz-(s.expected_interval_seconds*INTERVAL '1 second')))) OVER())::integer AS current_needs_action
  FROM platform_integration_accounts a LEFT JOIN record_connection_state s ON s.connection_id=a.id
  WHERE a.merchant_id=$1 AND a.environment=$2 ORDER BY a.created_at DESC,a.id LIMIT $4`,[workspace.organizationId,workspace.environment,measuredAt.toISOString(),limit])).rows;
 const total=rows[0]?.total??0,currentNeedsAction=rows[0]?.current_needs_action??0;
 return {connections:rows.map(row=>({id:row.id,connectionId:row.id,provider:row.provider,sourceReference:row.external_account_id,
  ...connectionHealth(row,measuredAt),lastSuccessfulSyncAt:asIso(row.last_success_at),lastWatermarkCheckAt:asIso(row.watermark_checked_at),
  expectedIntervalSeconds:row.expected_interval_seconds??null,errorCode:row.last_error_code??null,
  createdAt:asIso(row.created_at),mappingVersion:null,
  capability:/^(csv|spreadsheet|file)$/i.test(row.provider)?'one_time_import':'pilot',
  capabilities:{automaticSync:false,reason:'A source adapter and its declared scope must pass validation before automatic updates can be enabled.'}})),
  total,currentNeedsAction,returnedCount:rows.length,hasMore:rows.length<total,limit,measuredAt:measuredAt.toISOString(),
  catalog:[{id:'csv',name:'Spreadsheet',availability:'available',description:'Preview and import a CSV file. This is a one-time import.'},
   {id:'assisted',name:'Connect another system',availability:'request',description:'Confirm the source, authorized access, locations and evidence available for a scoped pilot.'}]};
}

async function requireConnection(db: Database, workspace: RecordWorkspace, id: string) {
 const row = (await db.query<{id:string;provider:string}>(`SELECT id,provider FROM platform_integration_accounts WHERE id=$1 AND merchant_id=$2 AND environment=$3`,[id,workspace.organizationId,workspace.environment])).rows[0];
 if (!row) throw new DomainError('CONNECTION_NOT_FOUND','Connection not found',404);
 return row;
}

function requireConnectionAdministrator(workspace:RecordWorkspace) {
 if(!['OWNER','ADMIN'].includes(workspace.role))throw new DomainError('CONNECTION_ADMIN_REQUIRED','A workspace administrator must change connections',403);
 if(workspace.locationScoped)throw new DomainError('CONNECTION_SCOPE_UNAVAILABLE','An organization-wide administrator must manage this source connection',403);
}

export async function actOnRecordConnection(db: Database, clock: Clock, workspace: RecordWorkspace, id: string, input: unknown, key: unknown) {
 const body = strictBody(input,['organizationId','environment','action','reason']);
 const action=body.action;
 if (!['pause','resume','test','reconcile'].includes(String(action))) throw new DomainError('INVALID_CONNECTION_ACTION','Choose test, pause, resume or reconcile',400);
 if (typeof key!=='string'||key.length<1||key.length>200) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED','Supply a stable Idempotency-Key for this action',400);
 const reason=body.reason==null?null:typeof body.reason==='string'?body.reason.trim():'';
 if (reason!==null && (!reason||reason.length>1000)) throw new DomainError('INVALID_REASON','Use a reason of 1 to 1000 characters',400);
 const requestHash=sha256Hex(canonicalize({connectionId:id,action,reason}));
 return db.transaction(async tx=>{
  const current=await requireRecordWorkspace(tx,workspace.userId,workspace.organizationId,workspace.environment,true);
  requireConnectionAdministrator(current);
  const connection=await requireConnection(tx,current,id);
  if (/^(csv|spreadsheet|file)$/i.test(connection.provider)) throw new DomainError('ONE_TIME_IMPORT','A spreadsheet import does not have a continuous synchronization process',409);
  await tx.query('SELECT pg_advisory_xact_lock(1347438148,hashtext($1))',[`${workspace.organizationId}:${id}`]);
  const now=clock.now().toISOString(),keyHash=sha256Hex(key);
  // Pause/resume use the same permanent command ledger as organization controls.
  const operation=`connection:${workspace.environment}:${workspace.organizationId}:${id}`;
  await tx.query('INSERT INTO platform_command_results(actor_user_id,operation,key_hash,request_hash,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[workspace.userId,operation,keyHash,requestHash,now]);
  const prior=(await tx.query<{request_hash:string;response:unknown}>('SELECT request_hash,response FROM platform_command_results WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3 FOR UPDATE',[workspace.userId,operation,keyHash])).rows[0];
  if (prior.request_hash!==requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT','This key was already used with different connection settings',409);
  if (prior.response!==null) return typeof prior.response==='string'?JSON.parse(prior.response):prior.response;
  await tx.query('INSERT INTO record_connection_state(connection_id,organization_id,environment,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,workspace.organizationId,workspace.environment,now]);
  let result: Record<string,unknown>;
  if (action==='pause'||action==='resume') {
   await tx.query('UPDATE record_connection_state SET paused=$2,control_revision=control_revision+1,updated_at=$3 WHERE connection_id=$1',[id,action==='pause',now]);
   result={connectionId:id,state:action==='pause'?'paused':'freshness_unknown',message:action==='pause'?'New synchronization is paused. Accepted records remain available.':'Synchronization is resumed. Freshness requires a successful source and watermark check.'};
  } else {
   const state=(await tx.query<{paused:boolean;control_revision:string|number}>('SELECT paused,control_revision FROM record_connection_state WHERE connection_id=$1',[id])).rows[0];
   if (state.paused) throw new DomainError('CONNECTION_PAUSED','Resume this connection before testing or reconciling it',409);
   const operationId=newId('connop');
   await tx.query(`INSERT INTO record_connection_operations(id,connection_id,organization_id,environment,actor_user_id,action,idempotency_key_hash,request_hash,control_revision,state,next_attempt_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$10,$10)`,[operationId,id,workspace.organizationId,workspace.environment,workspace.userId,action,keyHash,requestHash,state.control_revision,now]);
   result={operationId,connectionId:id,state:'queued',statusUrl:`/me/records/connections/${id}/operations/${operationId}?organizationId=${encodeURIComponent(workspace.organizationId)}&environment=${workspace.environment}`};
  }
  await auditOrganization(tx,clock,{userId:workspace.userId,merchantId:workspace.organizationId,requestId:newId('req'),operation:`CONNECTION_${String(action).toUpperCase()}`,resourceId:id});
  await tx.query('UPDATE platform_command_results SET response=$4::jsonb WHERE actor_user_id=$1 AND operation=$2 AND key_hash=$3',[workspace.userId,operation,keyHash,JSON.stringify(result)]);
  return result;
 });
}

export async function readRecordConnectionOperation(db:Database, workspace:RecordWorkspace, connectionId:string, id:string) {
 const current=await requireRecordWorkspace(db,workspace.userId,workspace.organizationId,workspace.environment);
 if(current.locationScoped)throw new DomainError('CONNECTION_SCOPE_UNAVAILABLE','Source connection diagnostics require organization-wide access',403);
 await requireConnection(db,workspace,connectionId);
 const row=(await db.query<{id:string;action:string;state:string;attempts:number;error_code:string|null;next_attempt_at:Date|string;created_at:Date|string;updated_at:Date|string}>(`SELECT id,action,state,attempts,error_code,next_attempt_at,created_at,updated_at FROM record_connection_operations WHERE id=$1 AND connection_id=$2 AND organization_id=$3 AND environment=$4`,[id,connectionId,workspace.organizationId,workspace.environment])).rows[0];
 if(!row)throw new DomainError('OPERATION_NOT_FOUND','Operation not found',404);
 const guidance=connectionOperationGuidance(row.error_code);
 return {operationId:row.id,action:row.action,state:row.state,attempts:row.attempts,errorCode:row.error_code,...guidance,nextAttemptAt:row.state==='queued'?asIso(row.next_attempt_at):null,createdAt:asIso(row.created_at),updatedAt:asIso(row.updated_at)};
}

function connectionOperationGuidance(code:string|null) {
 if(!code)return {};
 const messages:Record<string,{message:string;nextAction:string}>={
  CONNECTION_ADAPTER_NOT_CONFIGURED:{message:'An authorized source adapter has not been configured and validated.',nextAction:'Request help connecting this system; automatic updates are not active.'},
  CONNECTION_PAUSED:{message:'The source connection was paused before this check could finish.',nextAction:'Resume the connection and run a new check.'},
  CONNECTION_CHANGED:{message:'The connection settings changed while this check was pending.',nextAction:'Run a new check using the current connection settings.'},
  ORGANIZATION_ACCESS_REVOKED:{message:'The requesting administrator no longer has the required workspace access.',nextAction:'Ask a current organization administrator to start a new check.'},
  CONNECTION_ADMIN_REQUIRED:{message:'The requesting account no longer has administrator access.',nextAction:'Ask a current organization administrator to start a new check.'},
  SOURCE_CHECK_UNAVAILABLE:{message:'The source could not be reached.',nextAction:'Review source availability and the next retry, or run a new check after the source recovers.'},
  INVALID_SOURCE_HEALTH:{message:'The source did not provide valid synchronization and watermark measurements.',nextAction:'Review the adapter configuration before relying on source freshness.'},
 };
 return messages[code]??{message:'This source check could not complete safely.',nextAction:'Review workspace access and source configuration, then run a new check.'};
}

/** An explicitly registered adapter must establish all three health measurements.
 * An OAuth callback or an empty result alone never establishes source freshness. */
export interface ConnectionCheckResult {lastSuccessfulSyncAt:string;watermarkCheckedAt:string;expectedIntervalSeconds:number;}
export type ConnectionChecker=(input:{connectionId:string;organizationId:string;environment:'sandbox'|'live';action:'test'|'reconcile'})=>Promise<ConnectionCheckResult>;
export async function processRecordConnectionOperations(db:Database,clock:Clock,checkers:ReadonlyMap<string,ConnectionChecker>=new Map(),limit=5) {
 let processed=0;
 for(let i=0;i<Math.max(0,Math.min(limit,20));i++){
  const now=clock.now(),leaseToken=newId('lease');
  const job=await db.transaction(async tx=>{
   const row=(await tx.query<{id:string;connection_id:string;organization_id:string;environment:'sandbox'|'live';actor_user_id:string;action:'test'|'reconcile';attempts:number;provider:string;control_revision:string|number}>(`
    SELECT j.*,a.provider FROM record_connection_operations j JOIN platform_integration_accounts a ON a.id=j.connection_id
    JOIN record_connection_state s ON s.connection_id=j.connection_id AND s.organization_id=j.organization_id AND s.environment=j.environment
    WHERE ((j.state='queued' AND j.next_attempt_at<=$1) OR (j.state='running' AND j.lease_expires_at<=$1))
     AND NOT EXISTS(SELECT 1 FROM record_connection_operations active WHERE active.connection_id=j.connection_id AND active.id<>j.id AND active.state='running' AND active.lease_expires_at>$1)
    -- Serialize claims on mutable connection state; account metadata is read-only for this worker.
    ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j,s SKIP LOCKED`,[now.toISOString()])).rows[0];
   if(!row)return null;
   await tx.query("UPDATE record_connection_operations SET state='running',attempts=attempts+1,lease_token=$2,lease_expires_at=$3,updated_at=$4 WHERE id=$1",[row.id,leaseToken,new Date(now.getTime()+120000).toISOString(),now.toISOString()]);
   return row;
  });
  if(!job)break;
  let result:ConnectionCheckResult|undefined,errorCode:string|null=null;
  try{
   const w=await requireRecordWorkspace(db,job.actor_user_id,job.organization_id,job.environment,true);
   requireConnectionAdministrator(w);
   const s=(await db.query<{paused:boolean;control_revision:string|number}>('SELECT paused,control_revision FROM record_connection_state WHERE connection_id=$1',[job.connection_id])).rows[0];
   if(s?.paused)throw new DomainError('CONNECTION_PAUSED','Connection is paused',409);
   if(!s||String(s.control_revision)!==String(job.control_revision))throw new DomainError('CONNECTION_CHANGED','Connection settings changed',409);
   const check=checkers.get(job.provider);
   if(!check)throw new DomainError('CONNECTION_ADAPTER_NOT_CONFIGURED','An authorized source adapter must be configured and validated',409);
   result=await check({connectionId:job.connection_id,organizationId:job.organization_id,environment:job.environment,action:job.action});
   const latest=clock.now().getTime();
   if(![result.lastSuccessfulSyncAt,result.watermarkCheckedAt].every(v=>Number.isFinite(Date.parse(v))&&Date.parse(v)<=latest)||!Number.isInteger(result.expectedIntervalSeconds)||result.expectedIntervalSeconds<60||result.expectedIntervalSeconds>604800)
    throw new DomainError('INVALID_SOURCE_HEALTH','The source adapter did not establish a valid freshness measurement',409);
  }catch(error){errorCode=error instanceof DomainError&&error.httpStatus<500?error.code:'SOURCE_CHECK_UNAVAILABLE';}
  await db.transaction(async tx=>{
   const current=(await tx.query<{lease_token:string;lease_expires_at:string|Date;paused:boolean;control_revision:string|number}>(`SELECT j.lease_token,j.lease_expires_at,s.paused,s.control_revision FROM record_connection_operations j JOIN record_connection_state s ON s.connection_id=j.connection_id WHERE j.id=$1 FOR UPDATE OF j,s`,[job.id])).rows[0];
   if(current?.lease_token!==leaseToken||new Date(current.lease_expires_at).getTime()<=clock.now().getTime())return;
   // Pause or access revocation during the external request cannot publish health.
   try{requireConnectionAdministrator(await requireRecordWorkspace(tx,job.actor_user_id,job.organization_id,job.environment,true));}catch(error){
    if(!(error instanceof DomainError))throw error;
    errorCode=error.httpStatus>=500?'SOURCE_CHECK_UNAVAILABLE':'ORGANIZATION_ACCESS_REVOKED';result=undefined;
   }
   if(current.paused){errorCode='CONNECTION_PAUSED';result=undefined;}
   else if(String(current.control_revision)!==String(job.control_revision)){errorCode='CONNECTION_CHANGED';result=undefined;}
   const at=clock.now().toISOString();
   const retry=errorCode==='SOURCE_CHECK_UNAVAILABLE'&&job.attempts<4;
   await tx.query('UPDATE record_connection_operations SET state=$2,error_code=$3,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=$4,updated_at=$5 WHERE id=$1',[job.id,retry?'queued':errorCode?'failed':'succeeded',errorCode,new Date(clock.now().getTime()+Math.min(300000,1000*2**job.attempts)).toISOString(),at]);
   if(result&&!errorCode)await tx.query('UPDATE record_connection_state SET last_success_at=$2,watermark_checked_at=$3,expected_interval_seconds=$4,last_error_code=NULL,updated_at=$5 WHERE connection_id=$1',[job.connection_id,result.lastSuccessfulSyncAt,result.watermarkCheckedAt,result.expectedIntervalSeconds,at]);
   else await tx.query('UPDATE record_connection_state SET last_error_code=$2,updated_at=$3 WHERE connection_id=$1',[job.connection_id,errorCode,at]);
  });processed++;
 }
 return {processed};
}
