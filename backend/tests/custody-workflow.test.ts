import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sha256Hex } from "../src/hash.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { bindAssetExternalRef } from "../src/domain/asset-bindings.js";
import { createTransaction } from "../src/domain/transactions.js";
import { evaluateWorkflowPolicy } from "../src/domain/workflow.js";
import { retentionPolicyFor } from "../src/domain/retention.js";
import { hashCanonicalManifest } from "../src/domain/finalize.js";
import { auth, commitProofEvidence, createHarness, login, type TestHarness } from "./helpers.js";
import { errorCodeFromSql } from "../src/domain/errors.js";

async function commitSlot(
  harness: TestHarness,
  userId: string,
  proofId: string,
  evidenceType: string,
  slot: string,
) {
  return commitProofEvidence(harness, userId, proofId, {
    evidenceType,
    contentType: evidenceType === "PACKING_CAPTURE" ? "video/mp4" : "image/jpeg",
    bytes: Buffer.from(`${proofId}-${slot}-${userId}`),
    idempotencyKey: `${proofId}-${slot}-${userId}`,
  });
}

describe("custody workflow policy", () => {
  it("keeps commerce next action on packing then finalize", () => {
    const ready = evaluateWorkflowPolicy({
      workflowType: "COMMERCE_SALE",
      proofStatus: "READY_FOR_EVIDENCE",
      actorRole: "SELLER",
      assets: [],
      documentedAssetIds: [],
      packedAssetIds: [],
      originObservationId: null,
      packed: false,
      released: false,
      received: false,
      intakeCaptured: false,
      compared: false,
      processOutput: false,
      returnPacked: false,
      finalReceipt: false,
      openTransferId: null,
      committedEvidenceCount: 0,
      packingAttested: false,
      fulfillmentCaptureCount: 0,
    });
    expect(ready.nextAction?.type).toBe("PACK_ITEMS");
    expect(ready.canFinalize).toBe(false);
  });

  it("does not expire grading evidence while custody is active", () => {
    expect(retentionPolicyFor("GRADING_SUBMISSION").retainWhileActiveCustody).toBe(true);
    expect(retentionPolicyFor("COMMERCE_SALE").evidenceExpires).toBe(false);
  });
});

