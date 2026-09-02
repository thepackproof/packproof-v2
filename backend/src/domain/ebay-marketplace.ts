import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import {
  createIntegrationConnection,
  findConnectionByExternalAccount,
  listOwnerConnections,
  toConnectionView,
  updateConnectionCredentials,
  updateConnectionStatus,
  type IntegrationConnectionRow,
  type IntegrationConnectionView,
} from "./integration-connections.js";
import {
  findProofIdByExternalReference,
  normalizeTenantKey,
} from "./external-references.js";
import { findTransactionIdentity } from "./integration-identities.js";
import { tenantKeyForImport } from "./provenance.js";
import { importNormalizedTransaction, type TransactionImportView } from "./transaction-import.js";
import {
  integrationNeedsReauth,
  integrationNotFound,
} from "./integration-errors.js";
import { createOAuthAttempt, consumeOAuthAttempt } from "./oauth-attempts.js";
import {
  markConnectedAccountDisconnected,
  upsertConnectedAccountFromMarketplace,
} from "./connected-accounts.js";
import type { IntegrationCredentialStore, MutableCredentialStore } from "../integrations/credentials.js";
import { EBAY_ADAPTER_KEY, EBAY_PROVIDER, type EbayEnvironment } from "../integrations/ebay/constants.js";
import { buildEbayAuthorizationUrl } from "../integrations/ebay/oauth.js";
import {
  ebayUserCredentialMaterial,
  ebayUserCredentialReference,
  parseEbayAppSecret,
  parseEbayUserCredentials,
} from "../integrations/ebay/credentials.js";
import { ebayAccountReference, ebayOrderToImportedTransaction, summarizeEbayOrder, type EbayOrderSummary } from "../integrations/ebay/normalize.js";
import type { EbayClient, EbayTokenSet } from "../integrations/ebay/types.js";
import {
  ebayDeletionChallengeResponse,
  parseEbayDeletionNotification,
} from "../integrations/ebay/account-deletion.js";

export interface EbayRuntime {
  enabled: boolean;
  packproofEnvironment: string;
  environment: EbayEnvironment;
  clientId: string | null;
  ruName: string | null;
  marketplaceId: string;
  appCredentialReference: string | null;
  deletionVerificationToken: string | null;
  deletionEndpoint: string | null;
  webReturnUrl: string | null;
  client: EbayClient | null;
}

export interface EbayMarketplaceView {
  provider: "ebay";
  adapterKey: string;
  enabled: boolean;
  environment: EbayEnvironment;
  connection: {
    connectionId: string;
    status: string;
    displayName: string | null;
    connectedAt: string;
    updatedAt: string;
  } | null;
}

export interface EbaySellerOrderView extends EbayOrderSummary {
  proofId: string | null;
  transactionId: string | null;
}

type EbayCredentialStore = IntegrationCredentialStore &
  Partial<Pick<MutableCredentialStore, "put" | "deleteCredentials">>;

function requireEnabled(runtime: EbayRuntime): asserts runtime is EbayRuntime & {
  client: EbayClient;
  clientId: string;
  ruName: string;
  appCredentialReference: string;
} {
  if (!runtime.enabled) {
    throw new DomainError("EBAY_INTEGRATION_DISABLED", "eBay integration is not enabled", 403);
  }
  if (!runtime.client || !runtime.clientId || !runtime.ruName || !runtime.appCredentialReference) {
    throw new DomainError(
      "INTEGRATION_CREDENTIALS_UNAVAILABLE",
      "eBay application credentials are not configured",
      503,
    );
  }
}

export async function getEbayMarketplaceStatus(
  db: Database,
  userId: string,
  runtime: EbayRuntime,
): Promise<EbayMarketplaceView> {
  const connection = runtime.enabled ? await findEbayConnection(db, userId) : null;
  const visible = connection && connection.status !== "DISABLED" ? connection : null;
  return {
    provider: "ebay",
    adapterKey: EBAY_ADAPTER_KEY,
    enabled: runtime.enabled,
    environment: runtime.environment,
    connection: visible
      ? {
          connectionId: visible.id,
          status: visible.status,
          displayName: visible.external_account_reference,
          connectedAt: toConnectionView(visible).createdAt,
          updatedAt: toConnectionView(visible).updatedAt,
        }
      : null,
  };
}

