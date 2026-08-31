import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { commitAttestation } from "../src/domain/attestations.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { finalizeProof, hashCanonicalManifest } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { createTransaction } from "../src/domain/transactions.js";
import { sha256Hex } from "../src/hash.js";
import { DEMO_STOREFRONT_CREDENTIAL_REFERENCE } from "../src/integrations/demo-storefront.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

const ELIGIBLE_ORDERS = ["DS-1001", "DS-1002", "DS-1003", "DS-1004", "DS-1009", "DS-1010"];
const INELIGIBLE_ORDERS = ["DS-1005", "DS-1006", "DS-1007", "DS-1008"];

async function connectDemo(
  harness: TestHarness,
  seller: string,
  externalAccountReference?: string,
) {
  return request(harness.app)
    .post("/dev/integrations/demo-storefront/connect")
    .set(auth(seller))
    .send(externalAccountReference ? { externalAccountReference } : {});
}

async function syncConnection(harness: TestHarness, seller: string, connectionId: string) {
  return request(harness.app)
    .post(`/me/commerce-connections/${connectionId}/sync`)
    .set(auth(seller))
    .send({});
}

async function queue(
  harness: TestHarness,
  seller: string,
  filter: "ready" | "completed" | "all" = "ready",
) {
  return request(harness.app).get(`/me/fulfillment-queue?filter=${filter}`).set(auth(seller));
}

