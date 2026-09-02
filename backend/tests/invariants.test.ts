import { afterEach, describe, expect, it } from "vitest";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { DomainError, errorCodeFromSql } from "../src/domain/errors.js";
import {
  commitEvidence,
  initializeEvidenceUpload,
} from "../src/domain/evidence.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { createTransaction } from "../src/domain/transactions.js";
import { commitFulfillmentAndAttest, createHarness, createUser, type TestHarness } from "./helpers.js";

describe("PackProof V2 domain invariants", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("one transaction cannot have two proofs, including under retry", async () => {
    harness = await createHarness();
    const seller = await createUser(harness);
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "ext-1",
      metadata: { item: "camera" },
    });
    const againTxn = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "ext-1",
      metadata: { item: "ignored" },
    });
    expect(againTxn.transactionId).toBe(txn.transactionId);

    const first = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    const second = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    expect(second.proofId).toBe(first.proofId);

    const duplicate = harness.db.query(
      `INSERT INTO proofs (id, transaction_id, status, created_at, updated_at, version)
       VALUES ($1, $2, 'OPEN', $3, $3, 1)`,
      ["proof_duplicate", txn.transactionId, harness.clock.now().toISOString()],
    );
    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      return (
        String((error as { code?: string }).code ?? "") === "23505" ||
        /unique|duplicate/i.test(error instanceof Error ? error.message : String(error))
      );
    });

    const count = await harness.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM proofs WHERE transaction_id = $1`,
      [txn.transactionId],
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it("invitation creation and acceptance are idempotent and do not duplicate participants", async () => {
    harness = await createHarness();
    const seller = await createUser(harness);
    const buyer = await createUser(harness);
    const txn = await createTransaction(harness.db, harness.clock, seller, {});
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);

    const invite1 = await createInvitation(
      harness.db,
      harness.clock,
      seller,
      proof.proofId,
      "buyer@example.com",
    );
    const invite2 = await createInvitation(
      harness.db,
      harness.clock,
      seller,
      proof.proofId,
      "buyer@example.com",
    );
    expect(invite2.invitation.invitationId).toBe(invite1.invitation.invitationId);
    expect(invite2.invitation.token).toBe(invite1.invitation.token);
    expect(invite2.proof.status).toBe("READY_FOR_EVIDENCE");
    expect(invite2.proof.participationPolicy).toBe("COUNTERPARTY_OPTIONAL");

    const accept1 = await acceptInvitation(
      harness.db,
      harness.clock,
      buyer,
      invite1.invitation.token,
    );
    const accept2 = await acceptInvitation(
      harness.db,
      harness.clock,
      buyer,
      invite1.invitation.token,
    );
    expect(accept2.proof.proofId).toBe(proof.proofId);
    expect(accept1.proof.participants.filter((p) => p.role === "BUYER")).toHaveLength(1);
    expect(accept2.proof.participants.filter((p) => p.role === "BUYER")).toHaveLength(1);
    expect(accept2.proof.participants.find((p) => p.role === "BUYER")?.userId).toBe(buyer);
    expect(accept2.proof.status).toBe("READY_FOR_EVIDENCE");
  });

  it("invalid transitions are rejected and evidence cannot mutate after commitment", async () => {
    harness = await createHarness();
    const seller = await createUser(harness);
    const buyer = await createUser(harness);
    const txn = await createTransaction(harness.db, harness.clock, seller, {});
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);

    await expect(
      finalizeProof(harness.db, harness.clock, seller, proof.proofId),
    ).rejects.toMatchObject({
      code: "FULFILLMENT_CAPTURE_REQUIRED",
    } satisfies Partial<DomainError>);

    const invite = await createInvitation(
      harness.db,
      harness.clock,
      seller,
      proof.proofId,
      "buyer@example.com",
    );
    await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.token);

    await expect(
      finalizeProof(harness.db, harness.clock, seller, proof.proofId),
    ).rejects.toMatchObject({ code: "FULFILLMENT_CAPTURE_REQUIRED" });

    const upload = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      {
        contentType: "video/mp4",
        idempotencyKey: "capture-1",
      },
    );
    const retryUpload = await initializeEvidenceUpload(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      {
        contentType: "video/mp4",
        idempotencyKey: "capture-1",
      },
    );
    expect(retryUpload.evidenceId).toBe(upload.evidenceId);

    const bytes = Buffer.from("packproof-evidence-bytes");
    await harness.objectStore.put(upload.objectKey, bytes, "video/mp4");
    const commit1 = await commitEvidence(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      upload.evidenceId,
    );
    const commit2 = await commitEvidence(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      proof.proofId,
      upload.evidenceId,
    );
    expect(commit2.sha256).toBe(commit1.sha256);
    expect(commit2.evidenceId).toBe(commit1.evidenceId);

    const mutation = harness.db.query(
      `UPDATE evidence SET sha256 = $2 WHERE id = $1`,
      [upload.evidenceId, "0".repeat(64)],
    );
    await expect(mutation).rejects.toSatisfy((error: unknown) => {
      return errorCodeFromSql(error) === "EVIDENCE_ALREADY_COMMITTED";
    });
    await expect(
      harness.db.query(`UPDATE evidence SET content_type = $2 WHERE id = $1`, [
        upload.evidenceId,
        "image/jpeg",
      ]),
    ).rejects.toSatisfy((error: unknown) => {
      return errorCodeFromSql(error) === "EVIDENCE_ALREADY_COMMITTED";
    });
    await expect(
      harness.db.query(`DELETE FROM evidence WHERE id = $1`, [upload.evidenceId]),
    ).rejects.toSatisfy((error: unknown) => {
      return errorCodeFromSql(error) === "EVIDENCE_ALREADY_COMMITTED";
    });
  });

  it("finalization is idempotent and finalized proofs cannot mutate", async () => {
    harness = await createHarness();
    const seller = await createUser(harness);
    const buyer = await createUser(harness);
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      metadata: { sku: "ABC" },
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
    await commitFulfillmentAndAttest(harness, seller, proof.proofId, {
      bytes: Buffer.from("final-bytes"),
      idempotencyKey: "capture-1",
    });

    const first = await finalizeProof(harness.db, harness.clock, seller, proof.proofId);
    const second = await finalizeProof(harness.db, harness.clock, seller, proof.proofId);
    expect(second.manifest.sha256).toBe(first.manifest.sha256);
    expect(second.manifest.canonicalJson).toBe(first.manifest.canonicalJson);
    expect(second.manifest.manifestId).toBe(first.manifest.manifestId);
    expect(second.proof.status).toBe("FINALIZED");

    const manifestCount = await harness.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM final_manifests WHERE proof_id = $1`,
      [proof.proofId],
    );
    expect(Number(manifestCount.rows[0].n)).toBe(1);

    await expect(
      createInvitation(harness.db, harness.clock, seller, proof.proofId, "other@example.com"),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });

    await expect(
      initializeEvidenceUpload(
        harness.db,
        harness.clock,
        harness.objectStore,
        seller,
        proof.proofId,
        { contentType: "video/mp4", idempotencyKey: "capture-2" },
      ),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });

    const sqlMutate = harness.db.query(
      `UPDATE proofs SET status = 'OPEN' WHERE id = $1`,
      [proof.proofId],
    );
    await expect(sqlMutate).rejects.toSatisfy((error: unknown) => {
      return errorCodeFromSql(error) === "PROOF_ALREADY_FINALIZED";
    });

    const audit = await harness.db.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE proof_id = $1 ORDER BY created_at ASC`,
      [proof.proofId],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "PROOF_CREATED",
        "PARTICIPANT_JOINED",
        "PARTICIPANT_INVITED",
        "EVIDENCE_UPLOAD_CREATED",
        "EVIDENCE_COMMITTED",
        "PROOF_FINALIZED",
      ]),
    );
  });
});
