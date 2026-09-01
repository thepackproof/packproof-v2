import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import type { EbayRuntime } from "../src/domain/ebay-marketplace.js";
import { createPgliteDatabase } from "../src/db/pglite.js";
import { CompositeCredentialStore } from "../src/integrations/create-credential-store.js";
import { EnvCredentialStore } from "../src/integrations/env-credential-store.js";
import { MemoryCredentialStore } from "../src/integrations/memory-credential-store.js";
import { ebayDeletionChallengeResponse } from "../src/integrations/ebay/account-deletion.js";
import { EBAY_SCOPES, ebayApiBaseUrl, ebayAuthBaseUrl } from "../src/integrations/ebay/constants.js";
import { ebayUserCredentialReference } from "../src/integrations/ebay/credentials.js";
import { SecretsManagerCredentialStore } from "../src/integrations/secrets-manager-credential-store.js";
import { auth, commitProofEvidence, createHarness, login, type TestHarness } from "./helpers.js";
import { InMemorySecretsManagerClient } from "./fakes/in-memory-secrets-manager.js";
import {
  EBAY_FIXTURE_ORDER_ID,
  FakeEbayClient,
} from "./fixtures/ebay.js";

function ebayRuntime(client: FakeEbayClient, enabled = true): EbayRuntime {
  return {
    enabled,
    packproofEnvironment: "test",
    environment: "sandbox",
    clientId: "ebay-app-id",
    ruName: "PackProof-RuName-1",
    marketplaceId: "EBAY_US",
    appCredentialReference: "memory:ebay-app",
    deletionVerificationToken: "deletion-token",
    deletionEndpoint: "https://api.packproof.test/integrations/webhooks/ebay/account-deletion",
    webReturnUrl: "http://127.0.0.1:5173/stores",
    client,
  };
}

