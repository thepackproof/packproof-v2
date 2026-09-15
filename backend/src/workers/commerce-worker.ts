import { DomainError } from "../domain/errors.js";
import { startScheduledJobs } from "../operations/scheduler.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { executeCommerceFulfillmentSync, type CommerceSyncDependencies } from "../domain/commerce-fulfillment-sync.js";
/** Workers make progress with no browser tab. PostgreSQL fences concurrent API replicas. */
export async function dispatchCommerceSyncs(db: Database, clock: Clock, deps: CommerceSyncDependencies, limit = 5) {
    const adapterKeys = deps.integrations.listCommerceAdapterKeys().filter(key =>
        !deps.automationProviders || deps.automationProviders.includes(deps.integrations.getCommerce(key).provider));
    const rows = (await db.query<{
        id: string;
        owner_user_id: string;
        adapter_key: string;
    }>(`SELECT c.id,c.owner_user_id,c.adapter_key
    FROM integration_connections c LEFT JOIN commerce_connection_sync_states s ON s.connection_id=c.id
    WHERE c.status='ACTIVE' AND c.auto_sync_enabled=true AND c.adapter_key=ANY($3::text[]) AND COALESCE(s.run_status,'IDLE')<>'FAILED'
      AND (s.next_run_at IS NULL OR s.next_run_at<=$1) AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=$1)
    ORDER BY COALESCE(s.next_run_at,c.created_at),c.id LIMIT $2`, [clock.now().toISOString(), Math.min(Math.max(limit, 1), 25), adapterKeys])).rows;
    let completed = 0, failed = 0;
    for (const row of rows) {
        if (!deps.integrations.hasCommerce(row.adapter_key) || (deps.automationProviders && !deps.automationProviders.includes(deps.integrations.getCommerce(row.adapter_key).provider)))
            continue;
        try {
            await executeCommerceFulfillmentSync(db, clock, row.owner_user_id, row.id, deps, { background: true, maxPages: 5 });
            completed++;
        }
        catch (error) {
            // Another replica winning the connection lease is healthy, duplicate-safe scheduling.
            if (error instanceof DomainError && ["COMMERCE_SYNC_IN_PROGRESS", "COMMERCE_SYNC_LEASE_LOST"].includes(error.code)) continue;
            failed++;
        }
    }
    return { completed, failed };
}
export function startCommerceWorker(db: Database, clock: Clock, deps: CommerceSyncDependencies) {
    return startScheduledJobs(db, clock, [{name: "commerce", intervalMs: 15000, run: () => dispatchCommerceSyncs(db, clock, deps)}]);
}
