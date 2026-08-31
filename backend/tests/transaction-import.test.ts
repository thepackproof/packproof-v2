import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { DomainError } from "../src/domain/errors.js";
import { bindProofExternalReference } from "../src/domain/external-references.js";
import { importNormalizedTransaction } from "../src/domain/transaction-import.js";
import { createTransaction } from "../src/domain/transactions.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { hashCanonicalManifest } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { sha256Hex } from "../src/hash.js";
import type { ImportedTransaction } from "../src/domain/imported-transaction.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

const SAMPLE: ImportedTransaction = {
  provider: "demo-marketplace",
  externalTransactionId: "DM-TEST-1001",
  transactionDate: "2026-08-20",
  itemTitle: "Vintage film camera",
  itemDescription: "Fully tested body with original strap",
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
    source: "MARKETPLACE_API",
    sourceRecordId: "demo-order-DM-TEST-1001",
    importedAt: "2026-08-31T15:00:00.000Z",
  },
};

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
  const bytes = Buffer.from(`import-evidence-${proofId}`);
  const upload = await initializeEvidenceUpload(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    { contentType: "video/mp4", idempotencyKey: `import-${proofId}` },
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
  return request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));
}

describe("transaction ingestion from external integrations", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("imports a normalized purchase into the existing transaction model with provenance", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-seller");
    const result = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE, {
      adapterKey: "demo-marketplace",
    });
    expect(result.created).toBe(true);
    expect(result.proof).toBeNull();
    expect(result.transaction.itemTitle).toBe("Vintage film camera");
    expect(result.transaction.itemDescription).toBe("Fully tested body with original strap");
    expect(result.transaction.quantity).toBe(1);
    expect(result.transaction.transactionValue).toBe(250.5);
    expect(result.transaction.currency).toBe("USD");
    expect(result.transaction.transactionDate).toBe("2026-08-20");
    expect(result.transaction.externalReference).toBe("DM-TEST-1001");
    expect(result.transaction.shipping).toEqual({
      carrier: "UPS",
      service: "Ground",
      trackingNumber: "1Z999AA10123456784",
      shipmentDate: "2026-08-21",
    });
    expect(result.transaction.provenance).toMatchObject({
      source: "MARKETPLACE_API",
      adapterKey: "demo-marketplace",
      provider: "demo-marketplace",
      tenantKey: "marketplace:demo-marketplace",
      externalTransactionId: "DM-TEST-1001",
      sourceRecordId: "demo-order-DM-TEST-1001",
      buyer: {
        externalId: "buyer_demo_1",
        displayName: "Alex Buyer",
        email: "alex.buyer@example.com",
      },
    });
    expect(result.transaction.provenance?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.identity.tenantKey).toBe("marketplace:demo-marketplace");
  });

  it("creates or returns the canonical Proof and binds immutable external identity", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-proof-seller");
    const first = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    expect(first.proof?.proofId).toBeTruthy();
    expect(first.transaction.proofId).toBe(first.proof?.proofId);
    expect(first.proof?.status).toBe("OPEN");
    expect(first.proof?.external.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantKey: "packproof:transaction",
          externalTransactionId: "DM-TEST-1001",
          source: "PARTICIPANT_SUPPLIED",
        }),
        expect.objectContaining({
          tenantKey: "marketplace:demo-marketplace",
          externalTransactionId: "DM-TEST-1001",
          source: "INTEGRATION",
        }),
      ]),
    );
    expect(
      first.proof?.external.records.every(
        (record) => record.source === "INTEGRATION" && record.verifiedByPackProof === false,
      ),
    ).toBe(true);
    const events = first.proof?.events.map((event) => event.eventType) ?? [];
    expect(events).toEqual(
      expect.arrayContaining([
        "PROOF_CREATED",
        "TRANSACTION_IMPORTED",
        "SHIPPING_DETAILS_IMPORTED",
        "EXTERNAL_REFERENCE_BOUND",
      ]),
    );
  });

  it("retries the same import idempotently without duplicate transactions, Proofs, or audit noise", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-retry-seller");
    const first = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    const second = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    expect(second.created).toBe(false);
    expect(second.transaction.transactionId).toBe(first.transaction.transactionId);
    expect(second.proof?.proofId).toBe(first.proof?.proofId);
    expect(second.transaction.provenance?.importedAt).toBe(first.transaction.provenance?.importedAt);
    const importedEvents = (second.proof?.events ?? []).filter(
      (event) => event.eventType === "TRANSACTION_IMPORTED",
    );
    expect(importedEvents).toHaveLength(1);
    const boundEvents = (second.proof?.events ?? []).filter(
      (event) => event.eventType === "EXTERNAL_REFERENCE_BOUND",
    );
    expect(boundEvents).toHaveLength(2);
  });

  it("resolves the same provider and external transaction id to the same transaction and Proof", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-same-seller");
    const created = await request(harness.app)
      .post("/integrations/transactions/import")
      .set(auth(seller))
      .send({
        adapterKey: "demo-marketplace",
        externalTransactionId: "DM-API-22",
        createProof: true,
        mode: "reference",
      });
    expect(created.status).toBe(201);
    expect(created.body.transaction.itemTitle).toBe("Vintage film camera");
    expect(created.body.transaction.shipping.trackingNumber).toBe("1Z999AA10123456784");
    expect(created.body.proof.proofId).toBe(created.body.transaction.proofId);

    const retried = await request(harness.app)
      .post("/integrations/transactions/import")
      .set(auth(seller))
      .send({
        adapterKey: "demo-marketplace",
        externalTransactionId: "DM-API-22",
        createProof: true,
      });
    expect(retried.status).toBe(200);
    expect(retried.body.transaction.transactionId).toBe(created.body.transaction.transactionId);
    expect(retried.body.proof.proofId).toBe(created.body.proof.proofId);
  });

  it("fails closed when another seller's Proof already holds the identity", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-conflict-seller");
    const otherSeller = await login(harness.app, "import-conflict-other");
    const other = await createTransaction(harness.db, harness.clock, otherSeller, {
      externalReference: "other-order",
      itemTitle: "Other item",
    });
    const otherProof = await createOrGetProof(
      harness.db,
      harness.clock,
      otherSeller,
      other.transactionId,
    );
    await bindProofExternalReference(harness.db, harness.clock, otherSeller, {
      proofId: otherProof.proofId,
      tenantKey: "marketplace:demo-marketplace",
      externalTransactionId: "DM-CONFLICT-1",
      source: "INTEGRATION",
    });

    await expect(
      importNormalizedTransaction(
        harness.db,
        harness.clock,
        seller,
        { ...SAMPLE, externalTransactionId: "DM-CONFLICT-1" },
        { adapterKey: "demo-marketplace", createProof: true },
      ),
    ).rejects.toMatchObject({
      code: "EXTERNAL_REFERENCE_CONFLICT",
    } satisfies Partial<DomainError>);
  });

  it("does not let another seller claim an existing imported identity", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-owner");
    const stranger = await login(harness.app, "import-stranger");
    await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE, {
      adapterKey: "demo-marketplace",
    });
    await expect(
      importNormalizedTransaction(harness.db, harness.clock, stranger, SAMPLE, {
        adapterKey: "demo-marketplace",
        createProof: true,
      }),
    ).rejects.toMatchObject({
      code: "INTEGRATION_IDENTITY_CONFLICT",
    } satisfies Partial<DomainError>);
  });

  it("rejects imported mutation after finalization and returns the same Proof on identical retry", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-final-seller");
    const buyer = await login(harness.app, "import-final-buyer");
    const imported = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    const proofId = imported.proof!.proofId;
    const finalized = await finalizeWithBuyer(harness, seller, buyer, proofId);
    expect(finalized.status).toBe(200);
    const firstHash = finalized.body.manifest.sha256 as string;

    const same = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    expect(same.proof?.proofId).toBe(proofId);
    expect(same.proof?.status).toBe("FINALIZED");

    await expect(
      importNormalizedTransaction(
        harness.db,
        harness.clock,
        seller,
        { ...SAMPLE, itemTitle: "Mutated after final" },
        { adapterKey: "demo-marketplace", createProof: true },
      ),
    ).rejects.toMatchObject({
      code: "PROOF_ALREADY_FINALIZED",
    } satisfies Partial<DomainError>);

    const again = await request(harness.app)
      .post(`/proofs/${proofId}/finalize`)
      .set(auth(seller));
    expect(again.body.manifest.sha256).toBe(firstHash);
    expect(again.body.manifest.canonicalJson).toBe(finalized.body.manifest.canonicalJson);
    const hashed = hashCanonicalManifest(JSON.parse(again.body.manifest.canonicalJson as string));
    expect(hashed.sha256).toBe(firstHash);
    const manifest = JSON.parse(again.body.manifest.canonicalJson as string) as {
      transaction: { provenance?: { source: string; payloadSha256: string }; itemTitle: string };
      shipping: { trackingNumber: string };
    };
    expect(manifest.transaction.itemTitle).toBe("Vintage film camera");
    expect(manifest.shipping.trackingNumber).toBe("1Z999AA10123456784");
    expect(manifest.transaction.provenance?.source).toBe("MARKETPLACE_API");
    expect(manifest.transaction.provenance?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toMatch(/token|secret|oauth|password/i);
  });

  it("keeps manual transaction creation working beside import", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-manual-seller");
    const manual = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({
        externalReference: "MANUAL-9",
        itemTitle: "Hand entered item",
        quantity: 2,
        shipping: { carrier: "USPS", trackingNumber: "9400" },
      });
    expect(manual.status).toBe(201);
    expect(manual.body.itemTitle).toBe("Hand entered item");
    expect(manual.body.provenance).toBeNull();
    const proof = await request(harness.app)
      .post(`/transactions/${manual.body.transactionId}/proof`)
      .set(auth(seller));
    expect(proof.status).toBe(200);
    expect(proof.body.transaction.itemTitle).toBe("Hand entered item");
    expect(proof.body.external.records[0].source).toBe("PARTICIPANT_SUPPLIED");
  });

  it("does not let an ordinary client impersonate a marketplace payload", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "import-security-seller");
    const spoof = await request(harness.app)
      .post("/integrations/transactions/import")
      .set(auth(seller))
      .send({
        adapterKey: "demo-marketplace",
        provider: "ebay",
        itemTitle: "spoofed",
        ebay_order_id: "not-allowed",
      });
    expect(spoof.status).toBe(400);
    expect(spoof.body.error.code).toBe("INTEGRATION_INPUT_NOT_ALLOWED");

    const unknown = await request(harness.app)
      .post("/integrations/transactions/import")
      .set(auth(seller))
      .send({ adapterKey: "ebay" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("INTEGRATION_ADAPTER_UNAVAILABLE");

    const unauthenticated = await request(harness.app)
      .post("/integrations/transactions/import")
      .send({ adapterKey: "demo-marketplace" });
    expect(unauthenticated.status).toBe(401);
  });
});
