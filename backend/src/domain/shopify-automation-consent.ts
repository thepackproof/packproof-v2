import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { ConnectedAccountRecord } from "./connected-account-records.js";
import { DomainError } from "./errors.js";
import { shopifyShopHandle } from "../integrations/shopify/shop.js";

/** Only the initiating seller's OAuth state may carry this consent. */
export function parseShopifyAutomationConsent(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new DomainError("INVALID_AUTOMATION_SETTING", "Choose whether to start Shopify Proofs automatically", 400);
  }
  return value;
}

/**
 * Apply an explicit first-install choice. Reconnects never overwrite a seller's
 * pause setting. The independent runtime rollout gate still controls dispatch.
 */
export async function applyShopifyInitialAutomationConsent(
  db: Database,
  clock: Clock,
  account: ConnectedAccountRecord,
  input: { requested: unknown; isNewAccount: boolean },
): Promise<void> {
  if (account.provider !== "shopify" || !input.isNewAccount || input.requested !== true) return;
  await db.transaction(async tx => {
    const now = clock.now().toISOString();
    const connection = (await tx.query<{ id: string }>(`
      UPDATE integration_connections SET auto_sync_enabled=true,updated_at=$4
      WHERE owner_user_id=$1 AND provider='shopify' AND adapter_key='shopify'
        AND external_account_reference=$2 AND credential_reference=$3 AND status='ACTIVE'
      RETURNING id`, [account.userId, shopifyShopHandle(account.externalAccountId), account.credentialReference, now])).rows[0];
    if (!connection) throw new DomainError("INTEGRATION_CONNECTION_NOT_FOUND", "The Shopify order connection is unavailable", 409);
    await tx.query(`INSERT INTO commerce_connection_sync_states(connection_id,updated_at,next_run_at)
      VALUES($1,$2,$2) ON CONFLICT(connection_id) DO UPDATE SET next_run_at=$2,updated_at=$2`, [connection.id, now]);
  });
}
