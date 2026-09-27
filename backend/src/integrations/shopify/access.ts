import type { Clock } from "../../clock.js";
import type { Database } from "../../db/database.js";
import { requireActiveAccount } from "../../domain/account-access.js";
import { findOwnedByProviderExternal, type ConnectedAccountRecord } from "../../domain/connected-account-records.js";
import { refreshConnectedAccountCredentials, syncConnectedShopifyWebhooks, type ConnectedAccountService } from "../../domain/connected-accounts.js";
import { DomainError } from "../../domain/errors.js";
import { loadConnection, type IntegrationConnectionRow } from "../../domain/integration-connections.js";
import { scopesFromMaterial } from "../connected-accounts/credentials.js";
import { requireShopifyScopes } from "../connected-accounts/providers/shopify.js";
import { normalizeShopifyShop } from "./shop.js";

export type ShopifyAccessTokenRunner = <T>(connection: IntegrationConnectionRow, operation: (accessToken: string) => Promise<T>) => Promise<T>;
const REFRESH_EARLY_MS = 60_000;

/** Fetches current owner/shop-bound credentials for API and background work. */
export function createShopifyAccessTokenRunner(db: Database, clock: Clock, service: ConnectedAccountService): ShopifyAccessTokenRunner {
  async function activeAccount(connection: IntegrationConnectionRow): Promise<ConnectedAccountRecord> {
    const current = await loadConnection(db, connection.id);
    await requireActiveAccount(db, current.owner_user_id);
    if (connection.adapter_key !== "shopify" || connection.provider !== "shopify" || connection.status !== "ACTIVE" ||
        current.adapter_key !== "shopify" || current.provider !== "shopify" || current.status !== "ACTIVE" ||
        current.owner_user_id !== connection.owner_user_id ||
        current.external_account_reference !== connection.external_account_reference ||
        current.credential_reference !== connection.credential_reference || !current.external_account_reference) throw reauth();
    const shop = normalizeShopifyShop(current.external_account_reference);
    const record = await findOwnedByProviderExternal(db, current.owner_user_id, "shopify", shop);
    if (!record || record.status !== "CONNECTED" || record.credentialReference !== current.credential_reference) throw reauth();
    requireShopifyScopes(record.scopes);
    return record;
  }

  async function authorization(connection: IntegrationConnectionRow) {
    const record = await activeAccount(connection);
    const stored = await service.credentials.getCredentials({
      adapterKey: "shopify", credentialReference: record.credentialReference, connectionId: connection.id,
    });
    const material = stored?.material;
    if (!material || stored.adapterKey !== "shopify" || stored.credentialReference !== record.credentialReference ||
        material.shop !== record.externalAccountId || !material.accessToken?.trim()) throw reauth();
    if (record.providerMetadata.shopId !== undefined && record.providerMetadata.shopId !== material.shopId) throw reauth();
    requireShopifyScopes(scopesFromMaterial(material));
    // Legacy/custom apps may have a non-expiring token. Never reinterpret a
    // partially saved expiring authorization as non-expiring.
    const expiring = Boolean(material.refreshToken || material.expiresAt || record.expiresAt);
    if (!expiring) return { record, accessToken: material.accessToken, expiresAt: Infinity };
    const storedExpiry = Date.parse(material.expiresAt ?? ""), accountExpiry = Date.parse(record.expiresAt ?? "");
    if (!material.refreshToken?.trim() || !Number.isFinite(storedExpiry) || !Number.isFinite(accountExpiry)) throw reauth();
    return { record, accessToken: material.accessToken, expiresAt: Math.min(storedExpiry, accountExpiry) };
  }

  return async <T>(connection: IntegrationConnectionRow, operation: (accessToken: string) => Promise<T>): Promise<T> => {
    let current = await authorization(connection);
    let refreshed = false;
    async function refresh() {
      await refreshConnectedAccountCredentials(db, clock, current.record.userId, current.record.id, service, {
        preserveCommerceLease: true, expectedAccessToken: current.accessToken,
      });
      refreshed = true;
      current = await authorization(connection);
      if (current.expiresAt <= clock.now().getTime()) throw reauth();
    }
    if (current.expiresAt <= clock.now().getTime() + REFRESH_EARLY_MS) await refresh();
    await syncConnectedShopifyWebhooks(db, clock, service, current.record, current.accessToken);
    let result: T;
    try { result = await operation(current.accessToken); }
    catch (error) {
      if (refreshed || !(error instanceof DomainError) || !["INTEGRATION_NEEDS_REAUTH", "PROVIDER_AUTH_FAILED"].includes(error.code)) throw error;
      await refresh();
      result = await operation(current.accessToken);
    }
    // Disconnect can happen during the provider read; reject its result before
    // allowing another ingestion stage to consume the response.
    await activeAccount(connection);
    return result;
  };
}

function reauth(): DomainError {
  return new DomainError("INTEGRATION_NEEDS_REAUTH", "Reconnect Shopify to verify the shop authorization", 409);
}
