import { lockEbayPrivacy } from "./ebay-deletion-cases.js";
import { resumeCommerceAutomation } from "./commerce-automation.js";
import { applyShopifyInitialAutomationConsent, parseShopifyAutomationConsent } from "./shopify-automation-consent.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { appendAccountAudit } from "./account-audit.js";
import {
  findConnectedAccountByExternal,
  findOwnedConnectedAccount,
  listOwnedConnectedAccounts,
  loadConnectedAccount,
  updateConnectedAccount,
  upsertConnectedAccount,
  type ConnectedAccountRecord,
} from "./connected-account-records.js";
import {
  requireConnectedAccountProvider,
  type ConnectedAccountProviderId,
} from "./identity-providers.js";
import { consumeOAuthAttempt, createOAuthAttempt } from "./oauth-attempts.js";
import { connectedAccountReturnUrl, connectSurface } from "./oauth-return.js";
import {
  createIntegrationConnection,
  findOwnerConnection,
  listOwnerConnections,
  updateConnectionCredentials,
  updateConnectionStatus,
} from "./integration-connections.js";
import type { IntegrationCredentialStore, MutableCredentialStore } from "../integrations/credentials.js";
import { connectedAccountCredentialReference, tokenMaterial } from "../integrations/connected-accounts/credentials.js";
import type { ConnectedAccountProviderRegistry } from "../integrations/connected-accounts/registry.js";
import type {
  ConnectedAccountProvider,
  ProviderCapabilities,
} from "../integrations/connected-accounts/types.js";
import { normalizeShopifyShop, shopifyShopHandle } from "../integrations/shopify/shop.js";

export interface ConnectedAccountView {
  id: string;
  provider: ConnectedAccountProviderId | string;
  providerDisplay: string;
  externalAccountId: string;
  externalAccountName: string | null;
  status: string;
  scopes: string[];
  expiresAt: string | null;
  capabilities: ProviderCapabilities;
  limitations: string[];
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string | null;
}

export interface ProviderCatalogView {
  provider: string;
  providerDisplay: string;
  enabled: boolean;
  capabilities: ProviderCapabilities;
  limitations: string[];
  multipleAccounts: boolean;
  requiresShop: boolean;
}

export interface ConnectedAccountService {
  registry: ConnectedAccountProviderRegistry;
  credentials: IntegrationCredentialStore & Partial<Pick<MutableCredentialStore, "put" | "deleteCredentials">>;
  packproofEnvironment: string;
  webReturnUrl: string | null;
  syncShopifyWebhooks?: (input: { shop: string; accessToken: string; scopes: readonly string[] }) => Promise<{ topics: string[]; subscriptionIds: string[] }>;
}

type ConnectExtra = Record<string, unknown>;

export function listProviderCatalog(registry: ConnectedAccountProviderRegistry): ProviderCatalogView[] {
  return registry.list().map((provider) => ({
    provider: provider.provider,
    providerDisplay: provider.displayName,
    enabled: provider.isEnabled(),
    capabilities: provider.capabilities,
    limitations: provider.limitations,
    multipleAccounts: provider.provider === "shopify",
    requiresShop: provider.provider === "shopify",
  }));
}

export async function listConnectedAccounts(
  db: Database,
  userId: string,
  service: ConnectedAccountService,
): Promise<{ accounts: ConnectedAccountView[]; providers: ProviderCatalogView[] }> {
  const records = await listOwnedConnectedAccounts(db, userId);
  const accounts = records.map((record) => toView(record, service.registry.get(record.provider)));
  return { accounts, providers: listProviderCatalog(service.registry) };
}

export async function startConnectedAccountConnect(
  db: Database,
  clock: Clock,
  userId: string,
  providerRaw: string,
  service: ConnectedAccountService,
  extra: ConnectExtra = {},
): Promise<{ authorizationUrl: string; expiresAt: string; provider: string }> {
  const provider = service.registry.get(providerRaw);
  if (!provider.isEnabled()) {
    throw new DomainError(
      "CONNECTED_ACCOUNT_PROVIDER_DISABLED",
      `${provider.displayName} is not enabled`,
      403,
    );
  }
  const metadata = connectMetadata(provider.provider, extra);
  const attempt = await createOAuthAttempt(db, clock, {
    provider: provider.provider,
    purpose: provider.oauthPurpose(),
    userId,
    redirectUri: provider.callbackRedirectUri(),
    metadata,
  });
  const codeVerifier = (await readCodeVerifier(db, attempt.state)) ?? "";
  const started = await provider.getAuthorizationUrl({
    state: attempt.state,
    codeVerifier,
    redirectUri: provider.callbackRedirectUri(),
    extra: metadata,
  });
  return {
    authorizationUrl: started.authorizationUrl,
    expiresAt: attempt.expiresAt,
    provider: provider.provider,
  };
}

