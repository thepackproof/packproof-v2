import type {AppDependencies} from '../app.js';
import {canonicalize} from '../canonical.js';
import type {Database} from '../db/database.js';
import {DomainError} from '../domain/errors.js';
import {sha256Hex} from '../hash.js';
import {newId} from '../ids.js';
import {strictBody,type PartnerActor} from '../platform/organizations.js';
import type {Installation} from './agent-enrollments.js';
import {commitOrderGroup,ensureOrderRoot,insertOrderEvent,lockOperation,orderComponent,originFor,preserveOrderOriginal} from './order-ledger.js';
import {normalizedRecord,refKey} from './order-projection.js';
import {activeScope,boundedText,digest,positive} from './order-workspace.js';

const historyProfile = 'packproof.partner-order-history/v1';
type SourceKey = {id:string;generation:number};
type Progress = {cursor_proof_id:string;history_finished:boolean;paused:boolean};
export async function orderApiPaused(db:Database,installation:Installation,source:SourceKey) {
  const result=await db.query<{paused:boolean}>(`SELECT paused FROM record_order_api_progress
    WHERE installation_id=$1 AND source_id=$2 AND generation=$3 FOR SHARE`,[installation.id,source.id,source.generation]);
  return result.rows[0]?.paused===true;
}
async function sourceProgress(db:Database,i:Installation,input:unknown,pause:boolean) {
  const body=strictBody(input,pause?['sourceId','generation','scopeDigest','paused']:['sourceId','generation','scopeDigest']);
  const session=await activeScope(db,i,digest(body.scopeDigest));
  const sourceId=boundedText(body.sourceId,'source'),generation=positive(body.generation);
  const source=session.scope.sources.find(s=>s.id===sourceId&&s.generation===generation&&s.transport==='api'&&s.roles.includes('order')&&s.sourceNamespace);
  if(!source)throw new DomainError('AUTH_REQUIRED','Approve this API source before accessing its progress.',403);
  const params=[i.id,source.id,source.generation];
  await db.query(`INSERT INTO record_order_api_progress(installation_id,source_id,generation) VALUES($1,$2,$3)
    ON CONFLICT (installation_id,source_id,generation) DO NOTHING`,params);
  const progress=(await db.query<Progress>(`SELECT cursor_proof_id,history_finished,paused FROM record_order_api_progress
    WHERE installation_id=$1 AND source_id=$2 AND generation=$3 FOR UPDATE`,params)).rows[0];
  return {session,source,params,progress,body};
}
export async function setApiSourcePaused(db:Database,i:Installation,input:unknown) {
  const {params,body}=await sourceProgress(db,i,input,true);
  if(typeof body.paused!=='boolean')throw new DomainError('INVALID_REQUEST','Choose pause or resume.',400);
  await db.query('UPDATE record_order_api_progress SET paused=$4 WHERE installation_id=$1 AND source_id=$2 AND generation=$3',[...params,body.paused]);
  return {paused:body.paused};
}

