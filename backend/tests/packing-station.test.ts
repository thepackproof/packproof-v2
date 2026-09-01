import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { commitAttestation } from "../src/domain/attestations.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { createTransaction, updateShipping } from "../src/domain/transactions.js";
import { sha256Hex } from "../src/hash.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

async function connectAndSync(harness: TestHarness, seller: string) {
  const connected = await request(harness.app)
    .post("/dev/integrations/demo-storefront/connect")
    .set(auth(seller))
    .send({});
  expect(connected.status).toBe(201);
  const synced = await request(harness.app)
    .post(`/me/commerce-connections/${connected.body.connection.connectionId}/sync`)
    .set(auth(seller))
    .send({});
  expect(synced.status).toBe(200);
  return connected.body.connection.connectionId as string;
}

async function resolve(harness: TestHarness, seller: string, reference: string) {
  return request(harness.app)
    .post("/me/packing-station/resolve")
    .set(auth(seller))
    .send({ reference });
}

async function commitVideo(harness: TestHarness, seller: string, proofId: string) {
  const bytes = Buffer.from("packing-station-video");
  const upload = await initializeEvidenceUpload(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    {
      contentType: "video/mp4",
      evidenceType: "FULFILLMENT_CAPTURE",
      idempotencyKey: `station-${proofId}`,
    },
  );
  await harness.objectStore.put(upload.objectKey, bytes, "video/mp4");
  return commitEvidence(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    upload.evidenceId,
    sha256Hex(bytes),
  );
}