describe("automatic fulfillment ingestion", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("connects the reference storefront, syncs deterministically, and is idempotent", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "fulfill-seller");
    const connected = await connectDemo(harness, seller);
    expect(connected.status).toBe(201);
    expect(connected.body.connection.provider).toBe("demo-storefront");
    expect(connected.body.connection.externalAccountReference).toBe("demo-store-001");
    expect(JSON.stringify(connected.body)).not.toContain(DEMO_STOREFRONT_CREDENTIAL_REFERENCE);
    expect(JSON.stringify(connected.body)).not.toMatch(/credential/i);

    const first = await syncConnection(harness, seller, connected.body.connection.connectionId);
    expect(first.status).toBe(200);
    expect(first.body.discoveredCount).toBe(10);
    expect(first.body.eligibleCount).toBe(6);
    expect(first.body.createdTransactionCount).toBe(6);
    expect(first.body.createdProofCount).toBe(6);
    expect(first.body.existingProofCount).toBe(0);
    expect(first.body.ineligibleCount).toBe(4);

    const proofs = await request(harness.app).get("/me/proofs").set(auth(seller));
    expect(proofs.body.proofs).toHaveLength(6);
    for (const item of proofs.body.proofs) {
      expect(item.status).toBe("READY_FOR_EVIDENCE");
    }

    const identities = await harness.db.query<{ external_transaction_id: string }>(
      `SELECT external_transaction_id FROM transaction_integration_identities
        ORDER BY external_transaction_id`,
    );
    expect(identities.rows.map((row) => row.external_transaction_id).sort()).toEqual(
      [...ELIGIBLE_ORDERS].sort(),
    );
    const ineligible = await harness.db.query<{ external_order_id: string; transaction_id: string | null }>(
      `SELECT external_order_id, transaction_id FROM commerce_order_records
        WHERE eligibility = 'INELIGIBLE'`,
    );
    expect(ineligible.rows.map((row) => row.external_order_id).sort()).toEqual(
      [...INELIGIBLE_ORDERS].sort(),
    );
    expect(ineligible.rows.every((row) => row.transaction_id == null)).toBe(true);

    const second = await syncConnection(harness, seller, connected.body.connection.connectionId);
    expect(second.body.discoveredCount).toBe(10);
    expect(second.body.eligibleCount).toBe(6);
    expect(second.body.createdTransactionCount).toBe(0);
    expect(second.body.createdProofCount).toBe(0);
    expect(second.body.existingProofCount).toBe(6);

    const proofCount = await harness.db.query(`SELECT id FROM proofs`);
    expect(proofCount.rows).toHaveLength(6);
    const txnCount = await harness.db.query(`SELECT id FROM transactions`);
    expect(txnCount.rows).toHaveLength(6);
    const imported = await harness.db.query(
      `SELECT id FROM audit_events WHERE event_type = 'TRANSACTION_IMPORTED'`,
    );
    expect(imported.rows).toHaveLength(6);

    const reconnect = await connectDemo(harness, seller);
    expect(reconnect.status).toBe(200);
    expect(reconnect.body.connection.connectionId).toBe(connected.body.connection.connectionId);
  });

  it("scopes the same order id to a stable commerce tenant per store", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "multi-store-seller");
    const a = await connectDemo(harness, seller, "demo-store-001");
    const b = await connectDemo(harness, seller, "demo-store-002");
    await syncConnection(harness, seller, a.body.connection.connectionId);
    await syncConnection(harness, seller, b.body.connection.connectionId);

    const identities = await harness.db.query<{
      tenant_key: string;
      external_transaction_id: string;
      transaction_id: string;
    }>(
      `SELECT tenant_key, external_transaction_id, transaction_id
         FROM transaction_integration_identities
        WHERE external_transaction_id = 'DS-1001'
        ORDER BY tenant_key`,
    );
    expect(identities.rows).toHaveLength(2);
    expect(identities.rows[0].tenant_key).toBe("storefront:demo-storefront:demo-store-001");
    expect(identities.rows[1].tenant_key).toBe("storefront:demo-storefront:demo-store-002");
    expect(identities.rows[0].transaction_id).not.toBe(identities.rows[1].transaction_id);

    await syncConnection(harness, seller, a.body.connection.connectionId);
    const again = await harness.db.query(
      `SELECT id FROM transaction_integration_identities WHERE external_transaction_id = 'DS-1001'`,
    );
    expect(again.rows).toHaveLength(2);
  });

  it("preserves multi-item and quantity facts and keeps merchant Proofs ready without a buyer", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "items-seller");
    const connected = await connectDemo(harness, seller);
    await syncConnection(harness, seller, connected.body.connection.connectionId);
    const listed = await queue(harness, seller, "ready");
    const multi = listed.body.items.find((item: { externalOrderId: string }) => item.externalOrderId === "DS-1003");
    const qty = listed.body.items.find((item: { externalOrderId: string }) => item.externalOrderId === "DS-1004");
    expect(multi.items).toHaveLength(3);
    expect(multi.items.map((item: { title: string }) => item.title)).toEqual([
      "Vintage lens",
      "Camera strap",
      "Lens cap",
    ]);
    expect(qty.items[0].quantity).toBe(4);
    expect(multi.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");
    expect(multi.proofStatus).toBe("READY_FOR_EVIDENCE");

    const proof = await request(harness.app).get(`/proofs/${multi.proofId}`).set(auth(seller));
    expect(proof.body.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");
    expect(proof.body.participants).toHaveLength(1);
    expect(proof.body.participants[0].role).toBe("SELLER");
    expect(proof.body.participants[0].userId).toBe(seller);
    expect(proof.body.transaction.items).toHaveLength(3);
    const imported = proof.body.chronology.find(
      (entry: { title: string }) => entry.title === "Order imported",
    );
    expect(imported?.category).toBe("COMMERCE");
    expect(imported?.description).toBe("Demo Storefront");
    expect(JSON.stringify(proof.body)).not.toMatch(/@example\.com/);
    expect(proof.body.transaction.provenance?.buyer?.email ?? null).toBeNull();
    expect(
      JSON.stringify(proof.body.transaction.metadata?.import?.buyer ?? {}),
    ).not.toContain("email");
  });

  it("lets a seller attest and finalize a merchant Proof without media, and rejects completion before attestation", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "attest-seller");
    const connected = await connectDemo(harness, seller);
    await syncConnection(harness, seller, connected.body.connection.connectionId);
    const listed = await queue(harness, seller);
    const first = listed.body.items[0];
    expect(first.canComplete).toBe(false);
    expect(first.externalOrderId).toBe("DS-1001");

    const premature = await request(harness.app)
      .post(`/proofs/${first.proofId}/finalize`)
      .set(auth(seller));
    expect(premature.status).toBe(422);
    expect(premature.body.error.code).toBe("PROOF_NOT_READY_FOR_FINALIZATION");

    const attested = await request(harness.app)
      .post(`/proofs/${first.proofId}/attestations`)
      .set(auth(seller))
      .send({ statement: "PACKED_DESCRIBED_ITEM" });
    expect(attested.status).toBe(201);
    const retryAttest = await request(harness.app)
      .post(`/proofs/${first.proofId}/attestations`)
      .set(auth(seller))
      .send({ statement: "PACKED_DESCRIBED_ITEM" });
    expect(retryAttest.status).toBe(201);
    expect(retryAttest.body.attestation.attestationId).toBe(attested.body.attestation.attestationId);
    const attestCount = await harness.db.query(
      `SELECT id FROM attestations WHERE proof_id = $1`,
      [first.proofId],
    );
    expect(attestCount.rows).toHaveLength(1);

    const ready = await queue(harness, seller);
    const afterAttest = ready.body.items.find((item: { proofId: string }) => item.proofId === first.proofId);
    expect(afterAttest.canComplete).toBe(true);
    expect(afterAttest.sellerPackingAttested).toBe(true);

    const finalized = await request(harness.app)
      .post(`/proofs/${first.proofId}/finalize`)
      .set(auth(seller));
    expect(finalized.status).toBe(200);
    expect(finalized.body.proof.status).toBe("FINALIZED");
    expect(finalized.body.proof.evidence).toEqual([]);
    const evidenceRows = await harness.db.query(`SELECT id FROM evidence WHERE proof_id = $1`, [
      first.proofId,
    ]);
    expect(evidenceRows.rows).toHaveLength(0);
    expect(finalized.body.manifest.manifest.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");
    expect(finalized.body.manifest.manifest.attestations).toHaveLength(1);
    const again = await request(harness.app).post(`/proofs/${first.proofId}/finalize`).set(auth(seller));
    expect(again.body.manifest.sha256).toBe(finalized.body.manifest.sha256);
    expect(hashCanonicalManifest(finalized.body.manifest.manifest).sha256).toBe(
      finalized.body.manifest.sha256,
    );

    const after = await queue(harness, seller, "ready");
    expect(after.body.items.some((item: { proofId: string }) => item.proofId === first.proofId)).toBe(
      false,
    );
    const completed = await queue(harness, seller, "completed");
    expect(completed.body.items[0].proofId).toBe(first.proofId);
    expect(completed.body.items[0].workflowState).toBe("COMPLETED");
  });

  it("allows optional committed media and rejects uncommitted media on merchant finalization", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "media-seller");
    const connected = await connectDemo(harness, seller);
    await syncConnection(harness, seller, connected.body.connection.connectionId);
    const listed = await queue(harness, seller);
    const order = listed.body.items.find((item: { externalOrderId: string }) => item.externalOrderId === "DS-1002");
    await request(harness.app)
      .post(`/proofs/${order.proofId}/attestations`)
      .set(auth(seller))
      .send({ statement: "PACKED_DESCRIBED_ITEM" });
    const upload = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      order.proofId,
      { contentType: "video/mp4", idempotencyKey: `media-${order.proofId}` },
    );
    const pending = await request(harness.app)
      .post(`/proofs/${order.proofId}/finalize`)
      .set(auth(seller));
    expect(pending.status).toBe(422);
    const bytes = Buffer.from(`merchant-media-${order.proofId}`);
    await harness.objectStore.put(upload.objectKey, bytes, "video/mp4");
    await commitEvidence(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      order.proofId,
      upload.evidenceId,
      sha256Hex(bytes),
    );
    const finalized = await request(harness.app)
      .post(`/proofs/${order.proofId}/finalize`)
      .set(auth(seller));
    expect(finalized.status).toBe(200);
    expect(finalized.body.proof.status).toBe("FINALIZED");
    expect(finalized.body.proof.evidence).toHaveLength(1);
    expect(finalized.body.manifest.manifest.evidence).toHaveLength(1);
  });

  it("promotes a newly eligible order and removes a cancelled order from the ready queue without deleting the Proof", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "state-seller");
    const connected = await connectDemo(harness, seller);
    await syncConnection(harness, seller, connected.body.connection.connectionId);
    const before = await queue(harness, seller);
    expect(before.body.items.map((item: { externalOrderId: string }) => item.externalOrderId)).toEqual(
      ELIGIBLE_ORDERS,
    );
    const cancelledProof = before.body.items.find(
      (item: { externalOrderId: string }) => item.externalOrderId === "DS-1001",
    );

    await request(harness.app)
      .post("/dev/integrations/demo-storefront/simulate")
      .set(auth(seller))
      .send({ scenario: "pending-eligible" });
    await request(harness.app)
      .post("/dev/integrations/demo-storefront/simulate")
      .set(auth(seller))
      .send({ scenario: "cancel-eligible" });
    const changed = await syncConnection(harness, seller, connected.body.connection.connectionId);
    expect(changed.body.createdProofCount).toBe(1);
    expect(changed.body.createdTransactionCount).toBe(1);

    const after = await queue(harness, seller);
    const ids = after.body.items.map((item: { externalOrderId: string }) => item.externalOrderId);
    expect(ids).toContain("DS-1005");
    expect(ids).not.toContain("DS-1001");
    const all = await queue(harness, seller, "all");
    const removed = all.body.items.find(
      (item: { externalOrderId: string }) => item.externalOrderId === "DS-1001",
    );
    expect(removed.workflowState).toBe("REMOVED_FROM_FULFILLMENT");
    const still = await request(harness.app).get(`/proofs/${cancelledProof.proofId}`).set(auth(seller));
    expect(still.status).toBe(200);
    expect(still.body.status).toBe("READY_FOR_EVIDENCE");
  });

  it("keeps the queue seller-scoped and never exposes credentials or trusted client payloads", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "owner-seller");
    const other = await login(harness.app, "other-seller");
    const connected = await connectDemo(harness, seller);
    await syncConnection(harness, seller, connected.body.connection.connectionId);
    const strangerQueue = await queue(harness, other);
    expect(strangerQueue.body.items).toEqual([]);
    const strangerSync = await syncConnection(
      harness,
      other,
      connected.body.connection.connectionId,
    );
    expect(strangerSync.status).toBe(403);

    const listed = await queue(harness, seller);
    expect(JSON.stringify(listed.body)).not.toMatch(/credential/i);
    expect(JSON.stringify(listed.body)).not.toContain(DEMO_STOREFRONT_CREDENTIAL_REFERENCE);

    const forgedImport = await request(harness.app)
      .post("/integrations/transactions/import")
      .set(auth(seller))
      .send({
        adapterKey: "demo-storefront",
        mode: "reference",
        source: "STOREFRONT_API",
        provider: "shopify",
        itemTitle: "Forged",
      });
    expect(forgedImport.status).toBeGreaterThanOrEqual(400);

    const forgedSync = await request(harness.app)
      .post(`/me/commerce-connections/${connected.body.connection.connectionId}/sync`)
      .set(auth(seller))
      .send({ orders: [{ source: "STOREFRONT_API" }] });
    expect(forgedSync.status).toBe(403);
    expect(forgedSync.body.error.code).toBe("INTEGRATION_TRUST_BOUNDARY");

    const connections = await request(harness.app)
      .get("/me/integration-connections?capability=commerce")
      .set(auth(seller));
    expect(connections.body.connections).toHaveLength(1);
    expect(JSON.stringify(connections.body)).not.toMatch(/credential/i);
    expect(connections.body.connections[0].readyOrderCount).toBe(6);
  });

  it("freezes merchant transaction items after finalization and still allows an optional buyer invite", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "freeze-seller");
    const buyer = await login(harness.app, "optional-buyer");
    const connected = await connectDemo(harness, seller);
    await syncConnection(harness, seller, connected.body.connection.connectionId);
    const listed = await queue(harness, seller);
    const multi = listed.body.items.find((item: { externalOrderId: string }) => item.externalOrderId === "DS-1003");
    const invite = await createInvitation(harness.db, harness.clock, seller, multi.proofId, {
      inviteeUserId: buyer,
    });
    expect(invite.proof.status).toBe("READY_FOR_EVIDENCE");
    const accepted = await acceptInvitation(
      harness.db,
      harness.clock,
      buyer,
      invite.invitation.invitationId,
    );
    expect(accepted.proof.participants.some((row) => row.role === "BUYER")).toBe(true);
    expect(accepted.proof.status).toBe("READY_FOR_EVIDENCE");
    await request(harness.app)
      .post(`/proofs/${multi.proofId}/attestations`)
      .set(auth(seller))
      .send({ statement: "PACKED_DESCRIBED_ITEM" });
    const finalized = await request(harness.app)
      .post(`/proofs/${multi.proofId}/finalize`)
      .set(auth(seller));
    expect(finalized.status).toBe(200);
    expect(finalized.body.proof.participants.some((row: { role: string }) => row.role === "BUYER")).toBe(
      true,
    );
    await expect(
      harness.db.query(`DELETE FROM transaction_items WHERE transaction_id = $1`, [
        multi.transactionId,
      ]),
    ).rejects.toThrow(/PROOF_ALREADY_FINALIZED/);
  });

  it("leaves manual P2P participant and finalization rules unchanged", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "p2p-seller");
    const buyer = await login(harness.app, "p2p-buyer");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Manual camera",
      quantity: 1,
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    expect(proof.status).toBe("OPEN");
    expect(proof.participationPolicy).toBe("COUNTERPARTY_REQUIRED");
    const invite = await createInvitation(harness.db, harness.clock, seller, proof.proofId, {
      inviteeUserId: buyer,
    });
    expect(invite.proof.status).toBe("AWAITING_PARTICIPANT");
    await expect(finalizeProof(harness.db, harness.clock, seller, proof.proofId)).rejects.toMatchObject({
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
    });
    await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.invitationId);
    await commitAttestation(harness.db, harness.clock, seller, proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });
    await expect(finalizeProof(harness.db, harness.clock, seller, proof.proofId)).rejects.toMatchObject({
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
    });
    const bytes = Buffer.from(`p2p-${proof.proofId}`);
    const upload = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      { contentType: "video/mp4", idempotencyKey: `p2p-${proof.proofId}` },
    );
    await harness.objectStore.put(upload.objectKey, bytes, "video/mp4");
    await commitEvidence(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      upload.evidenceId,
      sha256Hex(bytes),
    );
    const finalized = await finalizeProof(harness.db, harness.clock, seller, proof.proofId);
    expect(finalized.proof.status).toBe("FINALIZED");
    expect(finalized.manifest.manifest).not.toHaveProperty("participationPolicy");
    expect(txn.items).toHaveLength(1);
    expect(txn.items[0].itemId).toBeNull();
  });
});
