import type { Clock } from "../../clock.js";
import type { Database } from "../../db/database.js";
import { requireActiveAccount } from "../../domain/account-access.js";
import { findOwnedByProviderExternal, type ConnectedAccountRecord } from "../../domain/connected-account-records.js";
import { refreshConnectedAccountCredentials, type ConnectedAccountService } from "../../domain/connected-accounts.js";
import { DomainError } from "../../domain/errors.js";
import { loadConnection, type IntegrationConnectionRow } from "../../domain/integration-connections.js";
import { scopesFromMaterial } from "../connected-accounts/credentials.js";
import { etsyUserIdFromToken } from "./client.js";
import { ETSY_SCOPES } from "./constants.js";
import type { EtsyAccessTokenRunner } from "./commerce-adapter.js";

const REFRESH_EARLY_MS = 60_000;

/** Uses only the latest, owner/shop-bound credentials and retries auth at most once. */
export function createEtsyAccessTokenRunner(
  db: Database,
  clock: Clock,
  service: ConnectedAccountService,
): EtsyAccessTokenRunner {
  async function activeAccount(connection: IntegrationConnectionRow): Promise<ConnectedAccountRecord> {
    const current = await loadConnection(db, connection.id);
    await requireActiveAccount(db, current.owner_user_id);
    if (connection.adapter_key !== "etsy" || connection.provider !== "etsy" || connection.status !== "ACTIVE" ||
        current.adapter_key !== "etsy" || current.provider !== "etsy" || current.status !== "ACTIVE" ||
        current.owner_user_id !== connection.owner_user_id ||
        current.external_account_reference !== connection.external_account_reference ||
        current.credential_reference !== connection.credential_reference ||
        !/^[1-9][0-9]{0,19}$/.test(current.external_account_reference ?? "")) throw reauth();
    const record = await findOwnedByProviderExternal(db, current.owner_user_id, "etsy", current.external_account_reference!);
    if (!record || record.status !== "CONNECTED" || record.credentialReference !== current.credential_reference ||
        !ETSY_SCOPES.every(scope => record.scopes.includes(scope))) throw reauth();
    return record;
  }

  async function authorization(connection: IntegrationConnectionRow) {
    const record = await activeAccount(connection);
    const stored = await service.credentials.getCredentials({
      adapterKey: "etsy", credentialReference: record.credentialReference, connectionId: connection.id,
    });
    const material = stored?.material;
    if (!material || stored.adapterKey !== "etsy" || stored.credentialReference !== record.credentialReference ||
        material.etsyShopId !== record.externalAccountId || !/^[1-9][0-9]{0,19}$/.test(material.etsyUserId ?? "") ||
        etsyUserIdFromToken(material.accessToken) !== material.etsyUserId ||
        etsyUserIdFromToken(material.refreshToken) !== material.etsyUserId ||
        !ETSY_SCOPES.every(scope => scopesFromMaterial(material).includes(scope))) throw reauth();
    if (record.providerMetadata.etsyUserId !== undefined && record.providerMetadata.etsyUserId !== material.etsyUserId) throw reauth();
    const storedExpiry = Date.parse(material.expiresAt ?? "");
    const accountExpiry = Date.parse(record.expiresAt ?? "");
    if (!Number.isFinite(storedExpiry) || !Number.isFinite(accountExpiry)) throw reauth();
    return { record, accessToken: material.accessToken, expiresAt: Math.min(storedExpiry, accountExpiry) };
  }

  return async <T>(connection: IntegrationConnectionRow, operation: (accessToken: string) => Promise<T>): Promise<T> => {
    let current = await authorization(connection);
    let refreshed = false;
    async function refresh() {
      await refreshConnectedAccountCredentials(db, clock, current.record.userId, current.record.id, service, {
        preserveCommerceLease: true,
        expectedAccessToken: current.accessToken,
      });
      refreshed = true;
      current = await authorization(connection);
      if (current.expiresAt <= clock.now().getTime()) throw reauth();
    }
    if (current.expiresAt <= clock.now().getTime() + REFRESH_EARLY_MS) await refresh();
    let result: T;
    try { result = await operation(current.accessToken); }
    catch (error) {
      if (refreshed || !isAuthorizationError(error)) throw error;
      await refresh();
      result = await operation(current.accessToken);
    }
    // A disconnect during a read must not return data for a new ingestion step.
    await activeAccount(connection);
    return result;
  };
}

function isAuthorizationError(error: unknown): boolean {
  return error instanceof DomainError && ["INTEGRATION_NEEDS_REAUTH", "PROVIDER_AUTH_FAILED"].includes(error.code);
}
function reauth(): DomainError {
  return new DomainError("INTEGRATION_NEEDS_REAUTH", "Reconnect Etsy to verify the shop authorization", 409);
}
