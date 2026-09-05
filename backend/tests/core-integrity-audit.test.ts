import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createProof } from "../src/domain/create-proof.js";
import { initializeEvidenceUpload, commitEvidence, MAX_EVIDENCE_BYTES } from "../src/domain/evidence.js";
import { createInvitation, acceptInvitation } from "../src/domain/invitations.js";
import { createObservation } from "../src/domain/observations.js";
import { evaluateContinuity, toContinuityView, CONTINUITY_ALGORITHM_V1, CONTINUITY_ALGORITHM_V2 } from "../src/domain/continuity.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { auth, createHarness, createUser, commitProofEvidence, type TestHarness } from "./helpers.js";

describe("core integrity audit regressions", () => {
  let h: TestHarness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  async function gradingPair(itemCount = 1) {
    const seller = await createUser(h);
    const buyer = await createUser(h);
    const proof = await createProof(h.db, h.clock, seller, {
      workflowType: "GRADING_SUBMISSION", itemCount,
    });
    const invitation = await createInvitation(h.db, h.clock, seller, proof.proofId, {
      inviteeUserId: buyer,
    });
    await acceptInvitation(h.db, h.clock, buyer, invitation.invitation.invitationId);
    return { seller, buyer, proof };
  }

  it("never grants another participant a PUT target by replaying the original upload key", async () => {
    const { seller, buyer, proof } = await gradingPair();
    const input = {
      contentType: "image/jpeg", evidenceType: "ASSET_CAPTURE", idempotencyKey: "capture-front",
    };
    const original = await initializeEvidenceUpload(h.db, h.clock, h.objectStore, seller, proof.proofId, input);
    const denied = await request(h.app)
      .post(`/proofs/${proof.proofId}/evidence/uploads`)
      .set(auth(buyer)).set("Idempotency-Key", input.idempotencyKey)
      .send({ contentType: input.contentType, evidenceType: input.evidenceType });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PARTICIPANT_NOT_AUTHORIZED");
    expect(denied.body.upload).toBeUndefined();
    const replay = await initializeEvidenceUpload(h.db, h.clock, h.objectStore, seller, proof.proofId, input);
    expect(replay.evidenceId).toBe(original.evidenceId);
    expect((await h.db.query("SELECT submitted_by FROM evidence WHERE id=$1", [original.evidenceId])).rows[0].submitted_by).toBe(seller);
  });

  it("rejects upload-key reuse when the media type or evidence purpose changes", async () => {
    const { seller, proof } = await gradingPair();
    const input = {
      contentType: "image/jpeg", evidenceType: "ASSET_CAPTURE", idempotencyKey: "same-key",
    };
    await initializeEvidenceUpload(h.db, h.clock, h.objectStore, seller, proof.proofId, input);
    for (const changed of [{ contentType: "video/mp4" }, { evidenceType: "PACKING_CAPTURE" }]) {
      await expect(initializeEvidenceUpload(h.db, h.clock, h.objectStore, seller, proof.proofId, {
        ...input, ...changed,
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", httpStatus: 409 });
    }
    expect((await h.db.query("SELECT id FROM evidence WHERE proof_id=$1", [proof.proofId])).rows).toHaveLength(1);
  });

  it("rejects empty and oversized evidence while allowing a valid retry", async () => {
    const seller = await createUser(h);
    const proof = await createProof(h.db, h.clock, seller, {});
    const upload = await initializeEvidenceUpload(h.db, h.clock, h.objectStore, seller, proof.proofId, {
      contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE", idempotencyKey: "size-boundary",
    });
    await h.objectStore.put(upload.objectKey, Buffer.alloc(0), "video/mp4");
    await expect(commitEvidence(h.db, h.clock, h.objectStore, seller, proof.proofId, upload.evidenceId))
      .rejects.toMatchObject({ code: "INVALID_EVIDENCE_SIZE" });
    const commit = vi.spyOn(h.objectStore, "commitUpload").mockResolvedValueOnce({
      key: "unused-oversized-snapshot", sha256: "a".repeat(64),
      contentType: "video/mp4", byteSize: MAX_EVIDENCE_BYTES + 1,
    });
    try {
      await expect(commitEvidence(h.db, h.clock, h.objectStore, seller, proof.proofId, upload.evidenceId))
        .rejects.toMatchObject({ code: "INVALID_EVIDENCE_SIZE" });
    } finally { commit.mockRestore(); }
    expect((await h.db.query("SELECT validation_status FROM evidence WHERE id=$1", [upload.evidenceId])).rows[0].validation_status).toBe("PENDING");
    await h.objectStore.put(upload.objectKey, Buffer.from("valid-recording"), "video/mp4");
    expect((await commitEvidence(h.db, h.clock, h.objectStore, seller, proof.proofId, upload.evidenceId)).validationStatus).toBe("COMMITTED");
  });

  it("allows a grading receiver to preserve return-packing evidence", async () => {
    const { buyer, proof } = await gradingPair();
    const capture = await commitProofEvidence(h, buyer, proof.proofId, {
      evidenceType: "PACKING_CAPTURE", contentType: "video/mp4",
    });
    const packed = await request(h.app).post(`/proofs/${proof.proofId}/actions/return-pack`).set(auth(buyer)).send({
      evidence: [{ slot: "PACKING_VIDEO", evidenceId: capture.evidenceId }],
    });
    expect(packed.status).toBe(200);
    expect(packed.body.proof.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "RETURN_PACKED", evidence: [{ slot: "PACKING_VIDEO", evidenceId: capture.evidenceId }] }),
    ]));
  });

  it("requires every grading asset to be documented before allowing origin-only finalization", async () => {
    const { seller, proof } = await gradingPair(2);
    const base = `/proofs/${proof.proofId}`;
    expect((await request(h.app).post(`${base}/actions/pack`).set(auth(seller)).send({})).status).toBe(200);
    expect((await request(h.app).post(`${base}/actions/handoff`).set(auth(seller)).send({})).status).toBe(200);
    const empty = await request(h.app).post(`${base}/finalize`).set(auth(seller));
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe("PROOF_NOT_READY_FOR_FINALIZATION");
    expect((await h.db.query("SELECT id FROM final_manifests WHERE proof_id=$1", [proof.proofId])).rows).toHaveLength(0);

    const incompleteOrigin = await commitProofEvidence(h, seller, proof.proofId, {
      evidenceType: "ASSET_CAPTURE", contentType: "image/jpeg", idempotencyKey: "incomplete-origin",
    });
    await createObservation(h.db, h.clock, seller, proof.proofId, {
      type: "ORIGIN_CAPTURE", assetIds: proof.assets.map((a) => a.assetId),
      evidence: [{ slot: "FRONT", evidenceId: incompleteOrigin.evidenceId }],
    });
    await expect(finalizeProof(h.db, h.clock, seller, proof.proofId)).rejects.toMatchObject({
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
    });

    for (const [index, asset] of proof.assets.entries()) {
      const front = await commitProofEvidence(h, seller, proof.proofId, {
        evidenceType: "ASSET_CAPTURE", contentType: "image/jpeg", idempotencyKey: `front-${index}`,
      });
      const back = await commitProofEvidence(h, seller, proof.proofId, {
        evidenceType: "ASSET_CAPTURE", contentType: "image/jpeg", idempotencyKey: `back-${index}`,
      });
      const documented = await request(h.app).post(`${base}/actions/document`).set(auth(seller)).send({
        assetId: asset.assetId, recipe: "CARD_STANDARD_V1",
        evidence: [{ slot: "FRONT", evidenceId: front.evidenceId }, { slot: "BACK", evidenceId: back.evidenceId }],
      });
      expect(documented.status).toBe(200);
      if (index === 0) {
        await expect(finalizeProof(h.db, h.clock, seller, proof.proofId)).rejects.toMatchObject({
          code: "PROOF_NOT_READY_FOR_FINALIZATION",
        });
      }
    }
    const finalized = await finalizeProof(h.db, h.clock, seller, proof.proofId);
    expect(finalized.proof.status).toBe("FINALIZED");
    expect((finalized.manifest.manifest as { evidence: unknown[] }).evidence).toHaveLength(5);
  });

  it("does not infer visual consistency from matching slots and preserves later participant findings", async () => {
    const { seller, buyer, proof } = await gradingPair();
    const slots = ["FRONT", "BACK"];
    for (const [actor, type, evidenceType] of [
      [seller, "ORIGIN_CAPTURE", "ASSET_CAPTURE"],
      [buyer, "INTAKE_CAPTURE", "RECEIPT_CAPTURE"],
    ]) {
      const evidence = [];
      for (const slot of slots) {
        const media = await commitProofEvidence(h, actor, proof.proofId, {
          evidenceType, contentType: "image/jpeg", bytes: Buffer.from(`${actor}-${slot}-different-content`),
          idempotencyKey: `${actor}-${slot}`,
        });
        evidence.push({ slot, evidenceId: media.evidenceId });
      }
      await createObservation(h.db, h.clock, actor, proof.proofId, {
        type, assetIds: [proof.assets[0].assetId], evidence,
      });
    }
    const automatic = await evaluateContinuity(h.db, h.clock, buyer, proof.proofId, {
      algorithmVersion: CONTINUITY_ALGORITHM_V1,
    });
    expect(automatic.evidencePairs.every(pair => pair.originEvidenceId && pair.receivedEvidenceId)).toBe(true);
    expect(automatic.algorithmVersion).toBe(CONTINUITY_ALGORITHM_V2);
    expect(automatic.result).toBe("INCONCLUSIVE");
    expect(automatic.summary).toContain("visual consistency has not been evaluated");
    const finding = await evaluateContinuity(h.db, h.clock, buyer, proof.proofId, {
      finding: "MATERIAL_DIFFERENCE", idempotencyKey: "manual-finding", algorithmVersion: CONTINUITY_ALGORITHM_V2,
    });
    expect(finding.evaluationId).not.toBe(automatic.evaluationId);
    expect(finding.result).toBe("MATERIAL_DIFFERENCE");
    expect(finding.summary).toContain("Participant-recorded finding");
    expect(finding.algorithmVersion).toMatch(/^participant-recorded\/v1\//);
    expect(finding.actorParticipantId).toBeTruthy();
    expect(await evaluateContinuity(h.db, h.clock, buyer, proof.proofId, {
      finding: "MATERIAL_DIFFERENCE", idempotencyKey: "manual-finding",
    })).toEqual(finding);
    await expect(evaluateContinuity(h.db, h.clock, seller, proof.proofId, {
      finding: "CONSISTENT", idempotencyKey: "manual-finding",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const sellerFinding = await evaluateContinuity(h.db, h.clock, seller, proof.proofId, { finding: "CONSISTENT" });
    expect(sellerFinding.result).toBe("CONSISTENT");
    expect(sellerFinding.actorParticipantId).not.toBe(finding.actorParticipantId);
    expect((await h.db.query("SELECT id FROM continuity_evaluations WHERE proof_id=$1", [proof.proofId])).rows).toHaveLength(3);
    const stored = (await h.db.query<any>("SELECT * FROM continuity_evaluations WHERE id=$1", [automatic.evaluationId])).rows[0];
    const legacy = { ...stored, algorithm_version: CONTINUITY_ALGORITHM_V1, result: "CONSISTENT" };
    expect(toContinuityView(legacy)).toMatchObject({
      result: "INCONCLUSIVE", summary: "Legacy capture availability check; visual consistency was not evaluated.",
    });
    expect(legacy.result).toBe("CONSISTENT");
  });
});
