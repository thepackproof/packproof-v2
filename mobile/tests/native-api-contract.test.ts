import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createHarness } from "../../backend/tests/helpers.ts";
import { PackProofV2Client } from "../src/v2-api.ts";

test("native camera session, retry identity, original replay and reviewed case export use canonical HTTP contracts", async () => {
  const harness = await createHarness();
  const server = harness.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let token = "";
  const client = new PackProofV2Client({ baseUrl, getToken: () => token });
  try {
    const login = await client.login("native-contract-seller");
    token = login.token;
    const txn = await client.createTransaction({
      itemTitle: "Camera test item",
      externalReference: "native-contract-order",
    });
    const proof = await client.createOrGetProof(txn.transactionId);
    await assert.rejects(
      client.initializeEvidenceUpload(proof.proofId, {
        contentType: "video/mp4",
        evidenceType: "FULFILLMENT_CAPTURE",
        idempotencyKey: "no-session",
      }),
    );
    const session = await client.createCaptureSession(
      proof.proofId,
      "before-recording",
    );
    assert.equal(session.proofId, proof.proofId);
    const label = await client.bindCaptureShipping(proof.proofId, session.id, {
      rawValue: "1Z999AA10123456784", format: "CODE_128", detectedAtMs: 100, idempotencyKey: "native-label",
    });
    assert.equal(label.status,"BOUND");
    assert.equal(label.proofId,proof.proofId);
    const sameSession = await client.createCaptureSession(
      proof.proofId,
      "before-recording",
    );
    assert.equal(sameSession.id, session.id);
    const bytes = await readFile(
      new URL(
        "../../backend/tests/fixtures/camera-recording.mp4",
        import.meta.url,
      ),
    );
    const intent = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      contentType: "video/mp4",
    };
    await client.completeCaptureSession(proof.proofId, session.id, {
      ...intent,
      interrupted: true,
      recordedDurationMs: 200,
    });
    const retriedSession = await client.completeCaptureSession(proof.proofId, session.id, {
      ...intent,
      interrupted: false,
      recordedDurationMs: 200,
    }) as { clientReportedCapture: { interrupted: boolean; recordedDurationMs: number; provenance: string } };
    assert.equal(retriedSession.clientReportedCapture.interrupted, true);
    assert.equal(retriedSession.clientReportedCapture.recordedDurationMs, 200);
    assert.equal(retriedSession.clientReportedCapture.provenance, "CLIENT_REPORTED_NOT_INDEPENDENTLY_VERIFIED");
    await assert.rejects(client.completeCaptureSession(proof.proofId, session.id, {
      ...intent,
      recordedDurationMs: 201,
    }));
    await assert.rejects(
      client.completeCaptureSession(proof.proofId, session.id, {
        ...intent,
        sha256: "0".repeat(64),
      }),
    );
    const init = await client.initializeEvidenceUpload(proof.proofId, {
      ...intent,
      evidenceType: "FULFILLMENT_CAPTURE",
      captureSessionId: session.id,
      idempotencyKey: "native-recording",
    });
    const upload = new URL(init.upload.url, baseUrl);
    await client.uploadObject(
      { ...init.upload, url: `${upload.pathname}${upload.search}` },
      bytes,
      intent.contentType,
    );
    await client.commitEvidence(proof.proofId, init.evidenceId);
    await client.commitEvidence(proof.proofId, init.evidenceId);
    const anchor = await client.signatureRequest<{ anchorId: string }>(
      proof.proofId,
      "/anchors",
      "POST",
      {
        evidenceId: init.evidenceId,
        label: "Identifier",
        startMs: 0,
        endMs: 100,
        sourceType: "USER_MARKED",
        idempotencyKey: "native-bookmark",
      },
    );
    const view = await client.signatureRequest<{
      snapshot: {
        snapshotId: string;
        data: { anchors: Array<{ anchorId: string }> };
      };
    }>(proof.proofId);
    assert(
      view.snapshot.data.anchors.some(
        (item) => item.anchorId === anchor.anchorId,
      ),
    );
    const answer = await client.signatureRequest<{
      state: string;
      citations: Array<{ id: string }>;
    }>(proof.proofId, "/ask", "POST", {
      snapshotId: view.snapshot.snapshotId,
      question: "Where is the identifier shown?",
    });
    assert.equal(answer.state, "SUPPORTED");
    assert(answer.citations.some((item) => item.id === anchor.anchorId));
    const missing = await client.signatureRequest<{ state: string }>(
      proof.proofId,
      "/ask",
      "POST",
      {
        snapshotId: view.snapshot.snapshotId,
        question: "Is the seller guilty of fraud?",
      },
    );
    assert.equal(missing.state, "NOT_ESTABLISHED");
    const packet = await client.signatureRequest<{
      caseId: string;
      sha256: string;
    }>(proof.proofId, "/cases", "POST", {
      snapshotId: view.snapshot.snapshotId,
      template: "WRONG_ITEM",
    });
    await assert.rejects(
      client.signatureRequest(proof.proofId, `/cases/${packet.caseId}/export`),
    );
    await client.signatureRequest(
      proof.proofId,
      `/cases/${packet.caseId}/approve`,
      "POST",
      { previewSha256: packet.sha256 },
    );
    const exported = await client.signatureRequest<{ previewSha256: string }>(
      proof.proofId,
      `/cases/${packet.caseId}/export`,
    );
    assert.equal(exported.previewSha256, packet.sha256);
    const preview = await client.disclosureRequest<{
      disclosure: { viewHash: string };
      evidence: unknown[];
    }>(proof.proofId, "/preview", "POST", {
      purpose: "BUYER_RECEIPT",
      fields: ["status", "order", "shipping"],
      media: [],
    });
    assert.equal(preview.evidence.length, 0);
    const grant = await client.disclosureRequest<{
      accessLinkId: string;
      url: string;
    }>(proof.proofId, "/grants", "POST", {
      purpose: "BUYER_RECEIPT",
      fields: ["status", "order", "shipping"],
      media: [],
      previewHash: preview.disclosure.viewHash,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert(grant.url);
    await client.revokeAccessLink(proof.proofId, grant.accessLinkId);
    assert(
      (await client.listAccessLinks(proof.proofId)).accessLinks.some(
        (item) => item.accessLinkId === grant.accessLinkId && item.revokedAt,
      ),
    );
    await client.createAttestation(proof.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
      relatedEvidenceId: init.evidenceId,
    });
    const sealed = await client.finalizeProof(proof.proofId);
    let buyerToken = "";
    const buyer = new PackProofV2Client({
      baseUrl,
      getToken: () => buyerToken,
    });
    const buyerLogin = await buyer.login("native-contract-buyer");
    buyerToken = buyerLogin.token;
    await client.lifecycleRequest(proof.proofId, "/receiver", "POST", {
      userId: buyerLogin.userId,
    });
    await buyer.lifecycleRequest(proof.proofId, "/accept", "POST", {});
    const stage = await buyer.lifecycleRequest<{ stageId: string }>(
      proof.proofId,
      "/stages",
      "POST",
      { type: "RECEIPT" },
    );
    await assert.rejects(
      client.createCaptureSession(
        proof.proofId,
        "wrong-stage-actor",
        stage.stageId,
      ),
    );
    const stageSession = await buyer.createCaptureSession(
      proof.proofId,
      "receipt-before-recording",
      stage.stageId,
    );
    await buyer.completeCaptureSession(proof.proofId, stageSession.id, intent);
    const stageInit = await buyer.lifecycleRequest<{
      evidenceId: string;
      upload: { method: "PUT"; url: string; headers: Record<string, string> };
    }>(proof.proofId, `/stages/${stage.stageId}/evidence`, "POST", {
      contentType: "video/mp4",
      idempotencyKey: "receipt-recording",
      captureSessionId: stageSession.id,
    });
    await buyer.uploadObject(stageInit.upload, bytes, "video/mp4");
    await buyer.lifecycleRequest(
      proof.proofId,
      `/stages/${stage.stageId}/evidence/${stageInit.evidenceId}/commit`,
      "POST",
      {},
    );
    await buyer.lifecycleRequest(
      proof.proofId,
      `/stages/${stage.stageId}/finalize`,
      "POST",
      { statement: "I_RECORDED_RECEIPT" },
    );
    assert.equal(
      (await client.getManifest(proof.proofId)).sha256,
      sealed.manifest.sha256,
    );
    const final = await client.getProof(proof.proofId);
    assert.equal(
      final.evidence.find((item) => item.evidenceId === init.evidenceId)
        ?.sha256,
      intent.sha256,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await harness.close();
  }
});