export async function startEbayConnect(
  db: Database,
  clock: Clock,
  userId: string,
  runtime: EbayRuntime,
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  requireEnabled(runtime);
  const attempt = await createOAuthAttempt(db, clock, {
    provider: EBAY_PROVIDER,
    purpose: "marketplace_connect",
    userId,
    redirectUri: runtime.ruName,
  });
  return {
    authorizationUrl: buildEbayAuthorizationUrl({
      environment: runtime.environment,
      clientId: runtime.clientId,
      ruName: runtime.ruName,
      state: attempt.state,
    }),
    expiresAt: attempt.expiresAt,
  };
}

export async function completeEbayOAuth(
  db: Database,
  clock: Clock,
  runtime: EbayRuntime,
  credentials: EbayCredentialStore,
  query: { code?: unknown; state?: unknown; error?: unknown },
): Promise<{ redirectTo: string }> {
  const returnUrl = runtime.webReturnUrl || "/";
  if (typeof query.error === "string" && query.error.trim()) {
    return { redirectTo: withQuery(returnUrl, { ebay: "error", code: query.error.trim() }) };
  }
  try {
    requireEnabled(runtime);
    const attempt = await consumeOAuthAttempt(db, clock, query.state);
    if (attempt.purpose !== "marketplace_connect" || attempt.provider !== EBAY_PROVIDER) {
      throw new DomainError("OAUTH_STATE_INVALID", "OAuth state is invalid", 400);
    }
    if (!attempt.userId) {
      throw new DomainError("UNAUTHENTICATED", "An authenticated PackProof session is required", 401);
    }
    if (typeof query.code !== "string" || !query.code.trim()) {
      throw new DomainError("OAUTH_STATE_INVALID", "OAuth authorization code is missing", 400);
    }
    const appSecret = parseEbayAppSecret(
      await credentials.getCredentials({
        adapterKey: EBAY_ADAPTER_KEY,
        credentialReference: runtime.appCredentialReference,
      }),
    );
    const tokens = await runtime.client.exchangeAuthorizationCode({
      environment: runtime.environment,
      clientId: runtime.clientId,
      clientSecret: appSecret,
      ruName: runtime.ruName,
      code: query.code.trim(),
    });
    const identity = await runtime.client.getUser({
      environment: runtime.environment,
      accessToken: tokens.accessToken,
    });
    const accountRef = ebayAccountReference(identity.userId, identity.username);
    const existingOther = await findConnectionByExternalAccount(db, EBAY_ADAPTER_KEY, accountRef);
    if (existingOther && existingOther.owner_user_id !== attempt.userId) {
      throw new DomainError(
        "MARKETPLACE_ALREADY_CONNECTED",
        "This eBay account is already connected to another PackProof user",
        409,
      );
    }
    const owned = await findEbayConnection(db, attempt.userId);
    const connectionId = owned?.id ?? existingOther?.id ?? newId("icn");
    const credentialReference = ebayUserCredentialReference({
      packproofEnvironment: runtime.packproofEnvironment,
      ebayEnvironment: runtime.environment,
      connectionId,
    });
    if (typeof credentials.put !== "function") {
      throw new DomainError(
        "INTEGRATION_CREDENTIALS_UNAVAILABLE",
        "Trusted integration credentials are unavailable",
        503,
      );
    }
    await credentials.put({
      adapterKey: EBAY_ADAPTER_KEY,
      credentialReference,
      material: ebayUserCredentialMaterial({
        ...tokenExpiry(clock, tokens),
        ebayUserId: identity.userId,
        ebayUsername: identity.username,
        environment: runtime.environment,
      }),
    });
    if (owned) {
      await updateConnectionCredentials(db, clock, owned.id, {
        credentialReference,
        externalAccountReference: accountRef,
        status: "ACTIVE",
      });
    } else {
      await createIntegrationConnection(db, clock, attempt.userId, {
        connectionId,
        adapterKey: EBAY_ADAPTER_KEY,
        provider: EBAY_PROVIDER,
        credentialReference,
        externalAccountReference: accountRef,
        status: "ACTIVE",
      });
    }
    const expiry = tokenExpiry(clock, tokens);
    await upsertConnectedAccountFromMarketplace(db, clock, {
      id: connectionId,
      userId: attempt.userId,
      provider: "ebay",
      externalAccountId: accountRef,
      externalAccountName: identity.username,
      credentialReference,
      scopes: (expiry.scope ?? "").split(/\s+/).filter(Boolean),
      expiresAt: expiry.accessTokenExpiresAt,
      providerMetadata: {
        ebayUserId: identity.userId,
        ebayUsername: identity.username,
        environment: runtime.environment,
      },
    });
    return { redirectTo: withQuery(returnUrl, { ebay: "connected" }) };
  } catch (error) {
    const code = error instanceof DomainError ? error.code : "EBAY_OAUTH_FAILED";
    return { redirectTo: withQuery(returnUrl, { ebay: "error", code }) };
  }
}

