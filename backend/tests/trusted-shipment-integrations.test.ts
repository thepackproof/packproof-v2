import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { hashCanonicalManifest } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import {
  createIntegrationConnection,
  bindTransactionShipmentConnection,
  updateConnectionStatus,
} from "../src/domain/integration-connections.js";
import { getShipmentIntegrity } from "../src/domain/shipment-integrity.js";
import { importNormalizedTransaction } from "../src/domain/transaction-import.js";
import { createTransaction } from "../src/domain/transactions.js";
import { sha256Hex } from "../src/hash.js";
import { SecretsManagerCredentialStore } from "../src/integrations/secrets-manager-credential-store.js";
import { EnvCredentialStore } from "../src/integrations/env-credential-store.js";
import {
  TRUSTED_DEMO_API_KEY,
  TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
  TRUSTED_DEMO_CARRIER_PROVIDER,
  TRUSTED_DEMO_WEBHOOK_SECRET,
  signTrustedDemoWebhook,
} from "../src/integrations/trusted-demo-carrier.js";
import { auth, commitFulfillmentAndAttest, createHarness, login, type TestHarness } from "./helpers.js";

const SAMPLE_IMPORT = {
  provider: "demo-marketplace",
  externalTransactionId: "DM-TRUST-1001",
  transactionDate: "2026-08-20",
  itemTitle: "Vintage film camera",
  itemDescription: "Fully tested body",
  quantity: 1,
  transactionValue: 250.5,
  currency: "USD",
  shipping: {
    carrier: "UPS",
    service: "Ground",
    trackingNumber: "1Z999AA10123456784",
    shipmentDate: "2026-08-21",
  },
  buyer: {
    externalId: "buyer_demo_1",
    displayName: "Alex Buyer",
    email: "alex.buyer@example.com",
  },
  provenance: {
    source: "MARKETPLACE_API" as const,
    sourceRecordId: "demo-order-DM-TRUST-1001",
    importedAt: "2026-08-31T15:00:00.000Z",
  },
};

async function commitSellerEvidence(
  harness: TestHarness,
  seller: string,
  proofId: string,
  bytes: Buffer,
) {
  const upload = await initializeEvidenceUpload(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    { contentType: "video/mp4", idempotencyKey: `trust-${proofId}` },
  );
  await harness.objectStore.put(upload.objectKey, bytes, "video/mp4");
  await commitEvidence(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    upload.evidenceId,
    sha256Hex(bytes),
  );
}

async function finalizeWithBuyer(
  harness: TestHarness,
  seller: string,
  buyer: string,
  proofId: string,
) {
  const invite = await createInvitation(harness.db, harness.clock, seller, proofId, {
    inviteeIdentifier: "buyer@example.com",
  });
  await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.token);
  await commitFulfillmentAndAttest(harness, seller, proofId, {
    bytes: Buffer.from(`trust-evidence-${proofId}`),
    idempotencyKey: `trust-${proofId}`,
  });
  return request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));
}

async function connectTrustedDemo(app: TestHarness["app"], seller: string, transactionId: string) {
  return request(app)
    .post("/dev/integrations/trusted-demo/connect")
    .set(auth(seller))
    .send({ transactionId });
}

function signedWebhook(body: Record<string, unknown>, secret = TRUSTED_DEMO_WEBHOOK_SECRET) {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    raw,
    headers: {
      "x-packproof-webhook-timestamp": timestamp,
      "x-packproof-webhook-signature": signTrustedDemoWebhook(secret, timestamp, raw),
    },
  };
}

