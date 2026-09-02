import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { errorCodeFromSql } from "../src/domain/errors.js";
import {
  commitEvidence,
  initializeEvidenceUpload,
} from "../src/domain/evidence.js";
import { hashCanonicalManifest } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { createTransaction } from "../src/domain/transactions.js";
import { sha256Hex } from "../src/hash.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

const DETAILS = {
  externalReference: "ORD-1001",
  transactionDate: "2026-08-20",
  itemTitle: "Vintage camera",
  itemDescription: "Fully tested body",
  quantity: 1,
  transactionValue: 250.5,
  currency: "usd",
};

const SHIPPING = {
  carrier: "UPS",
  service: "Ground",
  trackingNumber: "1Z999AA10123456784",
  shipmentDate: "2026-08-21",
};

interface ManifestPayload {
  transaction: {
    transactionId: string;
    externalReference: string | null;
    transactionDate: string | null;
    itemTitle: string | null;
    itemDescription: string | null;
    quantity: number | null;
    transactionValue: number | null;
    currency: string | null;
  };
  shipping: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    shipmentDate: string | null;
  };
}

describe("transaction and shipping context", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("persists transaction and shipping details for seller and joined buyer", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-1");
    const buyer = await login(harness.app, "buyer-1");

    const created = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ ...DETAILS, shipping: SHIPPING });
    expect(created.status).toBe(201);
    expect(created.body.externalReference).toBe("ORD-1001");
    expect(created.body.transactionDate).toBe("2026-08-20");
    expect(created.body.itemTitle).toBe("Vintage camera");
    expect(created.body.itemDescription).toBe("Fully tested body");
    expect(created.body.quantity).toBe(1);
    expect(created.body.transactionValue).toBe(250.5);
    expect(created.body.currency).toBe("USD");
    expect(created.body.shipping).toEqual(SHIPPING);
    const transactionId = created.body.transactionId as string;

    const sellerRead = await request(harness.app)
      .get(`/transactions/${transactionId}`)
      .set(auth(seller));
    expect(sellerRead.status).toBe(200);
    expect(sellerRead.body.itemTitle).toBe("Vintage camera");
    expect(sellerRead.body.shipping.trackingNumber).toBe(SHIPPING.trackingNumber);

    const proof = await request(harness.app)
      .post(`/transactions/${transactionId}/proof`)
      .set(auth(seller));
    expect(proof.status).toBe(200);
    const proofId = proof.body.proofId as string;
    expect(proof.body.transaction.itemTitle).toBe("Vintage camera");
    expect(proof.body.transaction.shipping.trackingNumber).toBe(SHIPPING.trackingNumber);

    const again = await request(harness.app)
      .post(`/transactions/${transactionId}/proof`)
      .set(auth(seller));
    expect(again.body.proofId).toBe(proofId);

    const invite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeIdentifier: "buyer@example.com" });
    await request(harness.app)
      .post(`/invitations/${invite.body.invitation.token}/accept`)
      .set(auth(buyer));

    const buyerTxn = await request(harness.app)
      .get(`/transactions/${transactionId}`)
      .set(auth(buyer));
    const buyerProof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(buyer));
    expect(buyerTxn.status).toBe(200);
    expect(buyerProof.status).toBe(200);
    expect(buyerTxn.body.itemTitle).toBe(sellerRead.body.itemTitle);
    expect(buyerTxn.body.shipping).toEqual(sellerRead.body.shipping);
    expect(buyerTxn.body.transactionValue).toBe(sellerRead.body.transactionValue);
    expect(buyerProof.body.transaction.itemDescription).toBe("Fully tested body");
    expect(buyerProof.body.transaction.shipping.carrier).toBe("UPS");
    expect(buyerTxn.body.sellerUserId).toBe(seller);
    expect(buyerTxn.body.buyerUserId).toBe(buyer);
    expect(buyerTxn.body.proofId).toBe(proofId);
    expect(buyerTxn.body.proofStatus).toBe("READY_FOR_EVIDENCE");
  });

  it("updates transaction and shipping before finalization and writes audit events", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-1");
    const buyer = await login(harness.app, "buyer-1");
    const created = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ ...DETAILS, shipping: SHIPPING });
    const transactionId = created.body.transactionId as string;
    const proofId = (
      await request(harness.app).post(`/transactions/${transactionId}/proof`).set(auth(seller))
    ).body.proofId as string;
    const invite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeIdentifier: "buyer@example.com" });
    await request(harness.app)
      .post(`/invitations/${invite.body.invitation.token}/accept`)
      .set(auth(buyer));

    const txnPatch = await request(harness.app)
      .patch(`/transactions/${transactionId}`)
      .set(auth(seller))
      .send({ itemTitle: "Updated camera", quantity: 2 });
    expect(txnPatch.status).toBe(200);
    expect(txnPatch.body.itemTitle).toBe("Updated camera");
    expect(txnPatch.body.quantity).toBe(2);
    expect(txnPatch.body.itemDescription).toBe("Fully tested body");

    const shipPatch = await request(harness.app)
      .patch(`/transactions/${transactionId}/shipping`)
      .set(auth(seller))
      .send({ trackingNumber: "1ZUPDATED", carrier: "USPS" });
    expect(shipPatch.status).toBe(200);
    expect(shipPatch.body.shipping.trackingNumber).toBe("1ZUPDATED");
    expect(shipPatch.body.shipping.carrier).toBe("USPS");
    expect(shipPatch.body.shipping.service).toBe("Ground");

    const buyerRead = await request(harness.app)
      .get(`/transactions/${transactionId}`)
      .set(auth(buyer));
    expect(buyerRead.body.itemTitle).toBe("Updated camera");
    expect(buyerRead.body.shipping.trackingNumber).toBe("1ZUPDATED");

    const buyerPatch = await request(harness.app)
      .patch(`/transactions/${transactionId}`)
      .set(auth(buyer))
      .send({ itemTitle: "buyer rewrite" });
    expect(buyerPatch.status).toBe(403);

    const audit = await harness.db.query<{ event_type: string; event_data: unknown }>(
      `SELECT event_type, event_data FROM audit_events WHERE proof_id = $1 ORDER BY created_at ASC`,
      [proofId],
    );
    const types = audit.rows.map((row) => row.event_type);
    expect(types).toEqual(
      expect.arrayContaining(["TRANSACTION_DETAILS_UPDATED", "SHIPPING_DETAILS_UPDATED"]),
    );
    const txnAudit = audit.rows.find((row) => row.event_type === "TRANSACTION_DETAILS_UPDATED");
    const shipAudit = audit.rows.find((row) => row.event_type === "SHIPPING_DETAILS_UPDATED");
    expect(txnAudit?.event_data).toMatchObject({
      transactionId,
      changed: {
        itemTitle: { from: "Vintage camera", to: "Updated camera" },
        quantity: { from: 1, to: 2 },
      },
    });
    expect(shipAudit?.event_data).toMatchObject({
      transactionId,
      changed: {
        trackingNumber: { from: SHIPPING.trackingNumber, to: "1ZUPDATED" },
        carrier: { from: "UPS", to: "USPS" },
      },
    });
  });

  it("rejects invalid transaction and shipping data", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-1");
    const created = await request(harness.app).post("/transactions").set(auth(seller)).send({});
    const transactionId = created.body.transactionId as string;

    const emptyTitle = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ itemTitle: "   " });
    expect(emptyTitle.status).toBe(201);
    expect(emptyTitle.body.itemTitle).toBeNull();

    const cases = [
      { quantity: 0 },
      { quantity: -1 },
      { quantity: 1.5 },
      { transactionValue: -1 },
      { currency: "US" },
      { currency: "US DOLLAR" },
      { transactionDate: "2026-13-01" },
      { transactionDate: "not-a-date" },
    ];
    for (const body of cases) {
      const response = await request(harness.app)
        .patch(`/transactions/${transactionId}`)
        .set(auth(seller))
        .send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe("INVALID_TRANSACTION_DETAILS");
    }

    const badShipping = await request(harness.app)
      .patch(`/transactions/${transactionId}/shipping`)
      .set(auth(seller))
      .send({ shipmentDate: "2026-99-01" });
    expect(badShipping.status).toBe(400);
    expect(badShipping.body.error.code).toBe("INVALID_SHIPPING_DETAILS");
  });

  it("freezes transaction and shipping in the finalized manifest and rejects later mutation", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-1");
    const buyer = await login(harness.app, "buyer-1");
    const created = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ ...DETAILS, shipping: SHIPPING });
    const transactionId = created.body.transactionId as string;
    const proofId = (
      await request(harness.app).post(`/transactions/${transactionId}/proof`).set(auth(seller))
    ).body.proofId as string;

    const duplicateInsert = harness.db.query(
      `INSERT INTO proofs (id, transaction_id, status, created_at, updated_at, version)
       VALUES ($1, $2, 'OPEN', $3, $3, 1)`,
      ["proof_duplicate", transactionId, harness.clock.now().toISOString()],
    );
    await expect(duplicateInsert).rejects.toSatisfy((error: unknown) => {
      return (
        String((error as { code?: string }).code ?? "") === "23505" ||
        /unique|duplicate/i.test(error instanceof Error ? error.message : String(error))
      );
    });

    const invite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeIdentifier: "buyer@example.com" });
    await request(harness.app)
      .post(`/invitations/${invite.body.invitation.token}/accept`)
      .set(auth(buyer));

    const bytes = Buffer.from("txn-shipping-evidence");
    const upload = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/uploads`)
      .set(auth(seller))
      .set("Idempotency-Key", "seller-capture-1")
      .send({ contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE" });
    const uploadUrl = new URL(upload.body.upload.url as string);
    await request(harness.app).put(uploadUrl.pathname).set("Content-Type", "video/mp4").send(bytes);
    await request(harness.app)
      .post(`/proofs/${proofId}/evidence/${upload.body.evidenceId}/commit`)
      .set(auth(seller))
      .send({ sha256: sha256Hex(bytes) });
    await request(harness.app)
      .post(`/proofs/${proofId}/attestations`)
      .set(auth(seller))
      .send({ statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: upload.body.evidenceId });

    const finalized1 = await request(harness.app)
      .post(`/proofs/${proofId}/finalize`)
      .set(auth(seller));
    const finalized2 = await request(harness.app)
      .post(`/proofs/${proofId}/finalize`)
      .set(auth(seller));
    expect(finalized1.status).toBe(200);
    expect(finalized2.body.manifest.sha256).toBe(finalized1.body.manifest.sha256);
    expect(finalized2.body.manifest.canonicalJson).toBe(finalized1.body.manifest.canonicalJson);

    const sellerManifest = await request(harness.app)
      .get(`/proofs/${proofId}/manifest`)
      .set(auth(seller));
    const buyerManifest = await request(harness.app)
      .get(`/proofs/${proofId}/manifest`)
      .set(auth(buyer));
    expect(sellerManifest.status).toBe(200);
    expect(buyerManifest.body.sha256).toBe(sellerManifest.body.sha256);
    expect(buyerManifest.body.canonicalJson).toBe(sellerManifest.body.canonicalJson);

    const manifest = sellerManifest.body.manifest as ManifestPayload;
    expect(manifest.transaction).toMatchObject({
      transactionId,
      externalReference: "ORD-1001",
      transactionDate: "2026-08-20",
      itemTitle: "Vintage camera",
      itemDescription: "Fully tested body",
      quantity: 1,
      transactionValue: 250.5,
      currency: "USD",
    });
    expect(manifest.shipping).toEqual(SHIPPING);

    const hashed = hashCanonicalManifest(sellerManifest.body.manifest);
    expect(hashed.sha256).toBe(sellerManifest.body.sha256);
    expect(hashed.canonicalJson).toBe(sellerManifest.body.canonicalJson);

    const txnAfter = await request(harness.app)
      .patch(`/transactions/${transactionId}`)
      .set(auth(seller))
      .send({ itemTitle: "should not stick" });
    expect(txnAfter.status).toBe(409);
    expect(txnAfter.body.error.code).toBe("PROOF_ALREADY_FINALIZED");

    const shipAfter = await request(harness.app)
      .patch(`/transactions/${transactionId}/shipping`)
      .set(auth(seller))
      .send({ trackingNumber: "NOPE" });
    expect(shipAfter.status).toBe(409);
    expect(shipAfter.body.error.code).toBe("PROOF_ALREADY_FINALIZED");

    const sqlTxn = harness.db.query(`UPDATE transactions SET item_title = $2 WHERE id = $1`, [
      transactionId,
      "sql rewrite",
    ]);
    await expect(sqlTxn).rejects.toSatisfy((error: unknown) => {
      return errorCodeFromSql(error) === "PROOF_ALREADY_FINALIZED";
    });

    const sqlShip = harness.db.query(
      `UPDATE transaction_shipping SET tracking_number = $2 WHERE transaction_id = $1`,
      [transactionId, "sql-tracking"],
    );
    await expect(sqlShip).rejects.toSatisfy((error: unknown) => {
      return errorCodeFromSql(error) === "PROOF_ALREADY_FINALIZED";
    });

    const frozen = await request(harness.app)
      .get(`/transactions/${transactionId}`)
      .set(auth(seller));
    expect(frozen.body.itemTitle).toBe("Vintage camera");
    expect(frozen.body.shipping.trackingNumber).toBe(SHIPPING.trackingNumber);
  });

  it("still refuses a second Proof for one transaction at the domain layer", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-ctx");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "ext-ctx-1",
      itemTitle: "Lens",
    });
    const first = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    const second = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    expect(second.proofId).toBe(first.proofId);
    const count = await harness.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM proofs WHERE transaction_id = $1`,
      [txn.transactionId],
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });
});

describe("transaction context does not break evidence finalization helpers", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("can still commit evidence after transaction details exist", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-2");
    const buyer = await login(harness.app, "buyer-2");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Box",
      shipping: { carrier: "DHL", service: "Express", trackingNumber: "DHL1", shipmentDate: "2026-08-22" },
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    const invite = await createInvitation(
      harness.db,
      harness.clock,
      seller,
      proof.proofId,
      "buyer@example.com",
    );
    await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.token);
    const upload = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      { contentType: "video/mp4", idempotencyKey: "ctx-1" },
    );
    await harness.objectStore.put(upload.objectKey, Buffer.from("bytes"), "video/mp4");
    const committed = await commitEvidence(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      upload.evidenceId,
    );
    expect(committed.proof.status).toBe("EVIDENCE_COMMITTED");
    expect(committed.proof.transaction.itemTitle).toBe("Box");
    expect(committed.proof.transaction.shipping?.carrier).toBe("DHL");
  });
});