describe("grading custody vertical slice", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("runs origin document, pack, handoff, guest view, receive, compare, final receipt, and finalize", async () => {
    harness = await createHarness();
    const originator = await login(harness.app, "grade-origin");
    const receiver = await login(harness.app, "grade-receiver");
    const stranger = await login(harness.app, "grade-stranger");

    const created = await request(harness.app)
      .post("/proofs")
      .set(auth(originator))
      .send({ workflowType: "GRADING_SUBMISSION", itemCount: 2, itemTitle: "PSA submission" });
    expect(created.status).toBe(201);
    expect(created.body.workflowType).toBe("GRADING_SUBMISSION");
    expect(created.body.assets).toHaveLength(2);
    expect(created.body.assets[0].assetInstanceId).not.toBe(created.body.assets[1].assetInstanceId);
    expect(created.body.nextAction.type).toBe("CAPTURE_ASSET");
    expect(created.body.nextAction.title).toContain("Document item 1 of 2");
    const proofId = created.body.proofId as string;
    const assetA = created.body.assets[0].assetId as string;
    const assetB = created.body.assets[1].assetId as string;

    const catalog = await request(harness.app)
      .patch(`/proofs/${proofId}/assets/${assetA}`)
      .set(auth(originator))
      .send({ catalogDescriptor: { set: "Base", card: "Charizard" } });
    expect(catalog.status).toBe(200);
    expect(catalog.body.asset.catalogDescriptor.card).toBe("Charizard");

    const identicalBind = await bindAssetExternalRef(harness.db, harness.clock, originator, proofId, {
      scope: "ASSET",
      tenantKey: "psa:cert",
      externalId: "12345678",
      assetId: assetA,
    });
    await expect(
      bindAssetExternalRef(harness.db, harness.clock, originator, proofId, {
        scope: "ASSET",
        tenantKey: "psa:cert",
        externalId: "12345678",
        assetId: assetB,
      }),
    ).rejects.toMatchObject({ code: "ASSET_BINDING_CONFLICT" });
    expect(identicalBind.assetId).toBe(assetA);

    async function documentAsset(assetId: string, label: string) {
      const front = await commitSlot(harness, originator, proofId, "ASSET_CAPTURE", `${label}-front`);
      const back = await commitSlot(harness, originator, proofId, "ASSET_CAPTURE", `${label}-back`);
      const documented = await request(harness.app)
        .post(`/proofs/${proofId}/actions/document`)
        .set(auth(originator))
        .send({
          assetId,
          recipe: "CARD_STANDARD_V1",
          evidence: [
            { slot: "FRONT", evidenceId: front.evidenceId },
            { slot: "BACK", evidenceId: back.evidenceId },
          ],
          idempotencyKey: `doc-${assetId}`,
        });
      expect(documented.status).toBe(200);
      const again = await request(harness.app)
        .post(`/proofs/${proofId}/actions/document`)
        .set(auth(originator))
        .send({
          assetId,
          recipe: "CARD_STANDARD_V1",
          evidence: [
            { slot: "FRONT", evidenceId: front.evidenceId },
            { slot: "BACK", evidenceId: back.evidenceId },
          ],
          idempotencyKey: `doc-${assetId}`,
        });
      expect(again.body.proof.observations.filter((row: { type: string }) => row.type === "ORIGIN_CAPTURE")).toHaveLength(
        documented.body.proof.observations.filter((row: { type: string }) => row.type === "ORIGIN_CAPTURE").length,
      );
      return front;
    }

    const firstFront = await documentAsset(assetA, "a");
    await documentAsset(assetB, "b");

    const pending = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/uploads`)
      .set(auth(originator))
      .set("Idempotency-Key", `pending-${proofId}`)
      .send({ contentType: "image/jpeg", evidenceType: "ASSET_CAPTURE" });
    const uncommitted = await request(harness.app)
      .post(`/proofs/${proofId}/actions/document`)
      .set(auth(originator))
      .send({
        assetId: assetA,
        recipe: "CARD_STANDARD_V1",
        evidence: [
          { slot: "FRONT", evidenceId: pending.body.evidenceId },
          { slot: "BACK", evidenceId: firstFront.evidenceId },
        ],
        idempotencyKey: "uncommitted-doc",
      });
    expect(uncommitted.status).toBe(422);
    expect(uncommitted.body.error.code).toBe("EVIDENCE_NOT_COMMITTED");
    await harness.objectStore.put(
      pending.body.objectKey,
      Buffer.from("pending-bytes"),
      "image/jpeg",
    );
    await request(harness.app)
      .post(`/proofs/${proofId}/evidence/${pending.body.evidenceId}/commit`)
      .set(auth(originator))
      .send({ sha256: sha256Hex(Buffer.from("pending-bytes")) });

    const otherTxn = await createTransaction(harness.db, harness.clock, originator, {
      itemTitle: "other",
    });
    const otherProof = await createOrGetProof(harness.db, harness.clock, originator, otherTxn.transactionId);
    const otherEvidence = await commitSlot(
      harness,
      originator,
      otherProof.proofId,
      "ASSET_CAPTURE",
      "other-front",
    );
    const crossed = await request(harness.app)
      .post(`/proofs/${proofId}/actions/document`)
      .set(auth(originator))
      .send({
        assetId: assetA,
        recipe: "CARD_STANDARD_V1",
        evidence: [
          { slot: "FRONT", evidenceId: otherEvidence.evidenceId },
          { slot: "BACK", evidenceId: firstFront.evidenceId },
        ],
        idempotencyKey: "cross-proof-doc",
      });
    expect(crossed.status).toBe(409);
    expect(crossed.body.error.code).toBe("EVIDENCE_PROOF_MISMATCH");

    const packing = await commitSlot(harness, originator, proofId, "PACKING_CAPTURE", "pack");
    const packed = await request(harness.app)
      .post(`/proofs/${proofId}/actions/pack`)
      .set(auth(originator))
      .send({
        recipe: "PACKING_STANDARD_V1",
        evidence: [{ slot: "PACKING_VIDEO", evidenceId: packing.evidenceId }],
        idempotencyKey: "pack-1",
      });
    expect(packed.status).toBe(200);
    expect(packed.body.proof.nextAction.type).toBe("HAND_OFF");

    const handed = await request(harness.app)
      .post(`/proofs/${proofId}/actions/handoff`)
      .set(auth(originator))
      .send({
        transferType: "SHIPMENT",
        shipping: { carrier: "USPS", trackingNumber: "9400TEST" },
        idempotencyKey: "hand-1",
      });
    expect(handed.status).toBe(200);
    expect(handed.body.proof.transfers).toHaveLength(1);
    expect(handed.body.proof.transfers[0].status).toBe("OPEN");
    expect(handed.body.proof.transfers[0].toObservationId).toBeNull();
    expect(handed.body.proof.nextAction.type).toBe("WAIT_FOR_RECEIPT");
    const transferId = handed.body.proof.transfers[0].transferId as string;

    const retriedHandoff = await request(harness.app)
      .post(`/proofs/${proofId}/actions/handoff`)
      .set(auth(originator))
      .send({ transferType: "SHIPMENT", idempotencyKey: "hand-1" });
    expect(retriedHandoff.body.proof.transfers).toHaveLength(1);

    const share = await request(harness.app)
      .post(`/proofs/${proofId}/access-links`)
      .set(auth(originator))
      .send({ scope: "SUMMARY" });
    expect(share.status).toBe(201);
    expect(share.body.token).toBeTruthy();
    expect(share.body.url).toContain("/p/");
    const token = share.body.token as string;

    const listed = await request(harness.app)
      .get(`/proofs/${proofId}/access-links`)
      .set(auth(originator));
    expect(listed.body.accessLinks[0].token).toBeUndefined();
    expect(JSON.stringify(listed.body)).not.toContain(token);

    const publicView = await request(harness.app).get(`/public/proofs/${token}`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.schema).toBe("packproof.proof.public/v1");
    expect(publicView.body.workflowStage).toBe("IN_TRANSIT");
    expect(publicView.body.join.requiresAuthentication).toBe(true);
    expect(JSON.stringify(publicView.body)).not.toMatch(/cognito|objectKey|sha256|token_hash/i);
    expect(publicView.body.observations.some((row: { label: string }) => row.label === "Handed off")).toBe(
      true,
    );

    const publicMutate = await request(harness.app)
      .post(`/proofs/${proofId}/actions/receive`)
      .send({ transferId });
    expect(publicMutate.status).toBe(401);

    const strangerMutate = await request(harness.app)
      .post(`/proofs/${proofId}/actions/receive`)
      .set(auth(stranger))
      .send({ transferId });
    expect(strangerMutate.status).toBe(403);

    const invalid = await request(harness.app).get(`/public/proofs/${proofId}`);
    expect(invalid.status).toBe(404);

    const invite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(originator))
      .send({ inviteeUserId: receiver });
    expect(invite.status).toBe(201);
    await request(harness.app)
      .post(`/invitations/${invite.body.invitation.invitationId}/accept`)
      .set(auth(receiver));

    const receiverProof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(receiver));
    expect(receiverProof.body.nextAction.type).toBe("RECEIVE_ITEMS");

    const received = await request(harness.app)
      .post(`/proofs/${proofId}/actions/receive`)
      .set(auth(receiver))
      .send({ transferId, idempotencyKey: "recv-1" });
    expect(received.status).toBe(200);
    expect(received.body.proof.transfers[0].status).toBe("RECEIVED");
    const againReceive = await request(harness.app)
      .post(`/proofs/${proofId}/actions/receive`)
      .set(auth(receiver))
      .send({ transferId, idempotencyKey: "recv-1" });
    expect(againReceive.body.proof.transfers).toHaveLength(1);

    const otherReceive = await request(harness.app)
      .post(`/proofs/${otherProof.proofId}/actions/receive`)
      .set(auth(originator))
      .send({ transferId });
    expect([403, 404, 409]).toContain(otherReceive.status);

    const pkg = await commitSlot(harness, receiver, proofId, "RECEIPT_CAPTURE", "pkg");
    const rFront = await commitSlot(harness, receiver, proofId, "RECEIPT_CAPTURE", "r-front");
    const rBack = await commitSlot(harness, receiver, proofId, "RECEIPT_CAPTURE", "r-back");
    const intake = await request(harness.app)
      .post(`/proofs/${proofId}/actions/document`)
      .set(auth(receiver))
      .send({
        recipe: "RECEIPT_STANDARD_V1",
        evidence: [
          { slot: "PACKAGE", evidenceId: pkg.evidenceId },
          { slot: "ITEM_FRONT", evidenceId: rFront.evidenceId },
          { slot: "ITEM_BACK", evidenceId: rBack.evidenceId },
        ],
        idempotencyKey: "intake-1",
      });
    expect(intake.status).toBe(200);

    const compared = await request(harness.app)
      .post(`/proofs/${proofId}/actions/compare`)
      .set(auth(receiver))
      .send({ idempotencyKey: "cmp-1" });
    expect(compared.status).toBe(200);
    expect(compared.body.proof.nextAction.type).toBe("DOCUMENT_OUTPUT");
    expect(compared.body.proof.continuityObservations[0].result).toMatch(/CONSISTENT|INCONCLUSIVE/);
    expect(compared.body.proof.continuityObservations[0].summary).not.toMatch(/swapped|stolen|fraud/i);
    const pairs = compared.body.proof.continuityObservations[0].evidencePairs as Array<{
      slot: string;
      originEvidenceId: string | null;
      receivedEvidenceId: string | null;
    }>;
    expect(pairs.some((row) => row.slot === "FRONT" && row.originEvidenceId && row.receivedEvidenceId)).toBe(true);
    const originFront = await request(harness.app)
      .get(`/proofs/${proofId}/evidence/${firstFront.evidenceId}`)
      .set(auth(originator));
    expect(originFront.status).toBe(200);
    expect(originFront.headers["content-type"]).toMatch(/image\/jpeg/);
    expect(Buffer.isBuffer(originFront.body) || originFront.body.length > 0).toBe(true);
    const strangerView = await request(harness.app)
      .get(`/proofs/${proofId}/evidence/${firstFront.evidenceId}`)
      .set(auth(stranger));
    expect(strangerView.status).toBe(403);
    const comparedAgain = await request(harness.app)
      .post(`/proofs/${proofId}/actions/compare`)
      .set(auth(receiver))
      .send({ idempotencyKey: "cmp-1" });
    expect(comparedAgain.body.proof.continuityObservations).toHaveLength(1);

    const material = await request(harness.app)
      .post(`/proofs/${proofId}/actions/compare`)
      .set(auth(receiver))
      .send({ finding: "MATERIAL_DIFFERENCE", algorithmVersion: "visual-slot-completeness/v1-manual" });
    expect(material.body.proof.continuityObservations).toHaveLength(2);
    expect(material.body.proof.evidence[0].sha256).toBe(firstFront.sha256);

    const output = await request(harness.app)
      .post(`/proofs/${proofId}/actions/output`)
      .set(auth(receiver))
      .send({ idempotencyKey: "output-1" });
    expect(output.status).toBe(200);
    expect(output.body.proof.nextAction.type).toBe("RETURN_PACK");

    const returnPack = await request(harness.app)
      .post(`/proofs/${proofId}/actions/return-pack`)
      .set(auth(receiver))
      .send({ idempotencyKey: "ret-1" });
    expect(returnPack.status).toBe(200);
    const finalReceipt = await request(harness.app)
      .post(`/proofs/${proofId}/actions/final-receipt`)
      .set(auth(originator))
      .send({ idempotencyKey: "final-1" });
    expect(finalReceipt.status).toBe(200);
    expect(finalReceipt.body.proof.nextAction.type).toBe("FINALIZE");

    const finalized = await request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(originator));
    expect(finalized.status).toBe(200);
    const manifest = finalized.body.manifest.manifest as Record<string, unknown>;
    expect(manifest.workflowType).toBe("GRADING_SUBMISSION");
    expect(manifest.custodyOutcome).toBe("ROUND_TRIP_COMPLETE");
    expect(finalized.body.proof.custodyOutcome).toBe("ROUND_TRIP_COMPLETE");
    await expect(
      harness.db.query(
        `UPDATE proof_assets SET catalog_descriptor = $2::jsonb WHERE id = $1`,
        [assetA, JSON.stringify({ changed: "after-finalize" })],
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCodeFromSql(error) === "PROOF_ALREADY_FINALIZED",
    );
    expect(Array.isArray(manifest.assets)).toBe(true);
    expect(Array.isArray(manifest.observations)).toBe(true);
    expect(Array.isArray(manifest.transfers)).toBe(true);
    const again = await request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(originator));
    expect(again.body.manifest.sha256).toBe(finalized.body.manifest.sha256);
    expect(hashCanonicalManifest(finalized.body.manifest.manifest).sha256).toBe(
      finalized.body.manifest.sha256,
    );

    const afterFinalizePublic = await request(harness.app).get(`/public/proofs/${token}`);
    expect(afterFinalizePublic.body.status).toBe("FINALIZED");

    const revoked = await request(harness.app)
      .delete(`/proofs/${proofId}/access-links/${share.body.accessLinkId}`)
      .set(auth(originator));
    expect(revoked.status).toBe(204);
    const afterRevoke = await request(harness.app).get(`/public/proofs/${token}`);
    expect(afterRevoke.status).toBe(404);
  });

  it("allows origin-only grading after handoff when no receiver joins", async () => {
    harness = await createHarness();
    const originator = await login(harness.app, "origin-only");
    const created = await request(harness.app)
      .post("/proofs")
      .set(auth(originator))
      .send({ workflowType: "GRADING_SUBMISSION", itemCount: 1 });
    const proofId = created.body.proofId as string;
    const assetId = created.body.assets[0].assetId as string;
    const front = await commitSlot(harness, originator, proofId, "ASSET_CAPTURE", "o-front");
    const back = await commitSlot(harness, originator, proofId, "ASSET_CAPTURE", "o-back");
    await request(harness.app)
      .post(`/proofs/${proofId}/actions/document`)
      .set(auth(originator))
      .send({
        assetId,
        recipe: "CARD_STANDARD_V1",
        evidence: [
          { slot: "FRONT", evidenceId: front.evidenceId },
          { slot: "BACK", evidenceId: back.evidenceId },
        ],
      });
    await request(harness.app).post(`/proofs/${proofId}/actions/pack`).set(auth(originator)).send({});
    await request(harness.app).post(`/proofs/${proofId}/actions/handoff`).set(auth(originator)).send({});
    const proof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(originator));
    expect(proof.body.transfers[0].intervalNote).toBe(
      "No PackProof observation exists for this interval.",
    );
    expect(proof.body.nextAction.type).toBe("WAIT_FOR_RECEIPT");
    const finalized = await request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(originator));
    expect(finalized.status).toBe(200);
    expect(finalized.body.proof.custodyOutcome).toBe("ORIGIN_RECORD_FINALIZED");
    expect(finalized.body.manifest.manifest.custodyOutcome).toBe("ORIGIN_RECORD_FINALIZED");
  });

  it("does not change COMMERCE_SALE create-or-get or seller-only evidence", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "commerce-seller");
    const buyer = await login(harness.app, "commerce-buyer");
    const txn = await request(harness.app).post("/transactions").set(auth(seller)).send({
      itemTitle: "Commerce card",
    });
    const proof = await request(harness.app)
      .post(`/transactions/${txn.body.transactionId}/proof`)
      .set(auth(seller));
    expect(proof.status).toBe(200);
    expect(proof.body.workflowType).toBe("COMMERCE_SALE");
    expect(proof.body.assets).toEqual([]);
    const again = await request(harness.app)
      .post(`/transactions/${txn.body.transactionId}/proof`)
      .set(auth(seller));
    expect(again.body.proofId).toBe(proof.body.proofId);
    const invite = await request(harness.app)
      .post(`/proofs/${proof.body.proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeUserId: buyer });
    await request(harness.app)
      .post(`/invitations/${invite.body.invitation.invitationId}/accept`)
      .set(auth(buyer));
    const denied = await request(harness.app)
      .post(`/proofs/${proof.body.proofId}/evidence/uploads`)
      .set(auth(buyer))
      .set("Idempotency-Key", "buyer-evd")
      .send({ contentType: "video/mp4", evidenceType: "SELLER_EVIDENCE" });
    expect(denied.status).toBe(403);
  });
});