describe("trusted shipment integration runtime", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("assigns trusted provenance only through the trusted runtime and ignores client forgery", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "trust-seller");
    const buyer = await login(harness.app, "trust-buyer");
    const imported = await importNormalizedTransaction(
      harness.db,
      harness.clock,
      seller,
      SAMPLE_IMPORT,
      { adapterKey: "demo-marketplace", createProof: true },
    );
    const proofId = imported.proof!.proofId;
    const transactionId = imported.transaction.transactionId;

    const forged = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-events`)
      .set(auth(seller))
      .send({
        eventType: "DELIVERED",
        occurredAt: "2026-09-02T16:16:00.000Z",
        source: "SHIPPING_PROVIDER_API",
        provider: "UPS",
        eventData: { source: "SHIPPING_PROVIDER_API", provider: "UPS" },
      });
    expect(forged.status).toBe(201);
    expect(forged.body.event.source).toBe("PARTICIPANT_SUPPLIED");
    expect(forged.body.event.provider).toBe("participant");
    expect(forged.body.event.eventData.source).toBeUndefined();
    expect(forged.body.event.eventData.provider).toBeUndefined();
    expect(JSON.stringify(forged.body)).not.toContain("SHIPPING_PROVIDER_API");

    const referenceTrusted = await request(harness.app)
      .post("/integrations/shipment-events/import")
      .set(auth(seller))
      .send({
        adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
        mode: "reference",
        transactionId,
      });
    expect(referenceTrusted.status).toBe(403);
    expect(referenceTrusted.body.error.code).toBe("INTEGRATION_TRUST_BOUNDARY");

    const connected = await connectTrustedDemo(harness.app, seller, transactionId);
    expect(connected.status).toBe(201);
    expect(connected.body.connection.adapterKey).toBe(TRUSTED_DEMO_CARRIER_ADAPTER_KEY);
    expect(JSON.stringify(connected.body)).not.toContain(TRUSTED_DEMO_API_KEY);
    expect(JSON.stringify(connected.body)).not.toContain("credentialReference");
    expect(JSON.stringify(connected.body)).not.toContain("credential_reference");

    const synced = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(synced.status).toBe(201);
    expect(synced.body.createdCount).toBe(3);
    expect(synced.body.provider).toBe(TRUSTED_DEMO_CARRIER_PROVIDER);
    expect(synced.body.events.every((event: { source: string }) => event.source === "SHIPPING_PROVIDER_API")).toBe(
      true,
    );
    expect(synced.body.events.every((event: { provider: string }) => event.provider === TRUSTED_DEMO_CARRIER_PROVIDER)).toBe(
      true,
    );
    expect(JSON.stringify(synced.body)).not.toContain(TRUSTED_DEMO_API_KEY);
    expect(JSON.stringify(synced.body)).not.toContain("credential_reference");

    const payloadRejected = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({ source: "SHIPPING_PROVIDER_API", provider: "UPS", events: [] });
    expect(payloadRejected.status).toBe(403);

    const again = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.createdCount).toBe(0);
    expect(again.body.eventCount).toBe(3);

    const finalized = await finalizeWithBuyer(harness, seller, buyer, proofId);
    expect(finalized.status).toBe(200);
    const coreSha = finalized.body.manifest.sha256 as string;
    const coreJson = finalized.body.manifest.canonicalJson as string;
    expect(hashCanonicalManifest(JSON.parse(coreJson)).sha256).toBe(coreSha);

    const webhook = signedWebhook({
      trackingNumber: "1Z999AA10123456784",
      eventId: "trusted-demo-wh-1",
      status: "OUT_FOR_DELIVERY",
      occurredAt: "2026-09-02T12:10:00.000Z",
      location: "Local hub",
    });
    const ingested = await request(harness.app)
      .post(`/integrations/webhooks/${TRUSTED_DEMO_CARRIER_ADAPTER_KEY}`)
      .set(webhook.headers)
      .set("Content-Type", "application/json")
      .send(webhook.raw.toString("utf8"));
    expect(ingested.status).toBe(201);
    expect(ingested.body.createdCount).toBe(1);
    expect(ingested.body.events.some((event: { eventType: string; source: string }) => event.eventType === "OUT_FOR_DELIVERY" && event.source === "SHIPPING_PROVIDER_API")).toBe(
      true,
    );

    const replay = await request(harness.app)
      .post(`/integrations/webhooks/${TRUSTED_DEMO_CARRIER_ADAPTER_KEY}`)
      .set(webhook.headers)
      .set("Content-Type", "application/json")
      .send(webhook.raw.toString("utf8"));
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.createdCount).toBe(0);

    const invalid = signedWebhook(
      {
        trackingNumber: "1Z999AA10123456784",
        eventId: "trusted-demo-wh-2",
        status: "DELIVERED",
        occurredAt: "2026-09-02T16:16:00.000Z",
      },
      "wrong-secret",
    );
    const rejected = await request(harness.app)
      .post(`/integrations/webhooks/${TRUSTED_DEMO_CARRIER_ADAPTER_KEY}`)
      .set(invalid.headers)
      .set("Content-Type", "application/json")
      .send(invalid.raw.toString("utf8"));
    expect(rejected.status).toBe(401);
    expect(rejected.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(JSON.stringify(rejected.body)).not.toContain("wrong-secret");

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10_000);
    const staleBody = Buffer.from(
      JSON.stringify({
        trackingNumber: "1Z999AA10123456784",
        eventId: "trusted-demo-wh-stale",
        status: "DELIVERED",
        occurredAt: "2026-09-02T16:16:00.000Z",
      }),
    );
    const stale = await request(harness.app)
      .post(`/integrations/webhooks/${TRUSTED_DEMO_CARRIER_ADAPTER_KEY}`)
      .set({
        "x-packproof-webhook-timestamp": staleTimestamp,
        "x-packproof-webhook-signature": signTrustedDemoWebhook(
          TRUSTED_DEMO_WEBHOOK_SECRET,
          staleTimestamp,
          staleBody,
        ),
      })
      .set("Content-Type", "application/json")
      .send(staleBody.toString("utf8"));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("WEBHOOK_REPLAY_REJECTED");

    const manifest = await request(harness.app).get(`/proofs/${proofId}/manifest`).set(auth(seller));
    expect(manifest.body.sha256).toBe(coreSha);
    const integrity = await getShipmentIntegrity(harness.db, proofId);
    expect(integrity.verification.valid).toBe(true);
    expect(integrity.coreManifestSha256).toBe(coreSha);

    const proof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(seller));
    expect(proof.body.shipmentSync.available).toBe(true);
    expect(proof.body.shipmentSync.adapterKey).toBe(TRUSTED_DEMO_CARRIER_ADAPTER_KEY);
    expect(JSON.stringify(proof.body)).not.toContain(TRUSTED_DEMO_API_KEY);
    expect(JSON.stringify(proof.body)).not.toContain("credential_reference");
  });

  it("maps connection and provider failures without leaking secrets", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "fail-seller");
    const created = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Failure camera",
      shipping: {
        carrier: "DEMO",
        service: null,
        trackingNumber: "1ZFAIL",
        shipmentDate: null,
      },
    });
    await createOrGetProof(harness.db, harness.clock, seller, created.transactionId);

    const missing = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("INTEGRATION_NOT_FOUND");

    const connection = await createIntegrationConnection(harness.db, harness.clock, seller, {
      adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
      provider: TRUSTED_DEMO_CARRIER_PROVIDER,
      credentialReference: "memory:missing",
    });
    await bindTransactionShipmentConnection(
      harness.db,
      harness.clock,
      seller,
      created.transactionId,
      connection.connectionId,
    );
    const noCreds = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(noCreds.status).toBe(503);
    expect(noCreds.body.error.code).toBe("INTEGRATION_CREDENTIALS_UNAVAILABLE");
    expect(noCreds.body.error.retryable).toBe(true);

    await updateConnectionStatus(harness.db, harness.clock, connection.connectionId, "DISABLED");
    const disabled = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(disabled.status).toBe(409);
    expect(disabled.body.error.code).toBe("INTEGRATION_DISABLED");
    expect(disabled.body.error.retryable).toBe(false);

    await updateConnectionStatus(harness.db, harness.clock, connection.connectionId, "NEEDS_REAUTH");
    const reauth = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(reauth.status).toBe(409);
    expect(reauth.body.error.code).toBe("INTEGRATION_NEEDS_REAUTH");

    await updateConnectionStatus(harness.db, harness.clock, connection.connectionId, "ACTIVE");
    harness.credentialStore.put({
      adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
      credentialReference: "memory:missing",
      material: { apiKey: "invalid" },
    });
    const authFailed = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(authFailed.status).toBe(502);
    expect(authFailed.body.error.code).toBe("PROVIDER_AUTH_FAILED");
    expect(authFailed.body.error.retryable).toBe(false);
    expect(JSON.stringify(authFailed.body)).not.toContain("invalid");

    harness.credentialStore.put({
      adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
      credentialReference: "memory:missing",
      material: { apiKey: "rate-limited" },
    });
    const limited = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("PROVIDER_RATE_LIMITED");
    expect(limited.body.error.retryable).toBe(true);

    harness.credentialStore.put({
      adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
      credentialReference: "memory:missing",
      material: { apiKey: "down" },
    });
    const down = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("PROVIDER_TEMPORARILY_UNAVAILABLE");
    expect(down.body.error.retryable).toBe(true);
  });

  it("handles unknown tracking and invalid provider responses", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "track-seller");
    const unknown = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Unknown",
      shipping: {
        carrier: "DEMO",
        service: null,
        trackingNumber: "UNKNOWN",
        shipmentDate: null,
      },
    });
    await createOrGetProof(harness.db, harness.clock, seller, unknown.transactionId);
    await connectTrustedDemo(harness.app, seller, unknown.transactionId);
    const notFound = await request(harness.app)
      .post(`/transactions/${unknown.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe("TRACKING_NOT_FOUND");

    const invalid = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Invalid",
      shipping: {
        carrier: "DEMO",
        service: null,
        trackingNumber: "INVALID-JSON",
        shipmentDate: null,
      },
    });
    await createOrGetProof(harness.db, harness.clock, seller, invalid.transactionId);
    await connectTrustedDemo(harness.app, seller, invalid.transactionId);
    const bad = await request(harness.app)
      .post(`/transactions/${invalid.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(bad.status).toBe(502);
    expect(bad.body.error.code).toBe("PROVIDER_RESPONSE_INVALID");
  });

  it("rejects treating a reference adapter as trusted", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "ref-as-trusted");
    const created = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Reference as trusted",
      shipping: {
        carrier: "DEMO",
        service: null,
        trackingNumber: "1ZREF",
        shipmentDate: null,
      },
    });
    await createOrGetProof(harness.db, harness.clock, seller, created.transactionId);
    const connection = await createIntegrationConnection(harness.db, harness.clock, seller, {
      adapterKey: "demo-carrier",
      provider: "demo-carrier",
      credentialReference: "memory:demo-carrier",
    });
    await bindTransactionShipmentConnection(
      harness.db,
      harness.clock,
      seller,
      created.transactionId,
      connection.connectionId,
    );
    const rejected = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(rejected.status).toBe(403);
    expect(rejected.body.error.code).toBe("INTEGRATION_TRUST_BOUNDARY");
    expect(rejected.body.error.retryable).toBe(false);
  });
});

describe("credential stores", () => {
  it("reads env credential references without exposing values in errors", async () => {
    const store = new EnvCredentialStore({
      PACKPROOF_TRUSTED_DEMO: JSON.stringify({ apiKey: "env-secret", webhookSecret: "env-hook" }),
    });
    const found = await store.getCredentials({
      adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
      credentialReference: "env:PACKPROOF_TRUSTED_DEMO",
    });
    expect(found?.material.apiKey).toBe("env-secret");
    expect(await store.getCredentials({
      adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
      credentialReference: "memory:nope",
    })).toBeNull();
  });

  it("reads AWS Secrets Manager JSON by credential reference", async () => {
    const store = new SecretsManagerCredentialStore({
      send: async () => ({ SecretString: JSON.stringify({ apiKey: "from-sm" }) }),
    } as never);
    const found = await store.getCredentials({
      adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
      credentialReference: "arn:aws:secretsmanager:us-east-1:123:secret:packproof/v2/integrations/demo",
    });
    expect(found?.material.apiKey).toBe("from-sm");
    expect(
      await store.getCredentials({
        adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
        credentialReference: "memory:local",
      }),
    ).toBeNull();
  });

  it("resolves sm: credential references to secret names", async () => {
    let requested: string | undefined;
    const store = new SecretsManagerCredentialStore({
      send: async (command: { input?: { SecretId?: string } }) => {
        requested = command.input?.SecretId;
        return { SecretString: JSON.stringify({ apiKey: "from-sm" }) };
      },
    } as never);
    const found = await store.getCredentials({
      adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
      credentialReference: "sm:packproof/v2/integrations/demo",
    });
    expect(found?.material.apiKey).toBe("from-sm");
    expect(requested).toBe("packproof/v2/integrations/demo");
  });
});