async function connectEbay(harness: TestHarness): Promise<string> {
  const userId = await login(harness.app, "seller-1");
  await harness.credentialStore.put({
    adapterKey: "ebay",
    credentialReference: "memory:ebay-app",
    material: { clientSecret: "test-cert-id" },
  });
  const started = await request(harness.app)
    .post("/me/marketplaces/ebay/connect")
    .set(auth(userId));
  expect(started.status).toBe(201);
  const url = new URL(started.body.authorizationUrl);
  const callback = await request(harness.app).get("/integrations/oauth/ebay/callback").query({
    code: "valid-ebay-code",
    state: url.searchParams.get("state"),
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.location).toContain("ebay=connected");
  return userId;
}

describe("eBay configuration", () => {
  it("defaults to disabled sandbox and never copies the cert id onto config", () => {
    const config = loadConfig({
      EBAY_CLIENT_ID: "public-app-id",
      EBAY_CLIENT_SECRET: "super-secret-cert",
      EBAY_RUNAME: "PackProof-RuName-1",
      EBAY_ENVIRONMENT: "sandbox",
    });
    expect(config.ebay).toMatchObject({
      enabled: false,
      environment: "sandbox",
      clientId: "public-app-id",
      ruName: "PackProof-RuName-1",
      appCredentialReference: "env:EBAY_CLIENT_SECRET",
    });
    expect(JSON.stringify(config)).not.toContain("super-secret-cert");
  });

  it("fails closed when enabled without required server credentials and never echoes secrets", () => {
    expect(() =>
      loadConfig({
        PACKPROOF_EBAY_INTEGRATION_ENABLED: "true",
        PACKPROOF_EBAY_CLIENT_ID: "PackProo-PackProo-SBX-example",
        PACKPROOF_EBAY_CLIENT_SECRET: "super-secret-cert",
      }),
    ).toThrow(/PACKPROOF_EBAY_RUNAME/);
    try {
      loadConfig({
        PACKPROOF_EBAY_INTEGRATION_ENABLED: "true",
        PACKPROOF_EBAY_CLIENT_ID: "PackProo-PackProo-SBX-example",
        PACKPROOF_EBAY_CLIENT_SECRET: "super-secret-cert",
      });
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-cert");
    }
    expect(() =>
      loadConfig({
        PACKPROOF_EBAY_INTEGRATION_ENABLED: "true",
        PACKPROOF_EBAY_ENVIRONMENT: "production",
        PACKPROOF_EBAY_CLIENT_ID: "PackProo-PackProo-SBX-example",
        PACKPROOF_EBAY_CLIENT_SECRET: "super-secret-cert",
        PACKPROOF_EBAY_RUNAME: "PackProof-RuName-1",
      }),
    ).toThrow(/Sandbox App ID/);
    const enabled = loadConfig({
      PACKPROOF_EBAY_INTEGRATION_ENABLED: "true",
      PACKPROOF_EBAY_ENVIRONMENT: "sandbox",
      PACKPROOF_EBAY_CLIENT_ID: "PackProo-PackProo-SBX-example",
      PACKPROOF_EBAY_CLIENT_SECRET: "super-secret-cert",
      PACKPROOF_EBAY_RUNAME: "PackProof-RuName-1",
    });
    expect(enabled.ebay.enabled).toBe(true);
    expect(JSON.stringify(enabled)).not.toContain("super-secret-cert");
  });

  it("uses sandbox OAuth and API hosts only for the sandbox environment", () => {
    expect(ebayAuthBaseUrl("sandbox")).toBe("https://auth.sandbox.ebay.com");
    expect(ebayApiBaseUrl("sandbox")).toBe("https://api.sandbox.ebay.com");
    expect(ebayAuthBaseUrl("production")).toBe("https://auth.ebay.com");
    expect(ebayApiBaseUrl("production")).toBe("https://api.ebay.com");
  });
});

describe("eBay seller OAuth and order import", () => {
  let harness: TestHarness;

  afterEach(async () => {
    if (harness) {
      await harness.close();
    }
  });

  it("connects an eBay seller and lists real adapter orders without leaking tokens", async () => {
    const client = new FakeEbayClient();
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await connectEbay(harness);

    const listed = await request(harness.app)
      .get("/me/marketplaces/ebay/orders")
      .set(auth(userId));
    expect(listed.status).toBe(200);
    expect(listed.body.role).toBe("SELLING");
    expect(listed.body.orders[0]).toMatchObject({
      externalOrderId: EBAY_FIXTURE_ORDER_ID,
      title: "Nikon F3 Camera",
      total: 349.99,
      fulfillmentLabel: "Ready to ship",
      proofId: null,
    });
    expect(listed.body.disclosure).toMatch(/does not independently verify/i);
    const serialized = JSON.stringify(listed.body);
    expect(serialized).not.toContain("test-cert-id");
    expect(serialized).not.toContain("access-");
    expect(serialized).not.toContain("refresh-");
    expect(serialized).not.toMatch(/Vintage film camera/i);
    expect(serialized).not.toMatch(/Alex Buyer/i);
  });

  it("imports an eBay order into the canonical transaction and returns the same Proof on retry", async () => {
    const client = new FakeEbayClient();
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await connectEbay(harness);

    const created = await request(harness.app)
      .post(`/me/marketplaces/ebay/orders/${EBAY_FIXTURE_ORDER_ID}/import`)
      .set(auth(userId))
      .send({ createProof: true });
    expect(created.status).toBe(201);
    expect(created.body.transaction.itemTitle).toBe("Nikon F3 Camera");
    expect(created.body.transaction.provenance.provider).toBe("ebay");
    expect(created.body.transaction.provenance.tenantKey).toBe("marketplace:ebay:sandbox");
    expect(created.body.proof.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");
    expect(created.body.proof.status).toBe("READY_FOR_EVIDENCE");
    const metadata = JSON.stringify(created.body.transaction.metadata);
    expect(metadata).toContain(EBAY_FIXTURE_ORDER_ID);
    expect(metadata).toContain("EBAY_US");
    expect(metadata).toContain("\"environment\":\"sandbox\"");
    expect(metadata).not.toContain("contactAddress");
    expect(metadata).not.toContain("taxAddress");

    const retry = await request(harness.app)
      .post(`/me/marketplaces/ebay/orders/${EBAY_FIXTURE_ORDER_ID}/import`)
      .set(auth(userId))
      .send({ createProof: true });
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.proofCreated).toBe(false);
    expect(retry.body.proof.proofId).toBe(created.body.proof.proofId);
    expect(retry.body.transaction.transactionId).toBe(created.body.transaction.transactionId);

    const listedProofs = await request(harness.app).get("/me/proofs").set(auth(userId));
    const ebayProofs = listedProofs.body.proofs.filter(
      (item: { proofId: string }) => item.proofId === created.body.proof.proofId,
    );
    expect(ebayProofs).toHaveLength(1);

    const orders = await request(harness.app)
      .get("/me/marketplaces/ebay/orders")
      .set(auth(userId));
    expect(orders.body.orders[0].proofId).toBe(created.body.proof.proofId);
  });

  it("validates OAuth state and does not put the client secret in the authorize URL", async () => {
    const client = new FakeEbayClient();
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await login(harness.app, "seller-1");
    await harness.credentialStore.put({
      adapterKey: "ebay",
      credentialReference: "memory:ebay-app",
      material: { clientSecret: "test-cert-id" },
    });
    const started = await request(harness.app)
      .post("/me/marketplaces/ebay/connect")
      .set(auth(userId));
    const url = new URL(started.body.authorizationUrl);
    expect(url.origin).toBe("https://auth.sandbox.ebay.com");
    expect(url.searchParams.get("client_id")).toBe("ebay-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe("PackProof-RuName-1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain(EBAY_SCOPES[1]);
    expect(started.body.authorizationUrl).not.toContain("test-cert-id");
    expect(started.body.authorizationUrl).not.toContain("client_secret");

    const reused = await request(harness.app).get("/integrations/oauth/ebay/callback").query({
      code: "valid-ebay-code",
      state: "missing-state",
    });
    expect(reused.status).toBe(302);
    expect(reused.headers.location).toContain("OAUTH_STATE_INVALID");
  });

  it("refreshes an expired access token before listing orders", async () => {
    const client = new FakeEbayClient();
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await connectEbay(harness);
    const status = await request(harness.app).get("/me/marketplaces").set(auth(userId));
    const connectionId = status.body.marketplaces[0].connection.connectionId;
    const credentialReference = ebayUserCredentialReference({
      packproofEnvironment: "test",
      ebayEnvironment: "sandbox",
      connectionId,
    });
    const stored = await harness.credentialStore.getCredentials({
      adapterKey: "ebay",
      credentialReference,
    });
    expect(stored).toBeTruthy();
    expect(stored?.material.accessToken).toBeTruthy();
    expect(JSON.stringify(status.body)).not.toContain(stored!.material.accessToken);
    harness.credentialStore.put({
      adapterKey: "ebay",
      credentialReference,
      material: {
        ...stored!.material,
        accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      },
    });
    const listed = await request(harness.app)
      .get("/me/marketplaces/ebay/orders")
      .set(auth(userId));
    expect(listed.status).toBe(200);
    expect(listed.body.orders).toHaveLength(2);
  });

  it("does not enable eBay routes when the feature flag is off", async () => {
    harness = await createHarness(undefined, { ebay: ebayRuntime(new FakeEbayClient(), false) });
    const userId = await login(harness.app, "seller-1");
    const status = await request(harness.app).get("/me/marketplaces").set(auth(userId));
    expect(status.body.marketplaces[0].enabled).toBe(false);
    const connect = await request(harness.app)
      .post("/me/marketplaces/ebay/connect")
      .set(auth(userId));
    expect(connect.status).toBe(403);
    expect(connect.body.error.code).toBe("EBAY_INTEGRATION_DISABLED");
  });

  it("answers the marketplace deletion challenge and disables the connection without deleting Proofs", async () => {
    const client = new FakeEbayClient();
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await connectEbay(harness);
    const imported = await request(harness.app)
      .post(`/me/marketplaces/ebay/orders/${EBAY_FIXTURE_ORDER_ID}/import`)
      .set(auth(userId))
      .send({ createProof: true });
    const proofId = imported.body.proof.proofId as string;

    const challenge = await request(harness.app)
      .get("/integrations/webhooks/ebay/account-deletion")
      .query({ challenge_code: "challenge-1" });
    expect(challenge.status).toBe(200);
    expect(challenge.body.challengeResponse).toBe(
      ebayDeletionChallengeResponse({
        challengeCode: "challenge-1",
        verificationToken: "deletion-token",
        endpoint: "https://api.packproof.test/integrations/webhooks/ebay/account-deletion",
      }),
    );

    const deleted = await request(harness.app)
      .post("/integrations/webhooks/ebay/account-deletion")
      .set("Content-Type", "application/json")
      .send({
        notification: {
          notificationId: "note-1",
          data: { username: "collin_seller", userId: "ebay-user-001" },
        },
      });
    expect(deleted.status).toBe(200);
    expect(deleted.body.connectionsDisabled).toBe(1);

    const proof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(userId));
    expect(proof.status).toBe(200);
    expect(proof.body.proofId).toBe(proofId);

    const orders = await request(harness.app)
      .get("/me/marketplaces/ebay/orders")
      .set(auth(userId));
    expect(orders.status).toBe(404);
  });

  it("disconnects without deleting imported Proofs and hides the connection", async () => {
    const client = new FakeEbayClient();
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await connectEbay(harness);
    const imported = await request(harness.app)
      .post(`/me/marketplaces/ebay/orders/${EBAY_FIXTURE_ORDER_ID}/import`)
      .set(auth(userId))
      .send({ createProof: true });
    const proofId = imported.body.proof.proofId as string;
    const before = await request(harness.app).get("/me/marketplaces").set(auth(userId));
    const connectionId = before.body.marketplaces[0].connection.connectionId as string;
    const credentialReference = ebayUserCredentialReference({
      packproofEnvironment: "test",
      ebayEnvironment: "sandbox",
      connectionId,
    });
    expect(
      await harness.credentialStore.getCredentials({ adapterKey: "ebay", credentialReference }),
    ).toBeTruthy();

    const disconnected = await request(harness.app)
      .post("/me/marketplaces/ebay/disconnect")
      .set(auth(userId));
    expect(disconnected.status).toBe(204);

    const status = await request(harness.app).get("/me/marketplaces").set(auth(userId));
    expect(status.body.marketplaces[0].connection).toBeNull();
    expect(
      await harness.credentialStore.getCredentials({ adapterKey: "ebay", credentialReference }),
    ).toBeNull();

    const proof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(userId));
    expect(proof.status).toBe(200);
    expect(proof.body.proofId).toBe(proofId);
  });

  it("omits missing eBay fields instead of synthesizing buyer, price, or tracking", async () => {
    const client = new FakeEbayClient();
    client.orders = [
      {
        orderId: "12-00007-84999",
        legacyOrderId: null,
        creationDate: null,
        lastModifiedDate: null,
        orderFulfillmentStatus: null,
        orderPaymentStatus: null,
        sellerId: null,
        cancelState: null,
        buyerUsername: null,
        total: null,
        lineItems: [],
        shippingCarrier: null,
        shippingService: null,
        trackingNumber: null,
      },
    ];
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await connectEbay(harness);
    const imported = await request(harness.app)
      .post("/me/marketplaces/ebay/orders/12-00007-84999/import")
      .set(auth(userId))
      .send({ createProof: true });
    expect(imported.status).toBe(201);
    expect(imported.body.transaction.itemTitle).toBeNull();
    expect(imported.body.transaction.transactionValue).toBeNull();
    expect(imported.body.transaction.currency).toBeNull();
    expect(imported.body.transaction.shipping).toBeNull();
    expect(imported.body.transaction.provenance.buyer).toBeNull();
    expect(imported.body.transaction.itemTitle).not.toBe("Vintage film camera");
  });

  it("commits seller fulfillment capture on an eBay-imported Proof and finalizes once", async () => {
    const client = new FakeEbayClient();
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await connectEbay(harness);
    const created = await request(harness.app)
      .post(`/me/marketplaces/ebay/orders/${EBAY_FIXTURE_ORDER_ID}/import`)
      .set(auth(userId))
      .send({ createProof: true });
    const proofId = created.body.proof.proofId as string;
    await commitProofEvidence(harness, userId, proofId, {
      evidenceType: "FULFILLMENT_CAPTURE",
      contentType: "video/mp4",
    });
    const attested = await request(harness.app)
      .post(`/proofs/${proofId}/attestations`)
      .set(auth(userId))
      .send({ statement: "PACKED_DESCRIBED_ITEM" });
    expect(attested.status).toBe(201);
    const finalized = await request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(userId));
    expect(finalized.status).toBe(200);
    expect(finalized.body.proof.status).toBe("FINALIZED");
    const retry = await request(harness.app)
      .post(`/me/marketplaces/ebay/orders/${EBAY_FIXTURE_ORDER_ID}/import`)
      .set(auth(userId))
      .send({ createProof: true });
    expect(retry.body.proof.proofId).toBe(proofId);
    expect(retry.body.proof.status).toBe("FINALIZED");
  });
});