export async function reauthorizeConnectedAccount(
  db: Database,
  clock: Clock,
  userId: string,
  accountId: string,
  service: ConnectedAccountService,
  input: { surface?: unknown } = {},
): Promise<{ authorizationUrl: string; expiresAt: string; provider: string }> {
  const record = await requireOwnedAccount(db, userId, accountId);
  const extra: ConnectExtra = { ...record.providerMetadata, reauthorizeAccountId: record.id, surface: connectSurface(input.surface) };
  if (record.provider === "shopify") {
    extra.shop = record.externalAccountId;
  }
  return startConnectedAccountConnect(db, clock, userId, record.provider, service, extra);
}

export async function completeConnectedAccountOAuth(
  db: Database,
  clock: Clock,
  service: ConnectedAccountService,
  providerRaw: string,
  query: Record<string, unknown>,
): Promise<{ redirectTo: string }> {
  if (providerRaw !== "shopify") return completeConnectedAccountOAuthUnlocked(db, clock, service, providerRaw, query);
  let shop: string;
  try { shop = normalizeShopifyShop(query.shop); }
  catch { return completeConnectedAccountOAuthUnlocked(db, clock, service, providerRaw, query); }
  // Shopify token acquisition retires previous refresh tokens. Coordinate it
  // with refresh and disconnect even when this shop has no account row yet.
  return db.transaction(async tx => {
    await lockShopifyAuthorization(tx, shop);
    return completeConnectedAccountOAuthUnlocked(tx, clock, service, providerRaw, query);
  });
}

