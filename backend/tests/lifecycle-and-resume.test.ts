import { afterAll, beforeAll, describe, it, expect } from "vitest";
import request from "supertest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createHarness,
  createUser,
  auth,
  commitProofEvidence,
  type TestHarness,
} from "./helpers.js";
import { createProof } from "../src/domain/create-proof.js";
import { commitAttestation } from "../src/domain/attestations.js";
import { finalizeProof, getManifest } from "../src/domain/finalize.js";
import { initializeEvidenceUpload, commitEvidence } from "../src/domain/evidence.js";
import {
  storeUploadPart,
  completeUploadParts,
  listUploadParts,
  discardPendingUpload,
  UPLOAD_PART_BYTES,
} from "../src/domain/resumable-upload.js";
import { exportEvidencePackage } from "../src/domain/evidence-review.js";
import {
  getRetentionControls,
  createRetentionHold,
  releaseRetentionHold,
} from "../src/domain/retention-controls.js";
import { sha256Hex } from "../src/hash.js";

describe("receipt lifecycle and resumable capture", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h.close());
  it("resumes verified parts, rejects replacement bytes, and keeps discarded uploads out of a manifest", async () => {
    const seller = await createUser(h),
      stranger = await createUser(h);
    const proof = await createProof(h.db, h.clock, seller, {
      transaction: { itemTitle: "Camera" },
    });
    const init = await initializeEvidenceUpload(
      h.db,
      h.clock,
      h.objectStore,
      seller,
      proof.proofId,
      {
        contentType: "video/mp4",
        evidenceType: "FULFILLMENT_CAPTURE",
        idempotencyKey: "resume",
      },
    );
    const first = Buffer.alloc(UPLOAD_PART_BYTES, 42),
      last = Buffer.from("last-part");
    await storeUploadPart(
      h.db,
      h.clock,
      h.objectStore,
      seller,
      proof.proofId,
      init.evidenceId,
      1,
      first,
    );
    await expect(
      completeUploadParts(
        h.db,
        h.objectStore,
        seller,
        proof.proofId,
        init.evidenceId,
        first.length + last.length,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_INCOMPLETE" });
    expect(
      (await listUploadParts(h.db, seller, proof.proofId, init.evidenceId)).parts,
    ).toHaveLength(1);
    expect(
      (
        await storeUploadPart(
          h.db,
          h.clock,
          h.objectStore,
          seller,
          proof.proofId,
          init.evidenceId,
          1,
          first,
        )
      ).replayed,
    ).toBe(true);
    await expect(
      storeUploadPart(
        h.db,
        h.clock,
        h.objectStore,
        seller,
        proof.proofId,
        init.evidenceId,
        1,
        Buffer.from("replacement"),
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_PART_CONFLICT" });
    await expect(
      listUploadParts(h.db, stranger, proof.proofId, init.evidenceId),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await storeUploadPart(
      h.db,
      h.clock,
      h.objectStore,
      seller,
      proof.proofId,
      init.evidenceId,
      2,
      last,
    );
    const complete = await completeUploadParts(
      h.db,
      h.objectStore,
      seller,
      proof.proofId,
      init.evidenceId,
      first.length + last.length,
    );
    expect(complete.sha256).toBe(sha256Hex(Buffer.concat([first, last])));
    await commitEvidence(
      h.db,
      h.clock,
      h.objectStore,
      seller,
      proof.proofId,
      init.evidenceId,
      complete.sha256,
    );
    await expect(
      discardPendingUpload(h.db, h.clock, seller, proof.proofId, "resume"),
    ).rejects.toMatchObject({ code: "EVIDENCE_ALREADY_COMMITTED" });
    const abandoned = await initializeEvidenceUpload(
      h.db,
      h.clock,
      h.objectStore,
      seller,
      proof.proofId,
      { contentType: "video/mp4", idempotencyKey: "discard" },
    );
    await discardPendingUpload(h.db, h.clock, seller, proof.proofId, "discard");
    await expect(
      commitEvidence(h.db, h.clock, h.objectStore, seller, proof.proofId, abandoned.evidenceId),
    ).rejects.toMatchObject({ code: "EVIDENCE_UPLOAD_DISCARDED" });
    await commitAttestation(h.db, h.clock, seller, proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });
    const final = await finalizeProof(h.db, h.clock, seller, proof.proofId);
    expect((final.manifest.manifest as { evidence: unknown[] }).evidence).toHaveLength(1);
  });
  it("binds an invited receiver, preserves all three stage manifests and verifies the portable package offline", async () => {
    const seller = await createUser(h),
      buyer = await createUser(h),
      other = await createUser(h);
    const proof = await createProof(h.db, h.clock, seller, {
      transaction: { itemTitle: "Collectible" },
    });
    await commitProofEvidence(h, seller, proof.proofId, {
      evidenceType: "FULFILLMENT_CAPTURE",
      contentType: "video/mp4",
    });
    await commitAttestation(h.db, h.clock, seller, proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });
    const frozen = await finalizeProof(h.db, h.clock, seller, proof.proofId);
    const base = `/proofs/${proof.proofId}/lifecycle`;
    expect(
      (await request(h.app).post(`${base}/receiver`).set(auth(seller)).send({ userId: buyer }))
        .status,
    ).toBe(201);
    expect(
      (await request(h.app).post(`${base}/receiver`).set(auth(seller)).send({ userId: other }))
        .status,
    ).toBe(409);
    expect((await request(h.app).post(`${base}/accept`).set(auth(other)).send({})).status).toBe(
      404,
    );
    expect((await request(h.app).post(`${base}/accept`).set(auth(buyer)).send({})).status).toBe(
      200,
    );
    expect(
      (await request(h.app).post(`${base}/stages`).set(auth(seller)).send({ type: "RECEIPT" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(h.app)
          .post(`${base}/stages`)
          .set(auth(buyer))
          .send({ type: "RETURN_PACKING" })
      ).status,
    ).toBe(409);
    for (const [type, actor, statement] of [
      ["RECEIPT", buyer, "I_RECORDED_RECEIPT"],
      ["RETURN_PACKING", buyer, "I_PACKED_RETURN"],
      ["RETURN_RECEIPT", seller, "I_RECEIVED_RETURN"],
    ]) {
      const stage = await request(h.app).post(`${base}/stages`).set(auth(actor)).send({ type });
      expect(stage.status, JSON.stringify(stage.body)).toBe(201);
      const stageId = stage.body.stageId;
      if (type === "RECEIPT") {
        const abandoned = await request(h.app)
          .post(`${base}/stages/${stageId}/evidence`)
          .set(auth(actor))
          .set("Idempotency-Key", "abandoned-stage-upload")
          .send({ contentType: "video/mp4" });
        expect(abandoned.status).toBe(201);
        const discardPath = `${base}/stages/${stageId}/evidence/${abandoned.body.evidenceId}/discard`;
        expect((await request(h.app).post(discardPath).set(auth(seller)).send({})).status).toBe(
          404,
        );
        expect((await request(h.app).post(discardPath).set(auth(actor)).send({})).status).toBe(200);
        expect((await request(h.app).post(discardPath).set(auth(actor)).send({})).status).toBe(200);
        expect(
          (
            await request(h.app)
              .post(`${base}/stages/${stageId}/evidence/${abandoned.body.evidenceId}/commit`)
              .set(auth(actor))
              .send({})
          ).status,
        ).toBe(404);
      }
      const upload = await request(h.app)
        .post(`${base}/stages/${stageId}/evidence`)
        .set(auth(actor))
        .set("Idempotency-Key", "media")
        .send({ contentType: "video/mp4" });
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      const bytes = Buffer.from(`${type}-recording`);
      await h.objectStore.putUpload(
        new URL(upload.body.upload.url).pathname.split("/").at(-1)!,
        bytes,
        "video/mp4",
      );
      const committed = await request(h.app)
        .post(`${base}/stages/${stageId}/evidence/${upload.body.evidenceId}/commit`)
        .set(auth(actor))
        .send({ sha256: sha256Hex(bytes) });
      expect(committed.status, JSON.stringify(committed.body)).toBe(200);
      expect(
        (
          await request(h.app)
            .post(`${base}/stages/${stageId}/finalize`)
            .set(auth(actor))
            .send({ statement: "made up" })
        ).status,
      ).toBe(400);
      const final = await request(h.app)
        .post(`${base}/stages/${stageId}/finalize`)
        .set(auth(actor))
        .send({ statement });
      expect(final.status, JSON.stringify(final.body)).toBe(200);
      expect(final.body.manifest.baseManifestSha256).toBe(frozen.manifest.sha256);
      expect(
        (
          await request(h.app)
            .post(`${base}/stages/${stageId}/finalize`)
            .set(auth(actor))
            .send({ statement })
        ).body,
      ).toEqual(final.body);
      await expect(
        h.db.query("UPDATE commerce_stages SET sha256='changed' WHERE id=$1", [stageId]),
      ).rejects.toThrow("COMMERCE_STAGE_IMMUTABLE");
    }
    expect(await getManifest(h.db, seller, proof.proofId)).toEqual(frozen.manifest);
    const bundle = await exportEvidencePackage(h.db, h.clock, h.objectStore, seller, proof.proofId);
    const dir = await mkdtemp(path.join(tmpdir(), "pkpr-verify-"));
    try {
      const file = path.join(dir, "proof.pkpr");
      await writeFile(file, bundle);
      const verified = JSON.parse(
        execFileSync(
          "python3",
          [
            "scripts/verify-proof-package.py",
            file,
            "--expected-manifest-sha256",
            frozen.manifest.sha256,
          ],
          { encoding: "utf8" },
        ),
      );
      expect(verified.independentDigestMatched).toBe(true);
      expect(verified.evidenceVerified).toBe(1);
      const tampered = Buffer.from(bundle);
      const offset = tampered.indexOf(Buffer.from("RECEIPT-recording"));
      expect(offset).toBeGreaterThan(0);
      tampered[offset] ^= 1;
      await writeFile(file, tampered);
      expect(() =>
        execFileSync("python3", ["scripts/verify-proof-package.py", file], {
          stdio: "pipe",
        }),
      ).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const hold = await createRetentionHold(h.db, h.clock, seller, proof.proofId, "Open claim");
    expect((await getRetentionControls(h.db, h.clock, seller, proof.proofId)).blockers).toContain(
      "Active retention hold",
    );
    await expect(
      releaseRetentionHold(h.db, h.clock, other, proof.proofId, hold.id),
    ).rejects.toBeDefined();
    await releaseRetentionHold(h.db, h.clock, seller, proof.proofId, hold.id);
    expect(
      (await getRetentionControls(h.db, h.clock, seller, proof.proofId)).automaticDeletion,
    ).toBe(false);
  });
});
