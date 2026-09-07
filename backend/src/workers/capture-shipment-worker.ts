import type { ManifestSigningRuntime } from '../integrity/signing-runtime.js';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { DomainError } from '../domain/errors.js';
import { IntegrationError, integrationNotFound } from '../domain/integration-errors.js';
import { executeTrustedShipmentSync } from '../domain/trusted-shipment-sync.js';
import type { IntegrationCredentialStore } from '../integrations/credentials.js';
import type { IntegrationAdapterRegistry } from '../integrations/registry.js';
import { EASYPOST_TRACKER_ADAPTER_KEY, easypostCredentialReferenceAllowed } from '../integrations/easypost/adapter.js';
import { SHIPPO_TRACKER_ADAPTER_KEY } from '../integrations/shippo/adapter.js';

export interface CaptureShipmentDependencies {
  manifestSigning?: ManifestSigningRuntime;
  integrations: IntegrationAdapterRegistry;
  credentials: IntegrationCredentialStore;
  /** Server configuration only. Never accepted from a camera or HTTP request. */
  defaultEasyPostCredentialReference?: string;
  defaultShippoCredentialReference?: string;
}

async function ensureConnection(db: Database, clock: Clock, transactionId: string, actor: string, deps: CaptureShipmentDependencies) {
  // Shippo is the default for new bindings. Preserve an explicitly configured
  // legacy EasyPost deployment and every already-bound transaction.
  const shippo = Boolean(deps.defaultShippoCredentialReference) || !deps.defaultEasyPostCredentialReference;
  const adapterKey = shippo ? SHIPPO_TRACKER_ADAPTER_KEY : EASYPOST_TRACKER_ADAPTER_KEY;
  const provider = shippo ? 'shippo' : 'easypost';
  const reference = shippo ? deps.defaultShippoCredentialReference : deps.defaultEasyPostCredentialReference;
  await db.transaction(async tx => {
    await tx.query('SELECT id FROM transactions WHERE id=$1 FOR UPDATE',[transactionId]);
    if ((await tx.query('SELECT transaction_id FROM transaction_shipment_connections WHERE transaction_id=$1',[transactionId])).rows.length) return;
    const own = (await tx.query<{id:string}>("SELECT id FROM integration_connections WHERE owner_user_id=$1 AND adapter_key=$2 AND status='ACTIVE' ORDER BY created_at,id LIMIT 2",[actor,adapterKey])).rows;
    let connectionId: string;
    if (own.length === 1) connectionId = own[0].id;
    else if (own.length === 0 && reference && easypostCredentialReferenceAllowed(reference)) {
      connectionId = `conn_capture_${sha256Hex(`${adapterKey}:${actor}`).slice(0,32)}`;
      await tx.query(`INSERT INTO integration_connections(id,owner_user_id,adapter_key,provider,credential_reference,status,created_at,updated_at)
        VALUES($1,$2,$3,$6,$4,'ACTIVE',$5,$5) ON CONFLICT(id) DO NOTHING`,[connectionId,actor,adapterKey,reference,clock.now().toISOString(),provider]);
    } else throw integrationNotFound();
    await tx.query('INSERT INTO transaction_shipment_connections(transaction_id,connection_id,created_at) VALUES($1,$2,$3)',[transactionId,connectionId,clock.now().toISOString()]);
  });
}