export async function listEbaySellerOrders(
  db: Database,
  clock: Clock,
  userId: string,
  runtime: EbayRuntime,
  credentials: EbayCredentialStore,
): Promise<{ orders: EbaySellerOrderView[]; connection: IntegrationConnectionView }> {
  requireEnabled(runtime);
  const connection = await requireEbayConnection(db, userId);
  const orders = await withEbayUserToken(db, clock, runtime, credentials, connection, (accessToken) =>
    runtime.client!.listOrders({
      environment: runtime.environment,
      accessToken,
      marketplaceId: runtime.marketplaceId,
      limit: 50,
      offset: 0,
    }),
  );
  const tenantKey = normalizeTenantKey(
    tenantKeyForImport("ebay", "MARKETPLACE_API", runtime.environment),
  );
  const views: EbaySellerOrderView[] = [];
  for (const order of orders.orders) {
    const identity = await findTransactionIdentity(db, tenantKey, order.orderId);
    const proofId = await findProofIdByExternalReference(db, tenantKey, order.orderId);
    views.push({
      ...summarizeEbayOrder(order),
      transactionId: identity?.transaction_id ?? null,
      proofId: proofId ?? null,
    });
  }
  await updateConnectionCredentials(db, clock, connection.id, { status: connection.status as "ACTIVE" });
  return { orders: views, connection: toConnectionView(connection) };
}

export async function importEbaySellerOrder(
  db: Database,
  clock: Clock,
  userId: string,
  runtime: EbayRuntime,
  credentials: EbayCredentialStore,
  orderIdRaw: string,
  options: { createProof?: boolean } = {},
): Promise<TransactionImportView> {
  requireEnabled(runtime);
  const orderId = orderIdRaw.trim();
  if (!orderId) {
    throw new DomainError("INVALID_IMPORTED_TRANSACTION", "orderId is required", 400);
  }
  const connection = await requireEbayConnection(db, userId);
  const order = await withEbayUserToken(db, clock, runtime, credentials, connection, (accessToken) =>
    runtime.client!.getOrder({
      environment: runtime.environment,
      accessToken,
      marketplaceId: runtime.marketplaceId,
      orderId,
    }),
  );
  return importNormalizedTransaction(
    db,
    clock,
    userId,
    ebayOrderToImportedTransaction({
      order,
      environment: runtime.environment,
      marketplaceId: runtime.marketplaceId,
      importedAt: clock.now().toISOString(),
    }),
    {
      createProof: options.createProof === true,
      adapterKey: EBAY_ADAPTER_KEY,
      participationPolicy: "COUNTERPARTY_OPTIONAL",
    },
  );
}

