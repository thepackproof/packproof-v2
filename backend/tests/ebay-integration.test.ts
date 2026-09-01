import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import type { EbayRuntime } from "../src/domain/ebay-marketplace.js";
import { ebayDeletionChallengeResponse } from "../src/integrations/ebay/account-deletion.js";
import { EBAY_SCOPES } from "../src/integrations/ebay/constants.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";
import {
  EBAY_FIXTURE_ORDER_ID,
  FakeEbayClient,
} from "./fixtures/ebay.js";

function ebayRuntime(client: FakeEbayClient, enabled = true): EbayRuntime {
  return {
    enabled,
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
  harness.credentialStore.put({
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
});

describe("eBay seller OAuth and order import", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
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
    expect(created.body.proof.proofId).toMatch(/^proof_/);
    const metadata = JSON.stringify(created.body.transaction.metadata);
    expect(metadata).toContain(EBAY_FIXTURE_ORDER_ID);
    expect(metadata).not.toContain("contactAddress");
    expect(metadata).not.toContain("taxAddress");

    const retry = await request(harness.app)
      .post(`/me/marketplaces/ebay/orders/${EBAY_FIXTURE_ORDER_ID}/import`)
      .set(auth(userId))
      .send({ createProof: true });
    expect(retry.status).toBe(200);
    expect(retry.body.proof.proofId).toBe(created.body.proof.proofId);
    expect(retry.body.transaction.transactionId).toBe(created.body.transaction.transactionId);

    const orders = await request(harness.app)
      .get("/me/marketplaces/ebay/orders")
      .set(auth(userId));
    expect(orders.body.orders[0].proofId).toBe(created.body.proof.proofId);
  });

  it("validates OAuth state and does not put the client secret in the authorize URL", async () => {
    const client = new FakeEbayClient();
    harness = await createHarness(undefined, { ebay: ebayRuntime(client) });
    const userId = await login(harness.app, "seller-1");
    harness.credentialStore.put({
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
    const stored = await harness.credentialStore.getCredentials({
      adapterKey: "ebay",
      credentialReference: `memory:ebay:${connectionId}`,
    });
    expect(stored).toBeTruthy();
    harness.credentialStore.put({
      adapterKey: "ebay",
      credentialReference: `memory:ebay:${connectionId}`,
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

    const disconnected = await request(harness.app)
      .post("/me/marketplaces/ebay/disconnect")
      .set(auth(userId));
    expect(disconnected.status).toBe(204);

    const status = await request(harness.app).get("/me/marketplaces").set(auth(userId));
    expect(status.body.marketplaces[0].connection).toBeNull();

    const proof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(userId));
    expect(proof.status).toBe(200);
    expect(proof.body.proofId).toBe(proofId);
  });
});
