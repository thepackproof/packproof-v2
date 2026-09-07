import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDatabase } from "../src/db/pglite.js";
import { migrate } from "../src/db/migrate.js";
import { insertUser } from "../src/domain/users.js";
import { insertConnectedAccount, loadConnectedAccount } from "../src/domain/connected-account-records.js";
import { createIntegrationConnection, loadConnection } from "../src/domain/integration-connections.js";
import { disconnectConnectedAccount, refreshConnectedAccountCredentials, type ConnectedAccountService } from "../src/domain/connected-accounts.js";
import { DomainError } from "../src/domain/errors.js";
import { CompositeCredentialStore } from "../src/integrations/create-credential-store.js";
import { MemoryCredentialStore } from "../src/integrations/memory-credential-store.js";
import { EnvCredentialStore } from "../src/integrations/env-credential-store.js";
import { SecretsManagerCredentialStore } from "../src/integrations/secrets-manager-credential-store.js";
import { ConnectedAccountProviderRegistry } from "../src/integrations/connected-accounts/registry.js";
import { tokenMaterial } from "../src/integrations/connected-accounts/credentials.js";
import type { ConnectedAccountProvider, OAuthTokenSet } from "../src/integrations/connected-accounts/types.js";
import { createEtsyAccessTokenRunner } from "../src/integrations/etsy/access.js";
import { InMemorySecretsManagerClient } from "./fakes/in-memory-secrets-manager.js";

const clock = { now: () => new Date("2026-09-07T12:00:00Z") };
const identity = { adapterKey: "etsy", credentialReference: "packproof/test/integrations/etsy/account-1" };
function tokens(generation = 1, expiresAt = "2026-09-07T13:00:00Z"): OAuthTokenSet {
  return { accessToken: `123.access_${generation}`, refreshToken: `123.refresh_${generation}`, tokenType: "Bearer", expiresAt,
    scopes: ["shops_r", "transactions_r"], extraMaterial: { etsyShopId: "789", etsyUserId: "123", etsyShopName: "TestShop" } };
}