export async function disconnectEbay(
  db: Database,
  clock: Clock,
  userId: string,
  credentials?: EbayCredentialStore,
): Promise<void> {
  const connection = await findEbayConnection(db, userId);
  if (!connection) {
    throw integrationNotFound();
  }
  if (typeof credentials?.deleteCredentials === "function") {
    await credentials.deleteCredentials({
      adapterKey: EBAY_ADAPTER_KEY,
      credentialReference: connection.credential_reference,
    });
  }
  await updateConnectionStatus(db, clock, connection.id, "DISABLED");
  await markConnectedAccountDisconnected(db, clock, connection.id, userId);
}

export function ebayChallengeResponse(
  runtime: EbayRuntime,
  query: { challenge_code?: unknown; challengeCode?: unknown },
): { challengeResponse: string } {
  if (!runtime.deletionVerificationToken || !runtime.deletionEndpoint) {
    throw new DomainError(
      "INTEGRATION_CREDENTIALS_UNAVAILABLE",
      "eBay marketplace deletion verification is not configured",
      503,
    );
  }
  const challengeCode =
    (typeof query.challenge_code === "string" ? query.challenge_code : null) ??
    (typeof query.challengeCode === "string" ? query.challengeCode : null);
  if (!challengeCode?.trim()) {
    throw new DomainError("INVALID_WEBHOOK", "challenge_code is required", 400);
  }
  return {
    challengeResponse: ebayDeletionChallengeResponse({
      challengeCode: challengeCode.trim(),
      verificationToken: runtime.deletionVerificationToken,
      endpoint: runtime.deletionEndpoint,
    }),
  };
}

