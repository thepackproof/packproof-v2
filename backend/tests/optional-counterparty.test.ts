import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { DEFAULT_PARTICIPATION_POLICY } from "../src/domain/participation.js";
import { initializeEvidenceUpload } from "../src/domain/evidence.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { sha256Hex } from "../src/hash.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { createTransaction } from "../src/domain/transactions.js";
import {
  auth,
  commitFulfillmentAndAttest,
  createHarness,
  login,
  type TestHarness,
} from "./helpers.js";

describe("optional counterparty participation", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("defaults ordinary Proof creation to COUNTERPARTY_OPTIONAL and READY_FOR_EVIDENCE", async () => {
    expect(DEFAULT_PARTICIPATION_POLICY).toBe("COUNTERPARTY_OPTIONAL");
    harness = await createHarness();
    const seller = await login(harness.app, "opt-default");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Vintage film camera",
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    expect(proof.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");
    expect(proof.status).toBe("READY_FOR_EVIDENCE");
    expect(proof.participants.some((row) => row.role === "BUYER")).toBe(false);

    const viaApi = await request(harness.app)
      .post(`/transactions/${txn.transactionId}/proof`)
      .set(auth(seller));
    expect(viaApi.status).toBe(200);
    expect(viaApi.body.proofId).toBe(proof.proofId);
    expect(viaApi.body.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");
    expect(viaApi.body.status).toBe("READY_FOR_EVIDENCE");
  });

  it("lets a seller capture, commit, and finalize with zero buyer participation", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "opt-seal");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Sealed carton",
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    expect(proof.participants.filter((row) => row.role === "BUYER")).toHaveLength(0);

    const upload = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      {
        contentType: "video/mp4",
        evidenceType: "FULFILLMENT_CAPTURE",
        idempotencyKey: `opt-capture-${proof.proofId}`,
      },
    );
    expect(upload.evidenceType).toBe("FULFILLMENT_CAPTURE");

    await commitFulfillmentAndAttest(harness, seller, proof.proofId, {
      idempotencyKey: `opt-capture-${proof.proofId}`,
    });
    const finalized = await finalizeProof(harness.db, harness.clock, seller, proof.proofId);
    expect(finalized.proof.status).toBe("FINALIZED");
    expect(finalized.proof.participants.some((row) => row.role === "BUYER")).toBe(false);
    expect(finalized.manifest.manifest).toMatchObject({
      participationPolicy: "COUNTERPARTY_OPTIONAL",
    });
  });

  it("still records a buyer who is invited and joins an optional Proof", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "opt-invite-s");
    const buyer = await login(harness.app, "opt-invite-b");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Optional invite camera",
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    const invite = await createInvitation(harness.db, harness.clock, seller, proof.proofId, {
      inviteeUserId: buyer,
    });
    expect(invite.proof.status).toBe("READY_FOR_EVIDENCE");
    expect(invite.proof.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");

    const accepted = await acceptInvitation(
      harness.db,
      harness.clock,
      buyer,
      invite.invitation.invitationId,
    );
    expect(accepted.proof.status).toBe("READY_FOR_EVIDENCE");
    expect(accepted.proof.participants.filter((row) => row.role === "BUYER")).toHaveLength(1);
    expect(accepted.proof.participants.find((row) => row.role === "BUYER")?.userId).toBe(buyer);
  });

  it("keeps COUNTERPARTY_REQUIRED semantics when explicitly requested", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "req-s");
    const buyer = await login(harness.app, "req-b");
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "P2P camera",
    });
    const created = await request(harness.app)
      .post(`/transactions/${txn.transactionId}/proof`)
      .set(auth(seller))
      .send({ participationPolicy: "COUNTERPARTY_REQUIRED" });
    expect(created.status).toBe(200);
    expect(created.body.participationPolicy).toBe("COUNTERPARTY_REQUIRED");
    expect(created.body.status).toBe("OPEN");

    const premature = await request(harness.app)
      .post(`/proofs/${created.body.proofId}/evidence/uploads`)
      .set({ ...auth(seller), "Idempotency-Key": "too-soon" })
      .send({ contentType: "video/mp4" });
    expect(premature.status).toBe(422);
    expect(premature.body.error.code).toBe("INVALID_PROOF_TRANSITION");

    const invite = await createInvitation(harness.db, harness.clock, seller, created.body.proofId, {
      inviteeUserId: buyer,
    });
    expect(invite.proof.status).toBe("AWAITING_PARTICIPANT");
    await expect(
      finalizeProof(harness.db, harness.clock, seller, created.body.proofId),
    ).rejects.toMatchObject({ code: "PROOF_NOT_READY_FOR_FINALIZATION" });

    await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.invitationId);
    const upload = await request(harness.app)
      .post(`/proofs/${created.body.proofId}/evidence/uploads`)
      .set({ ...auth(seller), "Idempotency-Key": "p2p-evidence" })
      .send({ contentType: "video/mp4", evidenceType: "SELLER_EVIDENCE" });
    expect(upload.status).toBe(201);
    const bytes = Buffer.from("p2p-required-evidence");
    await request(harness.app)
      .put(new URL(upload.body.upload.url as string).pathname)
      .set("Content-Type", "video/mp4")
      .send(bytes);
    await request(harness.app)
      .post(`/proofs/${created.body.proofId}/evidence/${upload.body.evidenceId}/commit`)
      .set(auth(seller))
      .send({ sha256: sha256Hex(bytes) });
    const finalized = await request(harness.app)
      .post(`/proofs/${created.body.proofId}/finalize`)
      .set(auth(seller));
    expect(finalized.status).toBe(200);
    expect(finalized.body.proof.status).toBe("FINALIZED");
    expect(finalized.body.proof.participants.some((row: { role: string }) => row.role === "BUYER")).toBe(
      true,
    );
    expect(finalized.body.manifest.manifest).not.toHaveProperty("participationPolicy");
  });
});
