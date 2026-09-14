import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { IntegrationCredentialStore } from '../integrations/credentials.js';
import { readShippoOrderBatch, ShippoOrdersError, type ShippoOrdersCursor, type ShippoOrderIdentity } from '../integrations/shippo/orders.js';
import { submitIntakeObservation, type IntakeScope } from './context.js';
import { tenantKeyForImport } from '../domain/provenance.js';
import { listOwnerConnections, type IntegrationConnectionRow } from '../domain/integration-connections.js';
import { upsertCommerceOrderRecord, bindCommerceOrderTransaction, type CommerceSyncStateRow } from '../domain/commerce-order-records.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';

export interface ShippoIntakeRuntimeConfig {
  enabled: boolean;
  shippoEnabled: boolean;
  actorIds: readonly string[];
}
export interface ShippoIntakeRuntimeDeps {
  credentialStore: IntegrationCredentialStore;
  /** Evaluated on each invocation and before each committed observation. */
  config: () => ShippoIntakeRuntimeConfig;
  fetchImpl?: typeof fetch;
}
const LEASE_MS = 10 * 60_000;
function enabled(deps: ShippoIntakeRuntimeDeps, actor?: string): boolean {
  const flags = deps.config(); return flags.enabled && flags.shippoEnabled && flags.actorIds.length > 0 && (!actor || flags.actorIds.includes(actor));
}

