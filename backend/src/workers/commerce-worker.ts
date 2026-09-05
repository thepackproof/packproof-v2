import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { executeCommerceFulfillmentSync, type CommerceSyncDependencies } from "../domain/commerce-fulfillment-sync.js";
/** Workers make progress with no browser tab. PostgreSQL fences concurrent API replicas. */
export async function dispatchCommerceSyncs(db: Database, clock: Clock, deps: CommerceSyncDependencies, limit = 5) {
    const rows = (await db.query<{
        id: string;
        owner_user_id: string;
        adapter_key: string;
    }>(`SELECT c.id,c.owner_user_id,c.adapter_key
    FROM integration_connections c LEFT JOIN commerce_connection_sync_states s ON s.connection_id=c.id
    WHERE c.status='ACTIVE' AND c.auto_sync_enabled=true AND COALESCE(s.run_status,'IDLE')<>'FAILED'
      AND (s.next_run_at IS NULL OR s.next_run_at<=$1) AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=$1)
    ORDER BY COALESCE(s.next_run_at,c.created_at),c.id LIMIT $2`, [clock.now().toISOString(), Math.min(Math.max(limit, 1), 25)])).rows;
    let completed = 0, failed = 0;
    for (const row of rows) {
        if (!deps.integrations.hasCommerce(row.adapter_key))
            continue;
        try {
            await executeCommerceFulfillmentSync(db, clock, row.owner_user_id, row.id, deps, { background: true, maxPages: 5 });
            completed++;
        }
        catch {
            failed++;
        }
    }
    return { completed, failed };
}
export function startCommerceWorker(db: Database, clock: Clock, deps: CommerceSyncDependencies) {
    let active: Promise<void> | null = null;
    const tick = () => {
        if (active)
            return;
        active = dispatchCommerceSyncs(db, clock, deps).then(result => { if (result.failed)
            console.warn(JSON.stringify({ event: "commerce_sync_retry", failed: result.failed })); })
            .catch(() => console.error(JSON.stringify({ event: "commerce_worker_failed" }))).finally(() => { active = null; });
    };
    const timer = setInterval(tick, 15000);
    timer.unref();
    tick();
    return async () => { clearInterval(timer); await active; };
}