async function completeConnectedAccountOAuthUnlocked(
  db: Database,
  clock: Clock,
  service: ConnectedAccountService,
  providerRaw: string,
  query: Record<string, unknown>,
): Promise<{ redirectTo: string }> {
  const providerId = requireConnectedAccountProvider(providerRaw);
  const provider = service.registry.get(providerId);
  let returnUrl = service.webReturnUrl || "/account";
  let actorUserId: string | null = null;
  try {
    if (!provider.isEnabled()) {
      throw new DomainError(
        "CONNECTED_ACCOUNT_PROVIDER_DISABLED",
        `${provider.displayName} is not enabled`,
        403,
      );
    }
    await provider.verifyCallback?.(query);
    const attempt = await consumeOAuthAttempt(db, clock, query.state);
    actorUserId = attempt.userId;
    if (attempt.provider !== providerId || attempt.purpose !== provider.oauthPurpose()) {
      throw new DomainError("OAUTH_STATE_INVALID", "OAuth state is invalid", 400);
    }
    if (!attempt.userId) {
      throw new DomainError("UNAUTHENTICATED", "An authenticated PackProof session is required", 401);
    }
    returnUrl = connectedAccountReturnUrl(returnUrl, providerId, attempt.metadata.surface);
    if (typeof query.error === "string" && query.error.trim()) {
      throw new DomainError("CONNECTED_ACCOUNT_AUTH_DENIED", "Account authorization was declined", 400);
    }
    if (typeof query.code !== "string" || !query.code.trim()) {
      throw new DomainError("OAUTH_STATE_INVALID", "OAuth authorization code is missing", 400);
    }
    const extra: ConnectExtra = { ...attempt.metadata };
    if (providerId === "shopify" && normalizeShopifyShop(query.shop) !== normalizeShopifyShop(extra.shop)) {
      throw new DomainError("OAUTH_SHOP_MISMATCH", "Shopify shop does not match the authorization attempt", 400);
    }
    if (providerId === "shopify") {
      const current = await findConnectedAccountByExternal(db, providerId, normalizeShopifyShop(extra.shop));
      // Override any request metadata: only an existing server-owned identity
      // may recover a reconnect whose post-exchange shop lookup is unavailable.
      extra.verifiedShopIdentity = current?.userId === attempt.userId && typeof current.providerMetadata.shopId === "string"
        ? { shopId: current.providerMetadata.shopId, myshopifyDomain: current.externalAccountId, name: current.externalAccountName }
        : null;
      if (current && current.userId !== attempt.userId && current.status !== "DISCONNECTED") {
        // Reject before exchanging: even rejected linkage must not invalidate
        // the tokens used by the shop's existing PackProof owner.
        throw new DomainError("CONNECTED_ACCOUNT_ALREADY_LINKED", "This external account is already connected to another PackProof user", 409);
      }
      if (typeof attempt.metadata.reauthorizeAccountId === "string") {
        const reauthorizing = await requireOwnedAccount(db, attempt.userId, attempt.metadata.reauthorizeAccountId);
        if (reauthorizing.provider !== "shopify" || reauthorizing.externalAccountId !== normalizeShopifyShop(extra.shop)) {
          throw new DomainError("CONNECTED_ACCOUNT_IDENTITY_MISMATCH", "Reconnect the same Shopify shop", 409);
        }
      }
    }
    const { tokens, identity } = await provider.handleCallback({
      code: query.code.trim(),
      codeVerifier: attempt.codeVerifier,
      redirectUri: attempt.redirectUri,
      extra,
    });
    // A reconnect must never replace one shop's credentials with another shop's
    // authorization. Existing commerce identities remain permanently shop-scoped.
    if (providerId === "etsy" && typeof attempt.metadata.reauthorizeAccountId === "string") {
      const reauthorizing = await requireOwnedAccount(db, attempt.userId, attempt.metadata.reauthorizeAccountId);
      if (reauthorizing.provider !== providerId || reauthorizing.externalAccountId !== identity.externalAccountId) {
        throw new DomainError("CONNECTED_ACCOUNT_IDENTITY_MISMATCH", "Reconnect the same Etsy shop, or connect the other shop separately", 409);
      }
    }
    const existingOther = await findConnectedAccountByExternal(db, providerId, identity.externalAccountId);
    if (existingOther && existingOther.userId !== attempt.userId && existingOther.status !== "DISCONNECTED") {
      throw new DomainError(
        "CONNECTED_ACCOUNT_ALREADY_LINKED",
        "This external account is already connected to another PackProof user",
        409,
      );
    }
    const reauthorizeId =
      typeof attempt.metadata.reauthorizeAccountId === "string"
        ? attempt.metadata.reauthorizeAccountId
        : existingOther?.userId === attempt.userId
          ? existingOther.id
          : undefined;
    const accountId = reauthorizeId ?? newId("cac");
    const finalReference = connectedAccountCredentialReference({
      packproofEnvironment: service.packproofEnvironment,
      provider: providerId,
      accountId,
    });
    if (typeof service.credentials.put !== "function") {
      throw new DomainError(
        "INTEGRATION_CREDENTIALS_UNAVAILABLE",
        "Trusted integration credentials are unavailable",
        503,
      );
    }
    await service.credentials.put({
      adapterKey: providerId,
      credentialReference: finalReference,
      material: tokenMaterial(tokens),
    });
    let upserted: Awaited<ReturnType<typeof upsertConnectedAccount>>;
    try {
      upserted = await upsertConnectedAccount(db, clock, {
        id: accountId,
        userId: attempt.userId,
        provider: providerId,
        externalAccountId: identity.externalAccountId,
        externalAccountName: identity.externalAccountName,
        scopes: tokens.scopes,
        credentialReference: finalReference,
        expiresAt: tokens.expiresAt,
        providerMetadata: identity.metadata,
      });
    } catch (error) {
      if (!reauthorizeId && typeof service.credentials.deleteCredentials === "function") {
        await Promise.resolve(
          service.credentials.deleteCredentials({
            adapterKey: providerId,
            credentialReference: finalReference,
          }),
        ).catch(() => undefined);
      }
      throw error;
    }
    const record = upserted.record;
    await syncCommerceConnection(db, clock, record);
    await applyShopifyInitialAutomationConsent(db, clock, record, {
      requested: attempt.metadata.autoSyncEnabled, isNewAccount: upserted.created && !reauthorizeId,
    });
    await syncConnectedShopifyWebhooks(db, clock, service, record, tokens.accessToken);
    const reauthorized = Boolean(reauthorizeId);
    await appendAccountAudit(db, {
      actorUserId: attempt.userId,
      connectedAccountId: record.id,
      eventType: reauthorized ? "CONNECTED_ACCOUNT_REAUTHORIZED" : "CONNECTED_ACCOUNT_LINKED",
      eventData: {
        provider: providerId,
        externalAccountId: record.externalAccountId,
        status: record.status,
      },
      at: clock.now(),
    });
    return { redirectTo: callbackRedirect(returnUrl, providerId, "connected") };
  } catch (error) {
    const code = error instanceof DomainError ? error.code : "CONNECTED_ACCOUNT_AUTH_ERROR";
    await appendAccountAudit(db, {
      actorUserId,
      eventType: "CONNECTED_ACCOUNT_AUTH_ERROR",
      eventData: { provider: providerId, error: code },
      at: clock.now(),
    }).catch(() => undefined);
    return { redirectTo: callbackRedirect(returnUrl, providerId, "error", code) };
  }
}