describe("Etsy access token ownership, rotation and disconnect", () => {
  let opened: Awaited<ReturnType<typeof createPgliteDatabase>>;
  let service: ConnectedAccountService;
  let backend: InMemorySecretsManagerClient;
  let provider: ConnectedAccountProvider;
  const makeStore = () => new CompositeCredentialStore(new MemoryCredentialStore(), new EnvCredentialStore({}), new SecretsManagerCredentialStore(backend));
  beforeEach(async () => {
    opened = await createPgliteDatabase();
    await migrate(opened.db);
    await insertUser(opened.db, clock, "seller");
    await insertUser(opened.db, clock, "other");
    backend = new InMemorySecretsManagerClient();
    provider = {
      provider: "etsy", displayName: "Etsy", capabilities: { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: false },
      limitations: [], isEnabled: () => true, oauthPurpose: () => "marketplace_connect", callbackRedirectUri: () => "https://example.test/callback",
      getAuthorizationUrl: vi.fn(), handleCallback: vi.fn(), getAccountIdentity: vi.fn(), disconnect: vi.fn(async () => {}),
      refreshCredentials: vi.fn(async () => tokens(2)),
    };
    service = { registry: new ConnectedAccountProviderRegistry(new Map([["etsy", provider]])), credentials: makeStore(), packproofEnvironment: "test", webReturnUrl: "/stores" };
    await service.credentials.put!({ ...identity, material: tokenMaterial(tokens()) });
    await insertConnectedAccount(opened.db, clock, { id: "account-1", userId: "seller", provider: "etsy", externalAccountId: "789",
      credentialReference: identity.credentialReference, scopes: tokens().scopes, expiresAt: tokens().expiresAt, providerMetadata: { etsyShopId: "789", etsyUserId: "123" } });
    await createIntegrationConnection(opened.db, clock, "seller", { connectionId: "connection-1", adapterKey: "etsy", provider: "etsy",
      credentialReference: identity.credentialReference, externalAccountReference: "789" });
    await opened.db.query(`INSERT INTO commerce_connection_sync_states (connection_id,updated_at,lease_token,lease_expires_at,next_run_at)
      VALUES($1,$2,$3,$4,$5)`, ["connection-1", clock.now().toISOString(), "active-worker-lease", "2026-09-07T12:10:00Z", "2026-09-07T12:15:00Z"]);
  });
  afterEach(async () => { await opened?.close(); });
  const connection = () => loadConnection(opened.db, "connection-1");
  const runner = () => createEtsyAccessTokenRunner(opened.db, clock, service);

  it("passes current credentials to the operation without unnecessary refresh", async () => {
    const operation = vi.fn(async (token: string) => ({ received: token }));
    expect(await runner()(await connection(), operation)).toEqual({ received: "123.access_1" });
    expect(provider.refreshCredentials).not.toHaveBeenCalled();
  });

  it("refreshes expiring authorization while keeping the active commerce lease", async () => {
    await service.credentials.put!({ ...identity, material: tokenMaterial(tokens(1, "2026-09-07T12:00:30Z")) });
    expect(await runner()(await connection(), async token => token)).toBe("123.access_2");
    expect(provider.refreshCredentials).toHaveBeenCalledTimes(1);
    const state = (await opened.db.query("SELECT lease_token,next_run_at FROM commerce_connection_sync_states WHERE connection_id=$1", ["connection-1"])).rows[0];
    expect(state.lease_token).toBe("active-worker-lease");
    expect(new Date(String(state.next_run_at)).toISOString()).toBe("2026-09-07T12:15:00.000Z");
  });

  it("retries an authorization failure once with a refreshed token", async () => {
    const operation = vi.fn(async token => { if (token === "123.access_1") throw new DomainError("INTEGRATION_NEEDS_REAUTH", "expired", 409); return "receipts"; });
    expect(await runner()(await connection(), operation)).toBe("receipts");
    expect(operation.mock.calls.map(call => call[0])).toEqual(["123.access_1", "123.access_2"]);
    expect(provider.refreshCredentials).toHaveBeenCalledTimes(1);
  });

  it("does not retry rate limits or repeat unsuccessful auth refresh loops", async () => {
    const limited = vi.fn(async () => { throw new DomainError("PROVIDER_RATE_LIMITED", "later", 429); });
    await expect(runner()(await connection(), limited)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    expect(provider.refreshCredentials).not.toHaveBeenCalled();
    const denied = vi.fn(async () => { throw new DomainError("INTEGRATION_NEEDS_REAUTH", "denied", 409); });
    await expect(runner()(await connection(), denied)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect(denied).toHaveBeenCalledTimes(2);
    expect(provider.refreshCredentials).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["owner", { owner_user_id: "other" }], ["shop", { external_account_reference: "999" }],
    ["reference", { credential_reference: "memory:other" }], ["inactive connection", { status: "DISABLED" }],
  ])("rejects a mismatched %s before contacting Etsy", async (_name, patch) => {
    const operation = vi.fn();
    await expect(runner()({ ...await connection(), ...patch }, operation)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect(operation).not.toHaveBeenCalled();
    expect(provider.refreshCredentials).not.toHaveBeenCalled();
  });

  it.each([
    ["credential shop", { etsyShopId: "999" }], ["token owner", { accessToken: "999.access" }],
    ["refresh owner", { refreshToken: "999.refresh" }], ["scopes", { scope: "shops_r" }],
    ["missing expiry", { expiresAt: "" }], ["shop user", { etsyUserId: "999" }],
  ])("rejects mismatched %s in saved credentials", async (_name, patch) => {
    await service.credentials.put!({ ...identity, material: { ...tokenMaterial(tokens()), ...patch } });
    const operation = vi.fn();
    await expect(runner()(await connection(), operation)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("rechecks PackProof account status, connected-account scopes and disconnect before intake", async () => {
    const operation = vi.fn();
    await opened.db.query("UPDATE users SET status='DISABLED' WHERE id='seller'");
    await expect(runner()(await connection(), operation)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await opened.db.query("UPDATE users SET status='ACTIVE' WHERE id='seller'");
    await opened.db.query("UPDATE connected_accounts SET scopes='[\"shops_r\"]'::jsonb WHERE id='account-1'");
    await expect(runner()(await connection(), operation)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    await opened.db.query("UPDATE connected_accounts SET status='DISCONNECTED' WHERE id='account-1'");
    await expect(runner()(await connection(), operation)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("serializes two process-style refreshers and reuses the token already rotated", async () => {
    const secondService = { ...service, credentials: makeStore() };
    const options = { preserveCommerceLease: true, expectedAccessToken: "123.access_1" };
    await Promise.all([
      refreshConnectedAccountCredentials(opened.db, clock, "seller", "account-1", service, options),
      refreshConnectedAccountCredentials(opened.db, clock, "seller", "account-1", secondService, options),
    ]);
    expect(provider.refreshCredentials).toHaveBeenCalledTimes(1);
    expect((await service.credentials.getCredentials(identity))?.material.accessToken).toBe("123.access_2");
    expect((await secondService.credentials.getCredentials(identity))?.material.accessToken).toBe("123.access_2");
  });

  it("commits NEEDS_REAUTH on rejected refresh and preserves status on transient failure", async () => {
    vi.mocked(provider.refreshCredentials).mockRejectedValueOnce(new DomainError("PROVIDER_RATE_LIMITED", "later", 429));
    await expect(refreshConnectedAccountCredentials(opened.db, clock, "seller", "account-1", service)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    expect((await loadConnectedAccount(opened.db, "account-1")).status).toBe("CONNECTED");
    vi.mocked(provider.refreshCredentials).mockRejectedValueOnce(new DomainError("INTEGRATION_NEEDS_REAUTH", "expired", 409));
    await expect(refreshConnectedAccountCredentials(opened.db, clock, "seller", "account-1", service)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect((await loadConnectedAccount(opened.db, "account-1")).status).toBe("NEEDS_REAUTH");
  });

  it("disconnects an in-flight refresh without allowing later refresh to revive it", async () => {
    let begin!: () => void;
    const entered = new Promise<void>(resolve => { begin = resolve; });
    let finish!: () => void;
    const release = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(provider.refreshCredentials).mockImplementationOnce(async () => { begin(); await release; return tokens(2); });
    const refreshing = refreshConnectedAccountCredentials(opened.db, clock, "seller", "account-1", service, { preserveCommerceLease: true });
    await entered;
    const disconnecting = disconnectConnectedAccount(opened.db, clock, "seller", "account-1", service);
    finish();
    await Promise.all([refreshing, disconnecting]);
    expect((await loadConnectedAccount(opened.db, "account-1")).status).toBe("DISCONNECTED");
    expect((await connection()).status).toBe("DISABLED");
    expect(await service.credentials.getCredentials(identity)).toBeNull();
    await expect(refreshConnectedAccountCredentials(opened.db, clock, "seller", "account-1", service)).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
    expect(provider.refreshCredentials).toHaveBeenCalledTimes(1);
  });

  it("does not return fetched receipt data if the shop disconnects during the request", async () => {
    await expect(runner()(await connection(), async () => {
      await disconnectConnectedAccount(opened.db, clock, "seller", "account-1", service);
      return "stale receipt data";
    })).rejects.toMatchObject({ code: "INTEGRATION_NEEDS_REAUTH" });
  });
});