/** Scheduled by the existing process; no network request runs inside a DB transaction. */
export async function dispatchShippoIntake(db: Database, clock: Clock, deps: ShippoIntakeRuntimeDeps, limit = 2): Promise<{ completed: number; failed: number }> {
  const counts = { completed: 0, failed: 0 }; if (!enabled(deps)) return counts;
  const actors = [...deps.config().actorIds];
  const rows = (await db.query<IntegrationConnectionRow>(`SELECT c.* FROM integration_connections c
    LEFT JOIN commerce_connection_sync_states s ON s.connection_id=c.id
    WHERE c.adapter_key='shippo-orders' AND c.provider='shippo' AND c.status='ACTIVE' AND c.auto_sync_enabled=true
      AND c.owner_user_id=ANY($1::text[]) AND c.external_account_reference IS NOT NULL
      AND COALESCE(s.run_status,'IDLE')<>'FAILED' AND (s.next_run_at IS NULL OR s.next_run_at<=$2)
      AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=$2)
    ORDER BY COALESCE(s.next_run_at,c.created_at),c.id LIMIT $3`, [actors, clock.now().toISOString(), Math.min(5, Math.max(1, limit))])).rows;
  for (const connection of rows) {
    if (!enabled(deps, connection.owner_user_id)) continue;
    const token = newId('shippo_lease'), start = clock.now();
    const state = await db.transaction(async tx => {
      const active = (await tx.query<{ id: string }>(`SELECT id FROM integration_connections WHERE id=$1 AND owner_user_id=$2 AND adapter_key='shippo-orders' AND status='ACTIVE' AND auto_sync_enabled=true FOR UPDATE`, [connection.id, connection.owner_user_id])).rows[0];
      if (!active) return null;
      await tx.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at) VALUES($1,$2) ON CONFLICT(connection_id) DO NOTHING`, [connection.id, start.toISOString()]);
      const row = (await tx.query<CommerceSyncStateRow>('SELECT * FROM commerce_connection_sync_states WHERE connection_id=$1 FOR UPDATE', [connection.id])).rows[0];
      if (row.run_status === 'FAILED' || (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > start.getTime()) || (row.next_run_at && new Date(row.next_run_at).getTime() > start.getTime())) return null;
      await tx.query(`UPDATE commerce_connection_sync_states SET run_status='RUNNING',lease_token=$2,lease_expires_at=$3,last_attempted_at=$4,updated_at=$4 WHERE connection_id=$1`, [connection.id, token, new Date(start.getTime() + LEASE_MS).toISOString(), start.toISOString()]);
      return row;
    });
    if (!state) continue;
    try {
      const scope: IntakeScope = { provider: 'shippo', externalAccountReference: connection.external_account_reference!, namespaceSource: 'SHIPPING_PROVIDER_API', connectionId: connection.id, store: 'Shippo', verified: true };
      const tenantKey = tenantKeyForImport(scope.provider, scope.namespaceSource, scope.externalAccountReference);
      const known = (await db.query<{external_order_id:string}>(`SELECT o.external_order_id FROM commerce_order_records o
        LEFT JOIN proofs p ON p.transaction_id=o.transaction_id
        WHERE o.connection_id=$1 AND o.commerce_tenant_key=$2 AND (p.id IS NULL OR p.status<>'FINALIZED')
        ORDER BY o.last_seen_at,o.external_order_id LIMIT 1001`, [connection.id, tenantKey])).rows.map(row => row.external_order_id);
      // Do not silently drop an oversized reconciliation inventory.
      if (known.length > 1000) throw new ShippoOrdersError('PROVIDER_RESPONSE_INVALID');
      const owned = await listOwnerConnections(db, connection.owner_user_id);
      let cursor: ShippoOrdersCursor | null = null;
      if (state.provider_cursor) { try { cursor = JSON.parse(state.provider_cursor) as ShippoOrdersCursor; } catch { throw new ShippoOrdersError('CURSOR_SCOPE_MISMATCH'); } }
      const batch = await readShippoOrderBatch({ credentialStore: deps.credentialStore, tenantId: connection.owner_user_id, connectionId: connection.id, merchantAccountId: connection.external_account_reference!, credentialReference: connection.credential_reference, scope, cursor, knownOrderIds: known, fetchImpl: deps.fetchImpl, now: () => clock.now(),
        retainSource: async source => {
          const id = `shippo_raw_${sha256Hex(`${connection.id}:${source.sha256}`)}`;
          await db.query(`INSERT INTO intake_provider_raw_sources(id,actor_user_id,connection_id,sha256,source_bytes,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(connection_id,sha256) DO NOTHING`, [id, connection.owner_user_id, connection.id, source.sha256, source.bytes, clock.now().toISOString()]);
          return `intake-provider-source:${id}`;
        },
        resolveIdentity: objectId => resolveExistingShippoAlias(db, connection, owned, tenantKey, objectId),
      });
      let ready = 0;
      for (const observation of batch.observations) {
        if (!enabled(deps, connection.owner_user_id)) throw new Error('INTAKE_ADMISSION_STOPPED');
        await db.transaction(async tx => {
          const fenced = (await tx.query<{connection_id:string}>(`SELECT s.connection_id FROM commerce_connection_sync_states s JOIN integration_connections c ON c.id=s.connection_id
            WHERE s.connection_id=$1 AND s.lease_token=$2 AND s.lease_expires_at>$3 AND c.status='ACTIVE' AND c.auto_sync_enabled=true AND c.owner_user_id=$4 FOR UPDATE OF s,c`, [connection.id, token, clock.now().toISOString(), connection.owner_user_id])).rows[0];
          if (!fenced) throw new Error('SHIPPO_LEASE_LOST');
          // Include retained-response digest so a changed page cannot reuse a receipt with a different raw reference.
          observation.input.receiptId = `shippo:${sha256Hex(`${observation.input.receiptId}:${observation.sourceDigest}`)}`;
          const result = await submitIntakeObservation(tx, clock, connection.owner_user_id, observation.input, observation.scope);
          const record = await upsertCommerceOrderRecord(tx, clock, { connectionId: connection.id, commerceTenantKey: tenantKey, externalOrderId: observation.shippoOrderId, externalReference: observation.input.orderReference ?? null, orderedAt: null,
            paymentState: observation.input.paid === true ? 'CONFIRMED' : observation.input.paid === false ? 'PENDING' : 'UNKNOWN',
            fulfillmentState: observation.input.cancelled ? 'CANCELLED' : observation.input.fulfillmentScope === 'PARTIAL' ? 'IN_PROGRESS' : observation.providerStatus === 'PAID' && !observation.labelCreated && observation.input.fulfillmentScope === 'FULL_ORDER' ? 'AWAITING_FULFILLMENT' : 'UNKNOWN',
            requiresPhysicalFulfillment: observation.input.physicalFulfillment === true, cancelled: observation.input.cancelled, eligibility: result.readiness === 'READY' ? 'FULFILLMENT_ELIGIBLE' : 'INELIGIBLE', providerUpdatedAt: observation.input.sourceOccurredAt ?? null, fingerprint: observation.sourceDigest });
          if (result.transactionId) await bindCommerceOrderTransaction(tx, record.id, result.transactionId);
          if (result.readiness === 'READY') ready++;
        });
      }
      const now = clock.now();
      const committed = await db.query(`UPDATE commerce_connection_sync_states SET run_status='IDLE',lease_token=NULL,lease_expires_at=NULL,attempt_count=0,
        provider_cursor=$3,last_succeeded_at=$4,last_error_code=NULL,last_error_retryable=NULL,updated_at=$4,next_run_at=$5,
        discovered_count=discovered_count+$6,eligible_count=eligible_count+$7,last_reconciled_at=CASE WHEN $3::text IS NULL THEN $4::timestamptz ELSE last_reconciled_at END
        WHERE connection_id=$1 AND lease_token=$2`, [connection.id, token, batch.nextCursor ? JSON.stringify(batch.nextCursor) : null, now.toISOString(), new Date(now.getTime() + (batch.nextCursor ? 15_000 : 300_000)).toISOString(), batch.observations.length, ready]);
      if (committed.rowCount) counts.completed++;
    } catch (error) {
      const provider = error instanceof ShippoOrdersError ? error : null;
      const retryable = provider?.code === 'PROVIDER_RETRY_REQUIRED' || !provider;
      const attempts = Number(state.attempt_count ?? 0) + 1;
      const code = provider?.code ?? (error instanceof Error && ['SHIPPO_LEASE_LOST','INTAKE_ADMISSION_STOPPED'].includes(error.message) ? error.message : 'SHIPPO_INTAKE_FAILED');
      const delay = provider?.retryAfterMs ?? Math.min(900_000, 30_000 * 2 ** Math.min(attempts, 5));
      await db.query(`UPDATE commerce_connection_sync_states SET run_status=$3,lease_token=NULL,lease_expires_at=NULL,attempt_count=$4,last_error_code=$5,last_error_retryable=$6,updated_at=$7,next_run_at=$8
        WHERE connection_id=$1 AND lease_token=$2`, [connection.id, token, retryable && attempts < 5 ? 'RETRYING' : 'FAILED', attempts, code, retryable, clock.now().toISOString(), new Date(clock.now().getTime() + delay).toISOString()]);
      if (provider?.code === 'PROVIDER_AUTH_FAILED') await db.query(`UPDATE integration_connections SET status='NEEDS_REAUTH',updated_at=$2 WHERE id=$1 AND status='ACTIVE'`, [connection.id, clock.now().toISOString()]);
      counts.failed++;
    }
  }
  return counts;
}

async function resolveExistingShippoAlias(db: Database, source: IntegrationConnectionRow, owned: IntegrationConnectionRow[], shippoTenant: string, objectId: string): Promise<ShippoOrderIdentity | null> {
  const identities = (await db.query<{transaction_id:string;tenant_key:string;external_transaction_id:string;source:string}>(`SELECT target.transaction_id,target.tenant_key,target.external_transaction_id,target.source
    FROM transaction_integration_identities anchor JOIN transactions t ON t.id=anchor.transaction_id
    JOIN transaction_integration_identities target ON target.transaction_id=anchor.transaction_id
    WHERE anchor.tenant_key=$1 AND anchor.external_transaction_id=$2 AND t.created_by=$3 AND target.tenant_key<>$1`, [shippoTenant, objectId, source.owner_user_id])).rows;
  const candidates: ShippoOrderIdentity[] = [];
  for (const identity of identities) {
    if (!['MARKETPLACE_API','STOREFRONT_API'].includes(identity.source)) continue;
    const namespaceSource = identity.source as 'MARKETPLACE_API'|'STOREFRONT_API';
    const connections = owned.filter(row => row.status === 'ACTIVE' && row.external_account_reference && tenantKeyForImport(row.provider, namespaceSource, row.external_account_reference) === identity.tenant_key);
    if (connections.length !== 1) continue;
    const canonical = connections[0];
    const facts = (await db.query<{payment_state:string;requires_physical_fulfillment:boolean}>(`SELECT payment_state,requires_physical_fulfillment FROM commerce_order_records WHERE connection_id=$1 AND transaction_id=$2 AND external_order_id=$3`, [canonical.id, identity.transaction_id, identity.external_transaction_id])).rows;
    candidates.push({ externalOrderId: identity.external_transaction_id, scope: { provider: canonical.provider, externalAccountReference: canonical.external_account_reference!, namespaceSource, connectionId: source.id, store: canonical.provider, verified: true }, paid: facts.length === 1 ? facts[0].payment_state === 'CONFIRMED' ? true : null : null, physicalFulfillment: facts.length === 1 ? facts[0].requires_physical_fulfillment : null });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function startShippoIntakeWorker(db: Database, clock: Clock, deps: ShippoIntakeRuntimeDeps): () => Promise<void> {
  let active: Promise<unknown> | null = null;
  const tick = () => { if (!active) active = dispatchShippoIntake(db, clock, deps).catch(() => undefined).finally(() => { active = null; }); };
  const timer = setInterval(tick, 15_000); timer.unref(); tick();
  return async () => { clearInterval(timer); await active; };
}
