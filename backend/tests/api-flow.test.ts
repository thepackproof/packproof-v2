import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sha256Hex } from "../src/hash.js";
import { createApp } from "../src/app.js";
import { BearerUserAdapter } from "../src/auth/adapter.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

describe("PackProof V2 API workflow", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("serves health without authentication", async () => {
    harness = await createHarness();
    const response = await request(harness.app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("serves a safe release identity without authentication or secrets", async () => {
    harness = await createHarness();
    const defaulted = await request(harness.app).get("/meta");
    expect(defaulted.status).toBe(200);
    expect(defaulted.body).toEqual({
      service: "packproof-api",
      environment: "development",
      commit: null,
      version: null,
      image: null,
    });
    expect(JSON.stringify(defaulted.body)).not.toMatch(
      /password|secret|cognito|DATABASE|PACKPROOF_DB|EZTK|EZAK/i,
    );

    const identified = createApp({
      db: harness.db,
      objectStore: harness.objectStore,
      clock: harness.clock,
      auth: new BearerUserAdapter(harness.db),
      publicBaseUrl: "http://127.0.0.1",
      devAuth: true,
      credentialStore: harness.credentialStore,
      releaseIdentity: {
        service: "packproof-api",
        environment: "staging",
        commit: "6216bc339d9f2bed4c1117660924e32c98682f45",
        version: "0.1.0",
        image: "20260831180000",
      },
    });
    const staged = await request(identified).get("/meta");
    expect(staged.status).toBe(200);
    expect(staged.body).toEqual({
      service: "packproof-api",
      environment: "staging",
      commit: "6216bc339d9f2bed4c1117660924e32c98682f45",
      version: "0.1.0",
      image: "20260831180000",
    });
  });

  it("runs the seller/buyer vertical slice and required failure scenarios", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "seller-1");
    const buyer = await login(harness.app, "buyer-1");

    const createdTxn = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ metadata: { listing: "RC-1" } });
    expect(createdTxn.status).toBe(201);
    const transactionId = createdTxn.body.transactionId as string;

    const proof1 = await request(harness.app)
      .post(`/transactions/${transactionId}/proof`)
      .set(auth(seller));
    const proof2 = await request(harness.app)
      .post(`/transactions/${transactionId}/proof`)
      .set(auth(seller));
    expect(proof1.status).toBe(200);
    expect(proof2.body.proofId).toBe(proof1.body.proofId);
    expect(proof1.body.status).toBe("READY_FOR_EVIDENCE");
    expect(proof1.body.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");
    const proofId = proof1.body.proofId as string;

    const invite1 = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeIdentifier: "buyer@example.com" });
    const invite2 = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeIdentifier: "buyer@example.com" });
    expect(invite1.status).toBe(201);
    expect(invite2.body.invitation.invitationId).toBe(invite1.body.invitation.invitationId);
    const token = invite1.body.invitation.token as string;

    const premature = await request(harness.app)
      .post(`/proofs/${proofId}/finalize`)
      .set(auth(seller));
    expect(premature.status).toBe(422);
    expect(premature.body.error.code).toBe("FULFILLMENT_CAPTURE_REQUIRED");

    const accept1 = await request(harness.app)
      .post(`/invitations/${token}/accept`)
      .set(auth(buyer));
    const accept2 = await request(harness.app)
      .post(`/invitations/${token}/accept`)
      .set(auth(buyer));
    expect(accept1.status).toBe(200);
    expect(accept2.body.proof.participants.filter((p: { role: string }) => p.role === "BUYER")).toHaveLength(1);
    expect(accept2.body.proof.status).toBe("READY_FOR_EVIDENCE");

    const asBuyer = await request(harness.app).get(`/proofs/${proofId}`).set(auth(buyer));
    expect(asBuyer.status).toBe(200);
    expect(asBuyer.body.proofId).toBe(proofId);

    const upload1 = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/uploads`)
      .set(auth(seller))
      .set("Idempotency-Key", "seller-capture-1")
      .send({ contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE" });
    const upload2 = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/uploads`)
      .set(auth(seller))
      .set("Idempotency-Key", "seller-capture-1")
      .send({ contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE" });
    expect(upload1.status).toBe(201);
    expect(upload2.body.evidenceId).toBe(upload1.body.evidenceId);
    const evidenceId = upload1.body.evidenceId as string;
    const uploadUrl = new URL(upload1.body.upload.url as string);

    const bytes = Buffer.from("seller-recorded-evidence");
    const put = await request(harness.app)
      .put(uploadUrl.pathname)
      .set("Content-Type", "video/mp4")
      .send(bytes);
    expect(put.status).toBe(200);

    const missingObjectFinalize = await request(harness.app)
      .post(`/proofs/${proofId}/finalize`)
      .set(auth(seller));
    expect(missingObjectFinalize.body.error.code).toBe("PROOF_NOT_READY_FOR_FINALIZATION");

    const mismatch = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/${evidenceId}/commit`)
      .set(auth(seller))
      .send({ sha256: "deadbeef" });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe("EVIDENCE_HASH_MISMATCH");

    const commit1 = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/${evidenceId}/commit`)
      .set(auth(seller))
      .send({ sha256: sha256Hex(bytes) });
    const commit2 = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/${evidenceId}/commit`)
      .set(auth(seller))
      .send({ sha256: sha256Hex(bytes) });
    expect(commit1.status).toBe(200);
    expect(commit2.body.sha256).toBe(commit1.body.sha256);
    expect(commit1.body.proof.status).toBe("EVIDENCE_COMMITTED");

    const attested = await request(harness.app)
      .post(`/proofs/${proofId}/attestations`)
      .set(auth(seller))
      .send({ statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: evidenceId });
    expect(attested.status).toBe(201);

    const finalized1 = await request(harness.app)
      .post(`/proofs/${proofId}/finalize`)
      .set(auth(seller));
    const finalized2 = await request(harness.app)
      .post(`/proofs/${proofId}/finalize`)
      .set(auth(seller));
    expect(finalized1.status).toBe(200);
    expect(finalized2.body.manifest.sha256).toBe(finalized1.body.manifest.sha256);
    expect(finalized1.body.proof.status).toBe("FINALIZED");

    const sellerManifest = await request(harness.app)
      .get(`/proofs/${proofId}/manifest`)
      .set(auth(seller));
    const buyerManifest = await request(harness.app)
      .get(`/proofs/${proofId}/manifest`)
      .set(auth(buyer));
    expect(sellerManifest.status).toBe(200);
    expect(buyerManifest.body.sha256).toBe(sellerManifest.body.sha256);
    expect(buyerManifest.body.canonicalJson).toBe(sellerManifest.body.canonicalJson);
    expect(sellerManifest.body.manifest.evidence[0].sha256).toBe(sha256Hex(bytes));

    const addEvidence = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/uploads`)
      .set(auth(seller))
      .set("Idempotency-Key", "after-final")
      .send({ contentType: "video/mp4" });
    expect(addEvidence.status).toBe(409);
    expect(addEvidence.body.error.code).toBe("PROOF_ALREADY_FINALIZED");

    const inviteAfter = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeIdentifier: "other@example.com" });
    expect(inviteAfter.status).toBe(409);

    const sellerProof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(seller));
    const buyerProof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(buyer));
    expect(sellerProof.body.status).toBe("FINALIZED");
    expect(buyerProof.body.proofId).toBe(sellerProof.body.proofId);
  });
});