interface HistoricalOrder {proof_id:string;external_id:string;snapshot_sha256:string;snapshot:Record<string,unknown>;}
export async function reconcileApiHistory(deps:AppDependencies,db:Database,actor:PartnerActor,i:Installation,input:unknown) {
  const {session,source,params,progress}=await sourceProgress(db,i,input,false);
  if (progress.paused || progress.history_finished) return {processed:0,hasMore:false,state:progress.paused?'paused':'current'};
  const o=originFor(i);
  await lockOperation(db,o.operation);
  // Past requests lack an explicit Connect source ID. A single qualified
  // operation/account binding may own their snapshots. Multiple active API
  // bindings must be resolved by an actual source relationship.
  const candidates=(await db.query(`SELECT x->>'id' FROM record_agent_installations a
    JOIN record_order_sessions g ON g.installation_id=a.id AND g.state='active'
    CROSS JOIN LATERAL jsonb_array_elements(g.scope->'sources') x
    WHERE a.organization_id=$1 AND a.environment=$2 AND a.integration_account_id=$3 AND a.operator_membership_id=$4
    AND a.location_id IS NOT DISTINCT FROM $5 AND a.status NOT IN ('revoked','paused') AND x->>'transport'='api'
    LIMIT 2`,[o.organization,o.environment,o.account,o.operator,o.location])).rows;
  if(candidates.length!==1) return {processed:0,hasMore:false,state:'source_reference_needed'};
  const orders=(await db.query<HistoricalOrder>(`SELECT b.proof_id,b.external_id,b.snapshot_sha256,t.transaction_metadata->'orderSnapshot' snapshot
    FROM platform_external_bindings b
    JOIN platform_proof_ownership own ON own.proof_id=b.proof_id AND own.merchant_id=b.merchant_id AND own.environment=b.environment
    JOIN platform_principals principal ON principal.id=own.origin_principal_id AND principal.organization_id=own.merchant_id
    JOIN platform_memberships m ON m.id=own.operator_membership_id AND m.organization_id=own.merchant_id AND m.revoked_at IS NULL AND m.role IN ('OWNER','ADMIN','OPERATOR')
    JOIN users u ON u.id=m.user_id AND u.status='ACTIVE'
    JOIN proofs p ON p.id=b.proof_id JOIN transactions t ON t.id=p.transaction_id
    LEFT JOIN record_state s ON s.proof_id=b.proof_id
    WHERE b.merchant_id=$1 AND b.environment=$2 AND b.integration_account_id=$3 AND own.operator_membership_id=$4
      AND own.origin_delegation_id IS NULL AND b.resource_type='ORDER' AND s.location_id IS NOT DISTINCT FROM $5
      AND (s.proof_id IS NULL OR (s.organization_id=$1 AND s.environment=$2))
      AND (NOT m.location_scoped OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=m.id AND g.organization_id=m.organization_id AND g.location_id=$5))
      AND t.transaction_metadata->>'source'='organization_api' AND t.transaction_metadata->>'integrationAccountId'=b.integration_account_id
      AND t.transaction_metadata->>'externalId'=b.external_id AND t.transaction_metadata->>'orderSnapshotSha256'=b.snapshot_sha256
      AND t.transaction_metadata->>'merchantId'=b.merchant_id AND t.transaction_metadata->>'environment'=b.environment
      AND t.transaction_metadata->>'originPrincipalId'=own.origin_principal_id
      AND NOT EXISTS(SELECT 1 FROM record_agent_installations ai WHERE ai.principal_id=own.origin_principal_id)
      AND NOT EXISTS(SELECT 1 FROM record_order_roots r WHERE r.proof_id=b.proof_id)
      AND b.proof_id>$6 AND b.created_at<=(SELECT decided_at FROM record_order_sessions WHERE id=$7)
    ORDER BY b.proof_id LIMIT 9`,[o.organization,o.environment,o.account,o.operator,o.location,progress.cursor_proof_id,session.id])).rows;
  const page=orders.slice(0,8);
  for(const old of page){
    if(!old.snapshot || sha256Hex(canonicalize(old.snapshot))!==old.snapshot_sha256)
      throw new DomainError('HISTORY_SNAPSHOT_UNVERIFIED','The stored order snapshot no longer matches its original receipt. Review the source history.',409);
    // No historical request body is available. Retain a clearly labelled and
    // independently verifiable derived record referencing the earlier receipt.
    const sourceSnapshot={kind:'derived_order_snapshot',proofId:old.proof_id,externalId:old.external_id,
      sourceSnapshotSha256:old.snapshot_sha256,originalRequestAvailable:false,transaction:old.snapshot};
    const bytes=Buffer.from(canonicalize(sourceSnapshot)),sha=sha256Hex(bytes);
    const stored=await preserveOrderOriginal(deps,o.organization,sha,bytes,'application/json');
    const receipt=newId('order_receipt'),fields:Record<string,string>={};
    if(typeof old.snapshot.itemTitle==='string')fields.itemTitle=old.snapshot.itemTitle;
    if(old.snapshot.quantity!=null)fields.quantity=String(old.snapshot.quantity);
    const record=normalizedRecord({eventId:old.proof_id,version:'1',kind:'order',facilityId:i.location_id,
      entity:{namespace:source.sourceNamespace,type:'order',id:old.external_id},references:[],fields,locator:'$.transaction'});
    await db.query(`INSERT INTO record_order_receipts(id,operation_key,source_id,generation,observation_id,payload_digest,original_sha256,
      object_key,object_version,file_name,media_type,profile_version,issues,received_at,session_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prior-order-snapshot.json','application/json',$10,'[]'::jsonb,$11,$12)`,
      [receipt,o.operation,source.id,source.generation,'historical:'+old.proof_id,old.snapshot_sha256,sha,stored.key,stored.version,historyProfile,deps.clock.now().toISOString(),session.id]);
    await ensureOrderRoot(db,deps.clock,actor,o,source.id,record,old.proof_id);
    await insertOrderEvent(db,o.operation,source.id,receipt,record);
    await commitOrderGroup(db,deps.clock,o.operation,await orderComponent(db,o.operation,[refKey(record.entity)]),actor.actorUserId);
  }
  const hasMore=orders.length>page.length;
  await db.query(`UPDATE record_order_api_progress SET cursor_proof_id=$4,history_finished=$5
    WHERE installation_id=$1 AND source_id=$2 AND generation=$3`,[...params,page.at(-1)?.proof_id??progress.cursor_proof_id,!hasMore]);
  return {processed:page.length,hasMore,state:hasMore?'collecting':'current'};
}