export async function disconnectConnectedAccount(
  db: Database,
  clock: Clock,
  userId: string,
  accountId: string,
  service: ConnectedAccountService,
): Promise<void> {
  const existing = await requireOwnedAccount(db, userId, accountId);
  if (existing.provider !== "etsy" && existing.provider !== "ebay" && existing.provider !== "shopify") {
    return disconnectConnectedAccountUnlocked(db, clock, userId, accountId, service);
  }
  await db.transaction(async (tx) => {
    if (existing.provider === "ebay") await lockEbayPrivacy(tx);
    if (existing.provider === "shopify") await lockShopifyAuthorization(tx, existing.externalAccountId);
    await tx.query("SELECT id FROM connected_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE", [accountId, userId]);
    await disconnectConnectedAccountUnlocked(tx, clock, userId, accountId, service);
  });
}

async function disconnectConnectedAccountUnlocked(
  db: Database,
  clock: Clock,
  userId: string,
  accountId: string,
  service: ConnectedAccountService,
  options: { skipRemoteRevoke?: boolean } = {},
): Promise<void> {
  const record = await requireOwnedAccount(db, userId, accountId);
  if (record.status === "DISCONNECTED") {
    return;
  }
  const provider = service.registry.get(record.provider);
  const stored = await service.credentials.getCredentials({
    adapterKey: record.provider,
    credentialReference: record.credentialReference,
    connectionId: record.id,
  });
  if (stored && !options.skipRemoteRevoke) {
    await provider.disconnect({ material: stored.material });
  }
  if (typeof service.credentials.deleteCredentials === "function") {
    await service.credentials.deleteCredentials({
      adapterKey: record.provider,
      credentialReference: record.credentialReference,
    });
  }
  await updateConnectedAccount(db, clock, record.id, { status: "DISCONNECTED" });
  await disableCommerceConnection(db, clock, record);
  await appendAccountAudit(db, {
    actorUserId: userId,
    connectedAccountId: record.id,
    eventType: "CONNECTED_ACCOUNT_DISCONNECTED",
    eventData: { provider: record.provider, externalAccountId: record.externalAccountId },
    at: clock.now(),
  });
}

