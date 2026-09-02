import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { commitAttestation } from "../src/domain/attestations.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { finalizeProof, getManifest } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { createTransaction, getTransaction } from "../src/domain/transactions.js";
import { sha256Hex } from "../src/hash.js";
import { resolveUploadUrl } from "../../mobile/src/v2-api.ts";
import { auth, createHarness, createUser, type TestHarness } from "./helpers.js";
import { MemoryObjectStore } from "./memory-object-store.js";

async function readyProof(harness: TestHarness, input: { itemTitle: string; tracking: string }) {
  const seller = await createUser(harness);
  const buyer = await createUser(harness);
  const txn = await createTransaction(harness.db, harness.clock, seller, {
    externalReference: "ORD-S3-1",
    itemTitle: input.itemTitle,
    shipping: { carrier: "UPS", trackingNumber: input.tracking },
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
  return { seller, buyer, txn, proof };
}

describe("S3 evidence transport boundary", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("keeps local storage working for initialize, HTTP upload, and commit", async () => {
    harness = await createHarness();
    const { seller, proof } = await readyProof(harness, {
      itemTitle: "Local lens",
      tracking: "1ZLOCAL",
    });
    const initialized = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      { contentType: "video/mp4", idempotencyKey: "local-1" },
    );
    expect(initialized.upload.url).toContain("/upload/");
    const token = new URL(initialized.upload.url).pathname.replace("/upload/", "");
    const uploaded = await request(harness.app)
      .put(`/upload/${token}`)
      .set("Content-Type", "video/mp4")
      .send(Buffer.from("local-http-bytes"));
    expect(uploaded.status).toBe(200);
    const committed = await commitEvidence(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      initialized.evidenceId,
    );
    expect(committed.sha256).toBe(sha256Hex(Buffer.from("local-http-bytes")));
    expect(committed.proof.status).toBe("EVIDENCE_COMMITTED");
  });

  it("uses S3-style authorization without creating a new evidence identity on retry", async () => {
    const store = new MemoryObjectStore();
    harness = await createHarness(undefined, { objectStore: store });
    const { seller, buyer, txn, proof } = await readyProof(harness, {
      itemTitle: "S3 camera",
      tracking: "1ZS3",
    });

    const first = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      store,
      seller,
      proof.proofId,
      { contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE", idempotencyKey: "s3-same" },
    );
    const renewed = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      store,
      seller,
      proof.proofId,
      { contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE", idempotencyKey: "s3-same" },
    );
    expect(renewed.evidenceId).toBe(first.evidenceId);
    expect(renewed.objectKey).toBe(first.objectKey);
    expect(renewed.objectKey).toBe(`evidence/${proof.proofId}/${first.evidenceId}/object`);
    expect(renewed.upload.url).not.toBe(first.upload.url);
    expect(renewed.upload.url).toContain("s3.test");
    expect(store.uploadTargets).toHaveLength(2);

    const stillReady = await createOrGetProof(
      harness.db,
      harness.clock,
      seller,
      txn.transactionId,
    );
    expect(stillReady.proofId).toBe(proof.proofId);
    expect(stillReady.status).toBe("READY_FOR_EVIDENCE");
    expect(stillReady.transaction.itemTitle).toBe("S3 camera");
    expect(stillReady.transaction.shipping?.trackingNumber).toBe("1ZS3");

    await expect(
      commitEvidence(
        harness.db,
        harness.clock,
        store,
        seller,
        proof.proofId,
        first.evidenceId,
      ),
    ).rejects.toMatchObject({ code: "EVIDENCE_OBJECT_MISSING" });

    await store.put(first.objectKey, Buffer.from("wrong-type"), "image/jpeg");
    await expect(
      commitEvidence(
        harness.db,
        harness.clock,
        store,
        seller,
        proof.proofId,
        first.evidenceId,
      ),
    ).rejects.toMatchObject({ code: "EVIDENCE_METADATA_MISMATCH" });

    const bytes = Buffer.from("direct-s3-object");
    await store.put(first.objectKey, bytes, "video/mp4");
    await expect(
      commitEvidence(
        harness.db,
        harness.clock,
        store,
        seller,
        proof.proofId,
        first.evidenceId,
        "deadbeef",
      ),
    ).rejects.toMatchObject({ code: "EVIDENCE_HASH_MISMATCH" });

    const missingAfterInit = await createOrGetProof(
      harness.db,
      harness.clock,
      seller,
      txn.transactionId,
    );
    expect(missingAfterInit.status).toBe("READY_FOR_EVIDENCE");
    expect(missingAfterInit.evidence.filter((item) => item.validationStatus === "COMMITTED")).toHaveLength(
      0,
    );

    const committed = await commitEvidence(
      harness.db,
      harness.clock,
      store,
      seller,
      proof.proofId,
      first.evidenceId,
    );
    const committedAgain = await commitEvidence(
      harness.db,
      harness.clock,
      store,
      seller,
      proof.proofId,
      first.evidenceId,
    );
    expect(committed.sha256).toBe(sha256Hex(bytes));
    expect(committedAgain.sha256).toBe(committed.sha256);
    expect(committedAgain.evidenceId).toBe(committed.evidenceId);
    expect(committed.proof.evidence.filter((item) => item.validationStatus === "COMMITTED")).toHaveLength(
      1,
    );

    const shipping = await getTransaction(harness.db, seller, txn.transactionId);
    expect(shipping.itemTitle).toBe("S3 camera");
    expect(shipping.shipping?.carrier).toBe("UPS");
    expect(shipping.shipping?.trackingNumber).toBe("1ZS3");

    await commitAttestation(harness.db, harness.clock, seller, proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
      relatedEvidenceId: first.evidenceId,
    });
    const finalized = await finalizeProof(harness.db, harness.clock, seller, proof.proofId);
    const finalizedAgain = await finalizeProof(harness.db, harness.clock, seller, proof.proofId);
    expect(finalizedAgain.manifest.sha256).toBe(finalized.manifest.sha256);
    const buyerManifest = await getManifest(harness.db, buyer, proof.proofId);
    expect(buyerManifest.sha256).toBe(finalized.manifest.sha256);
    const manifest = buyerManifest.manifest as {
      evidence: Array<{ sha256: string; objectKey: string }>;
      transaction: { itemTitle: string };
      shipping: { trackingNumber: string };
    };
    expect(manifest.evidence).toHaveLength(1);
    expect(manifest.evidence[0]?.sha256).toBe(committed.sha256);
    expect(manifest.evidence[0]?.objectKey).toBe(first.objectKey);
    expect(JSON.stringify(manifest)).not.toContain("https://");
    expect(manifest.transaction.itemTitle).toBe("S3 camera");
    expect(manifest.shipping.trackingNumber).toBe("1ZS3");

    await expect(
      initializeEvidenceUpload(
        harness.db,
        harness.clock,
        store,
        seller,
        proof.proofId,
        { contentType: "video/mp4", idempotencyKey: "after-final" },
      ),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });
    expect(
      (await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId)).proofId,
    ).toBe(proof.proofId);
  });

  it("does not accept evidence bodies on the local upload route in S3 mode", async () => {
    const store = new MemoryObjectStore();
    harness = await createHarness(undefined, { objectStore: store });
    const { seller, proof } = await readyProof(harness, {
      itemTitle: "No proxy",
      tracking: "1ZNOPROXY",
    });
    const initialized = await request(harness.app)
      .post(`/proofs/${proof.proofId}/evidence/uploads`)
      .set(auth(seller))
      .set("Idempotency-Key", "http-s3-1")
      .send({ contentType: "video/mp4" });
    expect(initialized.status).toBe(201);
    expect(initialized.body.upload.url).toContain("s3.test");
    expect(initialized.body.objectKey).toBe(
      `evidence/${proof.proofId}/${initialized.body.evidenceId}/object`,
    );

    const proxied = await request(harness.app)
      .put("/upload/not-a-local-token")
      .set("Content-Type", "video/mp4")
      .send(Buffer.from("should-not-be-stored"));
    expect(proxied.status).toBe(400);
    expect(proxied.body.error.code).toBe("UPLOAD_NOT_LOCAL");

    const missing = await request(harness.app)
      .post(`/proofs/${proof.proofId}/evidence/${initialized.body.evidenceId}/commit`)
      .set(auth(seller))
      .send({});
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe("EVIDENCE_OBJECT_MISSING");

    await store.put(initialized.body.objectKey, Buffer.from("api-s3-bytes"), "video/mp4");
    const committed = await request(harness.app)
      .post(`/proofs/${proof.proofId}/evidence/${initialized.body.evidenceId}/commit`)
      .set(auth(seller))
      .send({});
    expect(committed.status).toBe(200);
    expect(committed.body.sha256).toBe(sha256Hex(Buffer.from("api-s3-bytes")));
  });
});

describe("mobile S3 upload URL resolution", () => {
  it("passes presigned S3 URLs through unchanged and keeps local upload relative", () => {
    const s3 =
      "https://packproof-v2-evidence.s3.us-east-1.amazonaws.com/evidence/proof_1/evd_1/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
    expect(resolveUploadUrl("http://127.0.0.1:3000", s3)).toBe(s3);
    expect(
      resolveUploadUrl("http://127.0.0.1:3000", "http://10.0.2.2:3000/upload/token"),
    ).toBe("http://127.0.0.1:3000/upload/token");
  });
});
