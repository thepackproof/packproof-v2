import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import type { IntegrationAdapterRegistry } from '../integrations/registry.js';
import { requireActiveAccount } from './account-access.js';
import { DomainError } from './errors.js';
import type { IntegrationConnectionRow } from './integration-connections.js';
import { loadCommerceSyncState, syncStateView } from './commerce-order-records.js';
import { commerceConnectionCapabilities, getCommerceReviewSummary } from './commerce-automation.js';
import { asIso } from './types.js';

type CountRow = {
 total:string; eligible:string; excluded:string; missing:string;
 awaiting:string; progress:string; finalized:string; other:string;
 oldest_awaiting:Date|string|null;
};

/** Owner-only first-party projection. A provider namespace is not a connection,
 * a successful sync is not evidence, and finalized counts are not Ready counts. */
export async function getCommerceConnectionHealth(
 db:Database, clock:Clock, userId:string, connectionId:string,
 integrations:IntegrationAdapterRegistry, automationProviders?:readonly string[],
){
 await requireActiveAccount(db,userId);
 const connection=(await db.query<IntegrationConnectionRow>(
  'SELECT * FROM integration_connections WHERE id=$1 AND owner_user_id=$2',[connectionId,userId])).rows[0];
 if(!connection)throw new DomainError('INTEGRATION_NOT_FOUND','Integration connection not found',404);
 const now=clock.now();
 const state=await loadCommerceSyncState(db,connectionId);
 const sync=syncStateView(state);
 const capabilities=await commerceConnectionCapabilities(db,connection,integrations,automationProviders);
 const review=await getCommerceReviewSummary(db,connectionId);
 const counts=(await db.query<CountRow>(`
  WITH classified AS (
   SELECT r.eligibility,r.first_seen_at,
    CASE
     WHEN p.id IS NULL THEN 'MISSING'
     WHEN p.status='FINALIZED' THEN 'FINALIZED'
     WHEN p.status='EVIDENCE_COMMITTED' OR EXISTS(
       SELECT 1 FROM evidence e WHERE e.proof_id=p.id AND e.validation_status IN ('PENDING','COMMITTED')
     ) THEN 'PROGRESS'
     WHEN p.status IN ('OPEN','AWAITING_PARTICIPANT','READY_FOR_EVIDENCE') THEN 'AWAITING'
     ELSE 'OTHER'
    END AS category
   FROM commerce_order_records r LEFT JOIN proofs p ON p.transaction_id=r.transaction_id
   WHERE r.connection_id=$1
  )
  SELECT count(*)::text AS total,
   count(*) FILTER(WHERE eligibility='FULFILLMENT_ELIGIBLE')::text AS eligible,
   count(*) FILTER(WHERE eligibility<>'FULFILLMENT_ELIGIBLE')::text AS excluded,
   count(*) FILTER(WHERE eligibility='FULFILLMENT_ELIGIBLE' AND category='MISSING')::text AS missing,
   count(*) FILTER(WHERE eligibility='FULFILLMENT_ELIGIBLE' AND category='AWAITING')::text AS awaiting,
   count(*) FILTER(WHERE eligibility='FULFILLMENT_ELIGIBLE' AND category='PROGRESS')::text AS progress,
   count(*) FILTER(WHERE eligibility='FULFILLMENT_ELIGIBLE' AND category='FINALIZED')::text AS finalized,
   count(*) FILTER(WHERE eligibility='FULFILLMENT_ELIGIBLE' AND category='OTHER')::text AS other,
   min(first_seen_at) FILTER(WHERE eligibility='FULFILLMENT_ELIGIBLE' AND category='AWAITING') AS oldest_awaiting
  FROM classified`,[connectionId])).rows[0];
 const inbox=(await db.query<{pending:string;oldest:Date|string|null}>(`
  SELECT count(*)::text AS pending,min(received_at) AS oldest
  FROM commerce_webhook_inbox WHERE connection_id=$1 AND processed_at IS NULL`,[connectionId])).rows[0];
 const age=state?.last_succeeded_at?Math.max(0,Math.floor((now.getTime()-new Date(state.last_succeeded_at).getTime())/1000)):null;
 // Diagnostic threshold derived from the registered poll cadence; this is not a
 // contractual provider freshness guarantee and the actual watermark is returned.
 const staleAfterSeconds=capabilities.pollIntervalSeconds===null?null:Math.max(300,capabilities.pollIntervalSeconds*3);
 const expiredLease=state?.run_status==='RUNNING'&&(!state.lease_expires_at||new Date(state.lease_expires_at).getTime()<=now.getTime());
 const nextAction=connection.status!=='ACTIVE'||sync.reconnectRequired?'RECONNECT'
  :capabilities.automationUnavailableReason==='ADAPTER_UNAVAILABLE'?'NO_ORDER_IMPORT'
  :capabilities.automationUnavailableReason!==null?'CONTACT_SUPPORT'
  :expiredLease?'CONTACT_SUPPORT'
  :sync.runStatus==='FAILED'?(sync.retryable?'RETRY_SYNC':'CONTACT_SUPPORT')
  :!connection.auto_sync_enabled?'ENABLE_AUTOMATION'
  :age===null||sync.runStatus==='RUNNING'||sync.runStatus==='RETRYING'?'WAIT'
  :'NONE';
 return {
  schema:'packproof.connection-health/v1',connectionId,provider:connection.provider,
  observedAt:now.toISOString(),status:connection.status,
  capabilities,
  automation:{optedIn:connection.auto_sync_enabled===true,
   paused:connection.auto_sync_enabled!==true||connection.status!=='ACTIVE'},
  sync:{...sync,sourceWatermarkAt:state?.last_succeeded_at?asIso(state.last_succeeded_at):null,
   sourceAgeSeconds:age,staleAfterSeconds,
   stale:age!==null&&staleAfterSeconds!==null?age>staleAfterSeconds:null,
   pageResumePending:Boolean(state?.provider_cursor),expiredLease,
   pendingProviderEvents:Number(inbox?.pending??0),
   oldestPendingProviderEventAt:inbox?.oldest?asIso(inbox.oldest):null},
  coverage:{basis:'DISCOVERED_SOURCE_RECORDS',
   discovered:Number(counts.total),eligible:Number(counts.eligible),excluded:Number(counts.excluded),
   eligibleWithoutProof:Number(counts.missing),awaitingCapture:Number(counts.awaiting),
   inProgress:Number(counts.progress),finalized:Number(counts.finalized),
   otherEligible:Number(counts.other),
   oldestAwaitingCaptureAt:counts.oldest_awaiting?asIso(counts.oldest_awaiting):null,...review},
  nextAction,
 };
}