describe("eBay credential restart persistence", () => {
  it("recovers seller credentials after reconstructing the credential store", async () => {
    const opened = await createPgliteDatabase();
    const secrets = new InMemorySecretsManagerClient();
    const env = new EnvCredentialStore({
      PACKPROOF_EBAY_CLIENT_SECRET: JSON.stringify({ clientSecret: "test-cert-id" }),
    });
    const client = new FakeEbayClient();
    const runtime = ebayRuntime(client);
    runtime.appCredentialReference = "env:PACKPROOF_EBAY_CLIENT_SECRET";

    const firstStore = new CompositeCredentialStore(
      new MemoryCredentialStore(),
      env,
      new SecretsManagerCredentialStore(secrets),
    );
    const first = await createHarness(undefined, {
      opened,
      credentialStore: firstStore,
      ebay: runtime,
    });
    const userId = await connectEbay(first);
    const listed = await request(first.app).get("/me/marketplaces/ebay/orders").set(auth(userId));
    expect(listed.status).toBe(200);
    expect(listed.body.orders[0].title).toBe("Nikon F3 Camera");
    const serialized = JSON.stringify(listed.body);
    expect(serialized).not.toContain("test-cert-id");
    expect(serialized).not.toContain("access-");
    expect(serialized).not.toContain("refresh-");
    await first.close();

    const secondStore = new CompositeCredentialStore(
      new MemoryCredentialStore(),
      env,
      new SecretsManagerCredentialStore(secrets),
    );
    const second = await createHarness(undefined, {
      opened,
      credentialStore: secondStore,
      ebay: runtime,
    });
    const recovered = await request(second.app).get("/me/marketplaces/ebay/orders").set(auth(userId));
    expect(recovered.status).toBe(200);
    expect(recovered.body.orders).toHaveLength(2);
    expect(JSON.stringify(recovered.body)).not.toContain("refresh-");

    const status = await request(second.app).get("/me/marketplaces").set(auth(userId));
    const connectionId = status.body.marketplaces[0].connection.connectionId as string;
    const credentialReference = ebayUserCredentialReference({
      packproofEnvironment: "test",
      ebayEnvironment: "sandbox",
      connectionId,
    });
    const stored = await second.credentialStore.getCredentials({
      adapterKey: "ebay",
      credentialReference,
    });
    expect(stored?.material.refreshToken).toMatch(/^refresh-/);
    await second.credentialStore.put({
      adapterKey: "ebay",
      credentialReference,
      material: {
        ...stored!.material,
        accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      },
    });
    const refreshed = await request(second.app).get("/me/marketplaces/ebay/orders").set(auth(userId));
    expect(refreshed.status).toBe(200);
    await second.close();
    await opened.close();
  });
});