export async function refreshConnectedAccountCredentials(
  db: Database,
  clock: Clock,
  userId: string,
  accountId: string,
  service: ConnectedAccountService,
  options: { preserveCommerceLease?: boolean; expectedAccessToken?: string } = {},
): Promise<ConnectedAccountView> {
  const existing = await requireOwnedAccount(db, userId, accountId);
  if (existing.provider !== "etsy" && existing.provider !== "ebay" && existing.provider !== "shopify") {
    return refreshConnectedAccountCredentialsUnlocked(db, clock, userId, accountId, service, options);
  }
  // The database lock coordinates API and worker processes as well as disconnect.
  // Read credentials only after locking: a preceding refresh may rotate them.
  const outcome = await db.transaction(async (tx) => {
    if (existing.provider === "ebay") await lockEbayPrivacy(tx);
    if (existing.provider === "shopify") await lockShopifyAuthorization(tx, existing.externalAccountId);
    await tx.query("SELECT id FROM connected_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE", [accountId, userId]);
    try {
      return { value: await refreshConnectedAccountCredentialsUnlocked(tx, clock, userId, accountId, service, options) };
    } catch (error) {
      // Auth failures intentionally persist NEEDS_REAUTH before being returned.
      return { error };
    }
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

async function refreshConnectedAccountCredentialsUnlocked(
  db: Database,
  clock: Clock,
  userId: string,
  accountId: string,
  service: ConnectedAccountService,
  options: { preserveCommerceLease?: boolean; expectedAccessToken?: string },
): Promise<ConnectedAccountView> {
  const record = await requireOwnedAccount(db, userId, accountId);
  if (record.status === "DISCONNECTED" || (["etsy", "shopify"].includes(record.provider) && record.status !== "CONNECTED")) {
    throw new DomainError("INTEGRATION_NEEDS_REAUTH", "Reconnect this account to restore authorization", 409);
  }
  const provider = service.registry.get(record.provider);
  const stored = await service.credentials.getCredentials({
    adapterKey: record.provider,
    credentialReference: record.credentialReference,
    connectionId: record.id,
  });
  if (!stored) {
    await updateConnectedAccount(db, clock, record.id, { status: "NEEDS_REAUTH" });
    throw new DomainError("INTEGRATION_NEEDS_REAUTH", "The saved authorization is no longer valid", 409);
  }
  if (["etsy", "shopify"].includes(record.provider) && options.expectedAccessToken !== undefined &&
      stored.material.accessToken !== options.expectedAccessToken) {
    return toView(record, provider);
  }
  try {
    const tokens = await provider.refreshCredentials({ material: stored.material });
    if (typeof service.credentials.put !== "function") {
      throw new DomainError(
        "INTEGRATION_CREDENTIALS_UNAVAILABLE",
        "Trusted integration credentials are unavailable",
        503,
      );
    }
    await service.credentials.put({
      adapterKey: record.provider,
      credentialReference: record.credentialReference,
      material: tokenMaterial(tokens),
    });
    const updated = await updateConnectedAccount(db, clock, record.id, {
      status: "CONNECTED",
      scopes: tokens.scopes.length > 0 ? tokens.scopes : record.scopes,
      expiresAt: tokens.expiresAt,
    });
    await syncCommerceConnection(db,clock,updated,options);
    await syncConnectedShopifyWebhooks(db, clock, service, updated, tokens.accessToken);
    return toView(updated, provider);
  } catch (error) {
    const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
    if(!["PROVIDER_AUTH_FAILED","INTEGRATION_NEEDS_REAUTH"].includes(code)) throw error;
    await updateConnectedAccount(db, clock, record.id, { status: "NEEDS_REAUTH" });
    await appendAccountAudit(db, {
      actorUserId: userId,
      connectedAccountId: record.id,
      eventType: "CONNECTED_ACCOUNT_AUTH_ERROR",
      eventData: {
        provider: record.provider,
        error: error instanceof DomainError ? error.code : "PROVIDER_AUTH_FAILED",
      },
      at: clock.now(),
    });
    throw new DomainError("INTEGRATION_NEEDS_REAUTH", "The saved authorization is no longer valid", 409);
  }
}

async function lockShopifyAuthorization(db: Database, shop: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(1347438150, hashtext($1))", [normalizeShopifyShop(shop)]);
}

/** Webhook setup is recoverable and must not discard a saved authorization. */
export async function syncConnectedShopifyWebhooks(
  db: Database, clock: Clock, service: ConnectedAccountService, record: ConnectedAccountRecord, accessToken: string,
): Promise<void> {
  if (record.provider !== "shopify" || !service.syncShopifyWebhooks) return;
  const lastAttempt = Date.parse(String(record.providerMetadata.webhookRegistrationAttemptedAt ?? ""));
  const providerRetryAt = Date.parse(String(record.providerMetadata.webhookRegistrationRetryAt ?? ""));
  const nextAttemptMs = record.providerMetadata.webhookRegistrationErrorCode ? 5 * 60_000 : 24 * 60 * 60_000;
  if (Number.isFinite(providerRetryAt) && providerRetryAt > clock.now().getTime()) return;
  if (Number.isFinite(lastAttempt) && lastAttempt + nextAttemptMs > clock.now().getTime()) return;
  let metadata: Record<string, unknown>;
  try {
    const result = await service.syncShopifyWebhooks({ shop: record.externalAccountId, accessToken, scopes: record.scopes });
    metadata = { webhookTopics: result.topics, webhookSubscriptionsVerifiedAt: clock.now().toISOString(), webhookRegistrationErrorCode: null, webhookRegistrationRetryAt: null };
  } catch (error) {
    const retryAfterSeconds = error && typeof error === "object" && "retryAfterSeconds" in error ? Number(error.retryAfterSeconds) : 0;
    const retryMs = Number.isFinite(retryAfterSeconds) ? Math.max(5 * 60_000, retryAfterSeconds * 1_000) : 5 * 60_000;
    metadata = {
      webhookRegistrationErrorCode: error instanceof DomainError ? error.code : "SHOPIFY_WEBHOOK_REGISTRATION_FAILED",
      webhookRegistrationRetryAt: new Date(clock.now().getTime() + retryMs).toISOString(),
    };
  }
  // Merge inside SQL so a concurrent metadata update cannot be overwritten.
  await db.query("UPDATE connected_accounts SET provider_metadata = provider_metadata || $2::jsonb, updated_at = $3 WHERE id = $1 AND status = 'CONNECTED'", [
    record.id, JSON.stringify({ ...metadata, webhookRegistrationAttemptedAt: clock.now().toISOString() }), clock.now().toISOString(),
  ]);
}

export async function upsertConnectedAccountFromMarketplace(
  db: Database,
  clock: Clock,
  input: {
    id: string;
    userId: string;
    provider: ConnectedAccountProviderId;
    externalAccountId: string;
    externalAccountName?: string | null;
    credentialReference: string;
    scopes?: string[];
    expiresAt?: string | null;
    providerMetadata?: Record<string, unknown>;
  },
): Promise<ConnectedAccountRecord> {
  const result = await upsertConnectedAccount(db, clock, {
    id: input.id,
    userId: input.userId,
    provider: input.provider,
    externalAccountId: input.externalAccountId,
    externalAccountName: input.externalAccountName,
    credentialReference: input.credentialReference,
    scopes: input.scopes,
    expiresAt: input.expiresAt,
    providerMetadata: input.providerMetadata,
  });
  await appendAccountAudit(db, {
    actorUserId: input.userId,
    connectedAccountId: result.record.id,
    eventType: result.created ? "CONNECTED_ACCOUNT_LINKED" : "CONNECTED_ACCOUNT_REAUTHORIZED",
    eventData: {
      provider: input.provider,
      externalAccountId: input.externalAccountId,
      status: result.record.status,
    },
    at: clock.now(),
  });
  return result.record;
}

export async function markConnectedAccountDisconnected(
  db: Database,
  clock: Clock,
  accountId: string,
  actorUserId: string | null,
): Promise<void> {
  const record = await loadConnectedAccount(db, accountId).catch(() => null);
  if (!record || record.status === "DISCONNECTED") {
    return;
  }
  await updateConnectedAccount(db, clock, accountId, { status: "DISCONNECTED" });
  await appendAccountAudit(db, {
    actorUserId,
    connectedAccountId: accountId,
    eventType: "CONNECTED_ACCOUNT_DISCONNECTED",
    eventData: { provider: record.provider, externalAccountId: record.externalAccountId },
    at: clock.now(),
  });
}

export async function handleShopifyAppUninstalled(
  db: Database,
  clock: Clock,
  shopRaw: string,
  service: ConnectedAccountService,
): Promise<{ accepted: true; disconnected: number }> {
  const shop = normalizeShopifyShop(shopRaw);
  return db.transaction(async tx => {
    await lockShopifyAuthorization(tx, shop);
    const record = await findConnectedAccountByExternal(tx, "shopify", shop);
    if (!record || record.status === "DISCONNECTED") return { accepted: true as const, disconnected: 0 };
    let stored = await service.credentials.getCredentials({ adapterKey: "shopify", credentialReference: record.credentialReference, connectionId: record.id });
    if (stored?.material.accessToken) {
      try {
        if (stored.material.refreshToken && Date.parse(stored.material.expiresAt ?? "") <= clock.now().getTime()) {
          await refreshConnectedAccountCredentialsUnlocked(tx, clock, record.userId, record.id, service, { preserveCommerceLease: true });
          stored = await service.credentials.getCredentials({ adapterKey: "shopify", credentialReference: record.credentialReference, connectionId: record.id });
          if (!stored?.material.accessToken) throw new DomainError("INTEGRATION_NEEDS_REAUTH", "Shopify authorization is unavailable", 409);
        }
        // A delivery from an older installation can arrive after reconnect.
        // Shopify revokes tokens on uninstall, so a working current token proves
        // this notification must not disable the newer installation.
        await service.registry.get("shopify").getAccountIdentity({ accessToken: stored.material.accessToken, extra: { shop } });
        return { accepted: true as const, disconnected: 0 };
      } catch (error) {
        if (!(error instanceof DomainError) || !["PROVIDER_AUTH_FAILED", "INTEGRATION_NEEDS_REAUTH"].includes(error.code)) throw error;
      }
    }
    // An uninstall notification is an observation, never authorization to send
    // another appUninstall mutation against a potentially newer installation.
    await disconnectConnectedAccountUnlocked(tx, clock, record.userId, record.id, service, { skipRemoteRevoke: true });
    return { accepted: true as const, disconnected: 1 };
  });
}

async function syncCommerceConnection(
  db: Database,
  clock: Clock,
  record: ConnectedAccountRecord,
  options: { preserveCommerceLease?: boolean } = {},
): Promise<void> {
  if (record.provider !== "ebay" && record.provider !== "shopify" && record.provider !== "etsy") {
    return;
  }
  const adapterKey = record.provider;
  const externalRef =
    record.provider === "shopify" ? shopifyShopHandle(record.externalAccountId) : record.externalAccountId;
  const existing = await findOwnerConnection(db, record.userId, adapterKey, externalRef);
  if (existing) {
    await updateConnectionCredentials(db, clock, existing.id, {
      credentialReference: record.credentialReference,
      externalAccountReference: externalRef,
      status: "ACTIVE",
    });
    if (!options.preserveCommerceLease) await resumeCommerceAutomation(db, clock, existing.id);
    return;
  }
  await createIntegrationConnection(db, clock, record.userId, {
    connectionId: record.id,
    adapterKey,
    provider: record.provider,
    credentialReference: record.credentialReference,
    externalAccountReference: externalRef,
    status: "ACTIVE",
  });
}

async function disableCommerceConnection(
  db: Database,
  clock: Clock,
  record: ConnectedAccountRecord,
): Promise<void> {
  if (record.provider !== "ebay" && record.provider !== "shopify" && record.provider !== "etsy") {
    return;
  }
  const rows = await listOwnerConnections(db, record.userId, [record.provider]);
  for (const row of rows) {
    if (row.id === record.id || row.credential_reference === record.credentialReference) {
      await updateConnectionStatus(db, clock, row.id, "DISABLED");
    }
  }
}

async function requireOwnedAccount(
  db: Database,
  userId: string,
  accountId: string,
): Promise<ConnectedAccountRecord> {
  const record = await findOwnedConnectedAccount(db, userId, accountId);
  if (!record) {
    throw new DomainError("CONNECTED_ACCOUNT_NOT_FOUND", "No connected account was found", 404);
  }
  return record;
}

function toView(record: ConnectedAccountRecord, provider: ConnectedAccountProvider): ConnectedAccountView {
  return {
    id: record.id,
    provider: record.provider,
    providerDisplay: provider.displayName,
    externalAccountId: record.externalAccountId,
    externalAccountName: record.externalAccountName,
    status: record.status,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    capabilities: provider.capabilities,
    limitations: provider.limitations,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    disconnectedAt: record.disconnectedAt,
  };
}

function connectMetadata(provider: ConnectedAccountProviderId, extra: ConnectExtra): ConnectExtra {
  const metadata = { ...extra, surface: connectSurface(extra.surface) };
  if (provider === "shopify") {
    const shop = normalizeShopifyShop(extra.shop);
    return { ...metadata, shop, autoSyncEnabled: parseShopifyAutomationConsent(extra.autoSyncEnabled) };
  }
  return metadata;
}

function callbackRedirect(
  base: string,
  provider: string,
  status: "connected" | "error",
  code?: string,
): string {
  const url = new URL(base, "http://packproof.local");
  url.searchParams.set("connected", status === "connected" ? provider : "error");
  url.searchParams.set("provider", provider);
  if (status === "error" && code) {
    url.searchParams.set("code", code);
  }
  if (provider === "ebay") {
    url.searchParams.set("ebay", status === "connected" ? "connected" : "error");
    if (status === "error" && code) {
      url.searchParams.set("code", code);
    }
  }
  if (base.startsWith("http://") || base.startsWith("https://") || base.startsWith("packproof-v2://")) {
    return url.toString();
  }
  return `${url.pathname}${url.search}`;
}

async function readCodeVerifier(db: Database, state: string): Promise<string | null> {
  const found = await db.query<{ code_verifier: string | null }>(
    `SELECT code_verifier FROM oauth_authorization_attempts WHERE state = $1`,
    [state],
  );
  return found.rows[0]?.code_verifier ?? null;
}