/** Durable registration plus periodic refresh. A lease fences workers on multiple replicas. */
export async function dispatchCaptureShipments(db: Database, clock: Clock, deps: CaptureShipmentDependencies, limit = 5) {
  let completed = 0, failed = 0;
  for (let index = 0; index < Math.min(Math.max(limit,1),25); index++) {
    const now = clock.now(), token = newId('shipment_lease');
    const job = await db.transaction(async tx => {
      const row = (await tx.query<{transaction_id:string;actor_user_id:string;attempts:number}>(
        `SELECT transaction_id,actor_user_id,attempts FROM capture_shipment_jobs WHERE state<>'FAILED' AND next_run_at<=$1 AND (lease_until IS NULL OR lease_until<=$1)
         ORDER BY next_run_at,transaction_id LIMIT 1 FOR UPDATE SKIP LOCKED`,[now.toISOString()])).rows[0];
      if (!row) return null;
      await tx.query('UPDATE capture_shipment_jobs SET lease_token=$2,lease_until=$3 WHERE transaction_id=$1',[row.transaction_id,token,new Date(now.getTime()+120000).toISOString()]);
      return row;
    });
    if (!job) break;
    try {
      await ensureConnection(db,clock,job.transaction_id,job.actor_user_id,deps);
      const result = await executeTrustedShipmentSync(db,clock,job.actor_user_id,job.transaction_id,deps);
      // RETURNED can mean still en route to sender. Continue refreshing it.
      const latest = result.events.filter(e=>e.eventType!=='WEIGHT_RECORDED').sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt))[0];
      // Continue a bounded correction window after a terminal report so delayed
      // carrier corrections and missing notifications can still reconcile.
      const terminal = latest && ['DELIVERED','CANCELLED'].includes(latest.eventType) && Date.parse(latest.occurredAt) + 72*3600000 < clock.now().getTime();
      await db.query(`UPDATE capture_shipment_jobs SET state='REGISTERED',attempts=0,next_run_at=$3,lease_token=NULL,lease_until=NULL,last_error_code=NULL,carrier=$4,provider_mode=$5,registered_at=COALESCE(registered_at,$6),updated_at=$6 WHERE transaction_id=$1 AND lease_token=$2`,
        [job.transaction_id,token,terminal?null:new Date(clock.now().getTime()+6*3600000).toISOString(),result.carrier??null,result.mode??null,clock.now().toISOString()]);
      await db.query("UPDATE shipment_notification_inbox SET state='RECONCILED',processed_at=$2 WHERE transaction_id=$1 AND state='QUEUED' AND received_at<=$3",[job.transaction_id,clock.now().toISOString(),now.toISOString()]);
      completed++;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'PROVIDER_TEMPORARILY_UNAVAILABLE';
      const waiting = ['INTEGRATION_NOT_FOUND','INTEGRATION_CREDENTIALS_UNAVAILABLE','INTEGRATION_NEEDS_REAUTH','INTEGRATION_DISABLED','PROVIDER_AUTH_FAILED','SHIPMENT_CARRIER_REQUIRED','SHIPPO_TEST_TRACKING_ONLY'].includes(code);
      const attempts = job.attempts+1;
      const retryable = waiting || !(error instanceof IntegrationError) || error.retryable || code === 'TRACKING_NOT_FOUND';
      const state = waiting ? 'WAITING_FOR_CONNECTION' : retryable && attempts<8 ? 'RETRY' : 'FAILED';
      const delay = waiting ? 3600000 : Math.min(6*3600000,30000*2**attempts);
      await db.query(`UPDATE capture_shipment_jobs SET state=$3,attempts=$4,next_run_at=$5,lease_token=NULL,lease_until=NULL,last_error_code=$6,updated_at=$7 WHERE transaction_id=$1 AND lease_token=$2`,
        [job.transaction_id,token,state,waiting?job.attempts:attempts,state==='FAILED'?null:new Date(clock.now().getTime()+delay).toISOString(),code,clock.now().toISOString()]);
      failed++;
    }
  }
  return {completed,failed};
}

export function startCaptureShipmentWorker(db: Database, clock: Clock, deps: CaptureShipmentDependencies) {
  let active: Promise<unknown>|null = null;
  const tick = () => {
    if (active) return;
    active = dispatchCaptureShipments(db,clock,deps).catch(()=>console.error(JSON.stringify({event:'capture_shipment_worker_failed'}))).finally(()=>{active=null;});
  };
  const timer = setInterval(tick,15000); timer.unref(); tick();
  return async () => {clearInterval(timer);await active;};
}