export async function handleEbayAccountDeletion(
  db: Database,
  clock: Clock,
  body: unknown,
  credentials?: EbayCredentialStore,
): Promise<{ accepted: true; connectionsDisabled: number }> {
  const parsed = parseEbayDeletionNotification(body);
  const now = clock.now().toISOString();
  try {
    await db.query(
      `INSERT INTO integration_webhook_receipts (
         id, adapter_key, provider_event_id, signature_sha256, received_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [newId("whr"), EBAY_ADAPTER_KEY, parsed.notificationId, "account-deletion", now],
    );
  } catch {
    return { accepted: true, connectionsDisabled: 0 };
  }
  const candidates = [parsed.userId, parsed.username]
    .filter((value): value is string => Boolean(value))
    .map((value) => ebayAccountReference(value, parsed.username));
  let connectionsDisabled = 0;
  for (const account of new Set(candidates)) {
    const connection = await findConnectionByExternalAccount(db, EBAY_ADAPTER_KEY, account);
    if (!connection) {
      continue;
    }
    if (typeof credentials?.deleteCredentials === "function") {
      await credentials.deleteCredentials({
        adapterKey: EBAY_ADAPTER_KEY,
        credentialReference: connection.credential_reference,
      });
    }
    await updateConnectionStatus(db, clock, connection.id, "DISABLED");
    await updateConnectionCredentials(db, clock, connection.id, {
      externalAccountReference: `deleted-${connection.id.slice(-8).toLowerCase()}`,
      status: "DISABLED",
    });
    await markConnectedAccountDisconnected(db, clock, connection.id, connection.owner_user_id);
    connectionsDisabled += 1;
  }
  return { accepted: true, connectionsDisabled };
}

async function findEbayConnection(
  db: Database,
  userId: string,
): Promise<IntegrationConnectionRow | null> {
  const rows = await listOwnerConnections(db, userId, [EBAY_ADAPTER_KEY]);
  return rows.find((row) => row.status !== "DISABLED") ?? rows[0] ?? null;
}

async function requireEbayConnection(
  db: Database,
  userId: string,
): Promise<IntegrationConnectionRow> {
  const connection = await findEbayConnection(db, userId);
  if (!connection) {
    throw integrationNotFound();
  }
  if (connection.status === "DISABLED") {
    throw integrationNotFound();
  }
  if (connection.status === "NEEDS_REAUTH") {
    throw integrationNeedsReauth();
  }
  return connection;
}

async function withEbayUserToken<T>(
  db: Database,
  clock: Clock,
  runtime: EbayRuntime,
  credentials: EbayCredentialStore,
  connection: IntegrationConnectionRow,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  requireEnabled(runtime);
  const stored = parseEbayUserCredentials(
    await credentials.getCredentials({
      adapterKey: EBAY_ADAPTER_KEY,
      credentialReference: connection.credential_reference,
      connectionId: connection.id,
    }),
  );
  if (stored.environment && stored.environment !== runtime.environment) {
    await updateConnectionStatus(db, clock, connection.id, "NEEDS_REAUTH");
    throw integrationNeedsReauth();
  }
  const appSecret = parseEbayAppSecret(
    await credentials.getCredentials({
      adapterKey: EBAY_ADAPTER_KEY,
      credentialReference: runtime.appCredentialReference,
    }),
  );
  const accessToken = await ensureAccessToken(
    clock,
    runtime,
    credentials,
    connection,
    stored,
    appSecret,
  );
  try {
    return await fn(accessToken);
  } catch (error) {
    if (!isAuthFailure(error)) {
      throw error;
    }
    try {
      const refreshed = await runtime.client.refreshUserToken({
        environment: runtime.environment,
        clientId: runtime.clientId,
        clientSecret: appSecret,
        refreshToken: stored.refreshToken,
      });
      await persistUserTokens(clock, credentials, connection, stored, refreshed, runtime.environment);
      return await fn(refreshed.accessToken);
    } catch {
      await updateConnectionStatus(db, clock, connection.id, "NEEDS_REAUTH");
      throw integrationNeedsReauth();
    }
  }
}

async function ensureAccessToken(
  clock: Clock,
  runtime: EbayRuntime,
  credentials: EbayCredentialStore,
  connection: IntegrationConnectionRow,
  stored: ReturnType<typeof parseEbayUserCredentials>,
  appSecret: string,
): Promise<string> {
  const expiresAt = Date.parse(stored.accessTokenExpiresAt);
  const fresh =
    Number.isFinite(expiresAt) && expiresAt > clock.now().getTime() + 60_000 && stored.accessToken;
  if (fresh) {
    return stored.accessToken;
  }
  const refreshed = await runtime.client!.refreshUserToken({
    environment: runtime.environment,
    clientId: runtime.clientId!,
    clientSecret: appSecret,
    refreshToken: stored.refreshToken,
  });
  await persistUserTokens(clock, credentials, connection, stored, refreshed, runtime.environment);
  return refreshed.accessToken;
}

async function persistUserTokens(
  clock: Clock,
  credentials: EbayCredentialStore,
  connection: IntegrationConnectionRow,
  stored: ReturnType<typeof parseEbayUserCredentials>,
  tokens: EbayTokenSet,
  environment: EbayEnvironment,
): Promise<void> {
  if (typeof credentials.put !== "function") {
    throw new DomainError(
      "INTEGRATION_CREDENTIALS_UNAVAILABLE",
      "Trusted integration credentials are unavailable",
      503,
    );
  }
  await credentials.put({
    adapterKey: EBAY_ADAPTER_KEY,
    credentialReference: connection.credential_reference,
    material: ebayUserCredentialMaterial({
      ...tokenExpiry(clock, tokens),
      ebayUserId: stored.ebayUserId,
      ebayUsername: stored.ebayUsername,
      environment,
    }),
  });
}

function tokenExpiry(clock: Clock, tokens: EbayTokenSet): {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  scope: string | null;
} {
  const now = clock.now().getTime();
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    accessTokenExpiresAt: new Date(now + tokens.expiresInSeconds * 1000).toISOString(),
    refreshTokenExpiresAt:
      tokens.refreshTokenExpiresInSeconds != null
        ? new Date(now + tokens.refreshTokenExpiresInSeconds * 1000).toISOString()
        : null,
    scope: tokens.scope,
  };
}

function isAuthFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "PROVIDER_AUTH_FAILED",
  );
}

function withQuery(base: string, query: Record<string, string>): string {
  const url = new URL(base, "http://packproof.local");
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  if (base.startsWith("http://") || base.startsWith("https://")) {
    return url.toString();
  }
  return `${url.pathname}${url.search}`;
}