describe("packing station resolve", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("resolves an imported order without creating another Proof", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "station-seller");
    await connectAndSync(harness, seller);

    const first = await resolve(harness, seller, "#ds-1001");
    expect(first.status).toBe(200);
    expect(first.body.schema).toBe("packproof.packing-station.resolve/v1");
    expect(first.body.matchedBy).toBe("EXTERNAL_ORDER_ID");
    expect(first.body.orderLabel).toBe("Order #DS-1001");
    expect(first.body.itemSummary).toMatch(/Pokémon|Charizard|Booster|Item/i);
    expect(first.body.captureReady).toBe(true);
    expect(first.body.alreadyFinalized).toBe(false);
    expect(first.body.proofId).toBeTruthy();

    const created = await request(harness.app)
      .post(`/transactions/${first.body.transactionId}/proof`)
      .set(auth(seller));
    expect(created.status).toBe(200);
    expect(created.body.proofId).toBe(first.body.proofId);

    const again = await resolve(harness, seller, "DS-1001");
    expect(again.body.proofId).toBe(first.body.proofId);
    expect(again.body.transactionId).toBe(first.body.transactionId);

    const proofs = await request(harness.app).get("/me/proofs").set(auth(seller));
    const matches = proofs.body.proofs.filter(
      (item: { transactionId: string }) => item.transactionId === first.body.transactionId,
    );
    expect(matches).toHaveLength(1);
  });

  it("does not leak another seller's order or invent a transaction", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "station-owner");
    const other = await login(harness.app, "station-other");
    await connectAndSync(harness, seller);
    const before = await harness.db.query(`SELECT COUNT(*)::int AS n FROM transactions`);
    const missing = await resolve(harness, other, "DS-1001");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("STATION_REFERENCE_NOT_FOUND");
    const after = await harness.db.query(`SELECT COUNT(*)::int AS n FROM transactions`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    const empty = await resolve(harness, seller, "   ");
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("STATION_REFERENCE_INVALID");
  });

  it("matches tracking numbers and treats finalized Proofs as non-mutable", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "station-track");
    await connectAndSync(harness, seller);
    const resolved = await resolve(harness, seller, "DS-1002");
    expect(resolved.status).toBe(200);
    await updateShipping(harness.db, harness.clock, seller, resolved.body.transactionId, {
      carrier: "USPS",
      trackingNumber: "9400111899223344556677",
    });

    const byTrack = await resolve(harness, seller, "9400111899223344556677");
    expect(byTrack.status).toBe(200);
    expect(byTrack.body.transactionId).toBe(resolved.body.transactionId);
    expect(byTrack.body.matchedBy).toBe("TRACKING_NUMBER");

    const byProof = await resolve(harness, seller, resolved.body.proofId);
    expect(byProof.body.transactionId).toBe(resolved.body.transactionId);
    expect(byTrack.body.trackingHint).toBe("Tracking ending 6677");

    const wrapped = await resolve(harness, seller, "]C19400111899223344556677");
    expect(wrapped.status).toBe(200);
    expect(wrapped.body.transactionId).toBe(resolved.body.transactionId);

    const noisy = await resolve(harness, seller, " \u00019400111899223344556677\n");
    expect(noisy.status).toBe(200);
    expect(noisy.body.transactionId).toBe(resolved.body.transactionId);

    await commitVideo(harness, seller, resolved.body.proofId);
    await commitAttestation(harness.db, harness.clock, seller, resolved.body.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });
    await finalizeProof(harness.db, harness.clock, seller, resolved.body.proofId);

    const afterFinal = await resolve(harness, seller, "DS-1002");
    expect(afterFinal.status).toBe(200);
    expect(afterFinal.body.alreadyFinalized).toBe(true);
    expect(afterFinal.body.captureReady).toBe(false);
    expect(afterFinal.body.blockReason).toBe("FINALIZED");

    const upload = await request(harness.app)
      .post(`/proofs/${resolved.body.proofId}/evidence/uploads`)
      .set({ ...auth(seller), "Idempotency-Key": "after-final" })
      .send({ contentType: "video/mp4" });
    expect(upload.status).toBe(409);
    expect(upload.body.error.code).toBe("PROOF_ALREADY_FINALIZED");
  });

  it("attaches committed evidence to the resolved Proof and can process a second order", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "station-pack");
    await connectAndSync(harness, seller);
    const first = await resolve(harness, seller, "DS-1001");
    const committed = await commitVideo(harness, seller, first.body.proofId);
    expect(committed.proof.proofId).toBe(first.body.proofId);
    expect(committed.proof.status).toBe("EVIDENCE_COMMITTED");

    const retry = await commitVideo(harness, seller, first.body.proofId);
    expect(retry.evidenceId).toBe(committed.evidenceId);
    expect(retry.sha256).toBe(committed.sha256);

    const blocked = await resolve(harness, seller, "DS-1001");
    expect(blocked.body.alreadyHasCommittedEvidence).toBe(true);
    expect(blocked.body.captureReady).toBe(false);

    const second = await resolve(harness, seller, "DS-1010");
    expect(second.status).toBe(200);
    expect(second.body.proofId).not.toBe(first.body.proofId);
    expect(second.body.captureReady).toBe(true);
    const secondCommit = await commitVideo(harness, seller, second.body.proofId);
    expect(secondCommit.proof.proofId).toBe(second.body.proofId);
  });

  it("does not treat a P2P Proof as capture-ready before the buyer joins", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "station-p2p");
    const buyer = await login(harness.app, "station-buyer");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "P2P-22",
      itemTitle: "Sealed carton",
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    const pending = await resolve(harness, seller, "P2P-22");
    expect(pending.body.proofId).toBe(proof.proofId);
    expect(pending.body.blockReason).toBe("NEEDS_PARTICIPANT");
    expect(pending.body.captureReady).toBe(false);

    const invited = await createInvitation(harness.db, harness.clock, seller, proof.proofId, {
      inviteeUserId: buyer,
    });
    await acceptInvitation(harness.db, harness.clock, buyer, invited.invitation.invitationId);
    const ready = await resolve(harness, seller, "P2P-22");
    expect(ready.body.captureReady).toBe(true);
    expect(ready.body.blockReason).toBeNull();
  });

  it("reports ambiguous tracking across two seller transactions", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "station-ambig");
    const one = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "AMB-1",
      itemTitle: "Item A",
      shipping: { trackingNumber: "1Z999AMBIGUOUS" },
    });
    const two = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "AMB-2",
      itemTitle: "Item B",
      shipping: { trackingNumber: "1Z999AMBIGUOUS" },
    });
    expect(one.transactionId).not.toBe(two.transactionId);
    const ambig = await resolve(harness, seller, "1Z999AMBIGUOUS");
    expect(ambig.status).toBe(409);
    expect(ambig.body.error.code).toBe("STATION_REFERENCE_AMBIGUOUS");
  });
});
