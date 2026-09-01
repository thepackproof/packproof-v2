import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { commitAttestation } from "../src/domain/attestations.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { initializeEvidenceUpload } from "../src/domain/evidence.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { createTransaction } from "../src/domain/transactions.js";
import { auth, commitProofEvidence, createHarness, login, type TestHarness } from "./helpers.js";

async function merchantProof(harness: TestHarness, seller: string, reference: string) {
  const txn = await createTransaction(harness.db, harness.clock, seller, {
    externalReference: reference,
    itemTitle: "Charizard PSA 10",
  });
  const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId, {
    participationPolicy: "COUNTERPARTY_OPTIONAL",
  });
  return { txn, proof };
}

describe("merchant fulfillment capture finalization", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("rejects merchant finalize with attestation and no fulfillment capture", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "cap-none");
    const { proof } = await merchantProof(harness, seller, "CAP-NONE");
    await commitAttestation(harness.db, harness.clock, seller, proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });
    const denied = await request(harness.app).post(`/proofs/${proof.proofId}/finalize`).set(auth(seller));
    expect(denied.status).toBe(422);
    expect(denied.body.error.code).toBe("FULFILLMENT_CAPTURE_REQUIRED");
    expect(denied.body.error.message).toMatch(/Packing evidence is required/i);
    const still = await request(harness.app).get(`/proofs/${proof.proofId}`).set(auth(seller));
    expect(still.body.status).not.toBe("FINALIZED");
  });

  it("finalizes a merchant Proof with qualifying capture and required attestation", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "cap-ok");
    const { proof, txn } = await merchantProof(harness, seller, "CAP-OK");
    await commitAttestation(harness.db, harness.clock, seller, proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });
    const committed = await commitProofEvidence(harness, seller, proof.proofId, {
      evidenceType: "FULFILLMENT_CAPTURE",
    });
    expect(committed.proof.evidence[0]?.evidenceType).toBe("FULFILLMENT_CAPTURE");
    const finalized = await request(harness.app).post(`/proofs/${proof.proofId}/finalize`).set(auth(seller));
    expect(finalized.status).toBe(200);
    expect(finalized.body.proof.status).toBe("FINALIZED");
    expect(finalized.body.manifest.manifest.evidence[0].evidenceType).toBe("FULFILLMENT_CAPTURE");
    const retry = await request(harness.app).post(`/proofs/${proof.proofId}/finalize`).set(auth(seller));
    expect(retry.status).toBe(200);
    expect(retry.body.manifest.sha256).toBe(finalized.body.manifest.sha256);
    const same = await request(harness.app)
      .post(`/transactions/${txn.transactionId}/proof`)
      .set(auth(seller));
    expect(same.body.proofId).toBe(proof.proofId);
  });

  it("rejects merchant finalize when only non-qualifying evidence exists, including video MIME type", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "cap-mime");
    const { proof } = await merchantProof(harness, seller, "CAP-MIME");
    await commitAttestation(harness.db, harness.clock, seller, proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });
    await commitProofEvidence(harness, seller, proof.proofId, {
      evidenceType: "SELLER_EVIDENCE",
      contentType: "video/mp4",
      bytes: Buffer.from("unrelated-packing.mp4"),
      idempotencyKey: "generic-video",
    });
    const denied = await request(harness.app).post(`/proofs/${proof.proofId}/finalize`).set(auth(seller));
    expect(denied.status).toBe(422);
    expect(denied.body.error.code).toBe("FULFILLMENT_CAPTURE_REQUIRED");
    const spoofType = await request(harness.app)
      .post(`/proofs/${proof.proofId}/evidence/uploads`)
      .set({ ...auth(seller), "Idempotency-Key": "spoof-type" })
      .send({ contentType: "video/mp4", evidenceType: "video/mp4" });
    expect(spoofType.status).toBe(400);
    expect(spoofType.body.error.code).toBe("INVALID_EVIDENCE_TYPE");
    const spoofName = await request(harness.app)
      .post(`/proofs/${proof.proofId}/evidence/uploads`)
      .set({ ...auth(seller), "Idempotency-Key": "spoof-name" })
      .send({ contentType: "video/mp4", evidenceType: "packing-station.mp4" });
    expect(spoofName.status).toBe(400);
  });

  it("leaves P2P finalization on any committed evidence and buyer join", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "cap-p2p-s");
    const buyer = await login(harness.app, "cap-p2p-b");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "P2P camera",
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    const invite = await createInvitation(harness.db, harness.clock, seller, proof.proofId, {
      inviteeUserId: buyer,
    });
    await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.invitationId);
    await commitProofEvidence(harness, seller, proof.proofId, {
      evidenceType: "SELLER_EVIDENCE",
    });
    const finalized = await finalizeProof(harness.db, harness.clock, seller, proof.proofId);
    expect(finalized.proof.status).toBe("FINALIZED");
    expect(finalized.manifest.manifest).not.toHaveProperty("participationPolicy");
  });

  it("does not rewrite an already-finalized historical merchant Proof without capture", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "cap-hist");
    const { proof } = await merchantProof(harness, seller, "CAP-HIST");
    await commitAttestation(harness.db, harness.clock, seller, proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });
    const now = harness.clock.now().toISOString();
    await harness.db.query(
      `INSERT INTO final_manifests (id, proof_id, canonical_json, sha256, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "man_historical_no_capture",
        proof.proofId,
        '{"schema":"packproof.manifest/historical","proofId":"legacy"}',
        "aa".repeat(32),
        now,
      ],
    );
    await harness.db.query(
      `UPDATE proofs
          SET status = 'FINALIZED',
              finalized_at = $2,
              manifest_id = $3,
              updated_at = $2
        WHERE id = $1`,
      [proof.proofId, now, "man_historical_no_capture"],
    );
    const again = await finalizeProof(harness.db, harness.clock, seller, proof.proofId);
    expect(again.proof.status).toBe("FINALIZED");
    expect(again.manifest.manifestId).toBe("man_historical_no_capture");
    expect(again.proof.evidence).toEqual([]);
    const mutate = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      { contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE", idempotencyKey: "after-hist" },
    ).catch((error: { code?: string }) => error);
    expect(mutate).toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });
  });
});
