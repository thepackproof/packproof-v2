import { requireCaptureCapabilities } from "../src/capture/capabilities";
import test from "node:test";
import assert from "node:assert/strict";
import { recoverCaptureCompletion, type CompletionCapture, type CompletionDeps, type CompletionProof } from "../src/capture/recover-completion";
import { captureRecoveryLabel, mayCleanUpCapture, recoveryRetry, sameCaptureAccount, type ProofRecovery, type DurableReceipt } from "../src/capture/recovery-model";
function fixture() {
  const receipt = (operationId: string): DurableReceipt => ({ operationId, eventSha256: "a".repeat(64), envelopeSha256: "b".repeat(64), objectKey: "protected/receipt", objectVersionId: "v1", preservedAt: "2026-09-07T00:00:00Z", signature: "signed" });
  const capture: CompletionCapture = { captureSha256: "c".repeat(64), recovery: { version: 1, operationId: "cap_1", apiBaseUrl: "https://example.test", userId: "seller", proofId: "proof", phase: "UPLOAD_QUEUED", evidenceIdempotencyKey: "stable-key", submitRequested: true, needsSellerAttestation: true, attempt: 0, nextRetryAt: null, authorization: { challengeId: "challenge", signature: "same-native-signature", expiresAt: "2099-01-01T00:00:00Z", sha256: "c".repeat(64) }, updatedAt: "2026-09-07T00:00:00Z" } };
  const proof: CompletionProof = { proofId: "proof", status: "READY_FOR_EVIDENCE", evidence: [], attestations: [] };
  const server: ProofRecovery = { proofId: "proof", evidence: [], declarations: [], finalization: { operationId: null, status: "LEGACY_UNCONFIRMED", receipt: null } };
  const calls: string[] = []; let account = "seller"; let durable = true;
  const deps: CompletionDeps = {
    assertAccount() { if (account !== "seller") throw Object.assign(new Error("Sign in again"), { code: "ACCOUNT_CHANGED" }); },
    async save() { calls.push(`save:${capture.recovery.phase}`); },
    async getProof() { calls.push("read-proof"); return structuredClone(proof); },
    async getRecovery() { calls.push("read-recovery"); return structuredClone(server); },
    async initialize(key) { assert.equal(key, "stable-key"); assert.equal(calls.at(-1), "save:UPLOAD_QUEUED"); calls.push("initialize"); return "video"; },
    async upload() { assert.equal(capture.uploadEvidenceId, "video"); assert.equal(calls.at(-1), "save:UPLOADING"); calls.push("upload"); },
    async commit() { assert.equal(calls.at(-1), "save:BYTES_RECEIVED"); calls.push("commit"); proof.status = "EVIDENCE_COMMITTED"; proof.evidence = [{ evidenceId: "video", validationStatus: "COMMITTED" }]; server.evidence = [{ evidenceId: "video", operationId: "preserve", status: durable ? "PRESERVED" : "COMMITTED_PENDING_DURABILITY", receipt: durable ? receipt("preserve") : null }]; },
    async attest(id, auth) { calls.push("attest"); assert.equal(id, "video"); assert.deepEqual(auth, capture.recovery.authorization); proof.attestations!.push({ attestedBy: "seller", relatedEvidenceId: "video", authorization: { signatureVerification: "SERVER_VERIFIED", method: "ANDROID_BIOMETRIC_STRONG" } }); return { attestationId: "declaration" }; },
    async finalize() { assert.equal(calls.at(-1), "save:FINALIZATION_PENDING"); calls.push("finalize"); proof.status = "FINALIZED"; server.finalization = { operationId: "final", status: "PRESERVED", receipt: receipt("final") }; },
  };
  return { capture, proof, server, calls, deps, receipt, setAccount: (value: string) => { account = value; }, setDurability: (value: boolean) => { durable = value; } };
}
test("write intents precede effects; cleanup requires both authoritative receipts", async () => {
  const f = fixture(); await recoverCaptureCompletion(f.capture, f.deps);
  assert.deepEqual(f.calls.slice(0, 2), ["read-proof", "read-recovery"]);
  assert.equal(f.capture.recovery.phase, "FINALIZED"); assert.equal(mayCleanUpCapture(f.capture.recovery), true);
  f.capture.recovery.lastServerResult!.finalization.receipt = null; assert.equal(mayCleanUpCapture(f.capture.recovery), false);
});
test("lost commit response resumes exact evidence without another upload", async () => {
  const f = fixture(); const commit = f.deps.commit;
  f.deps.commit = async id => { await commit(id); throw Object.assign(new Error("response lost"), { status: 503 }); };
  await assert.rejects(recoverCaptureCompletion(f.capture, f.deps)); assert.equal(f.capture.uploadEvidenceId, "video");
  f.deps.commit = commit; await recoverCaptureCompletion(f.capture, f.deps);
  assert.equal(f.calls.filter(c => c === "upload").length, 1); assert.equal(f.calls.filter(c => c === "commit").length, 1);
});
test("lost declaration response recovers accepted signature even after local challenge expiry", async () => {
  const f = fixture(); const attest = f.deps.attest;
  f.deps.attest = async (id, auth) => { await attest(id, auth); throw new Error("response lost"); };
  await assert.rejects(recoverCaptureCompletion(f.capture, f.deps));
  f.capture.recovery.authorization!.expiresAt = "2020-01-01T00:00:00Z";
  await recoverCaptureCompletion(f.capture, f.deps);
  assert.equal(f.calls.filter(c => c === "attest").length, 1); assert.equal(f.capture.recovery.phase, "FINALIZED");
});
test("pending durability keeps a truthful phase and local bytes; later retry finalizes", async () => {
  const f = fixture(); f.setDurability(false);
  await assert.rejects(recoverCaptureCompletion(f.capture, f.deps), { code: "PRESERVATION_PENDING" });
  assert.equal(f.capture.recovery.phase, "PRESERVATION_PENDING"); assert.equal(captureRecoveryLabel(f.capture.recovery.phase), "Recording received. Preservation in progress.");
  assert.equal(mayCleanUpCapture(f.capture.recovery), false); assert.equal(f.calls.includes("finalize"), false);
  f.server.evidence[0].status = "PRESERVED"; f.server.evidence[0].receipt = f.receipt("preserve");
  await recoverCaptureCompletion(f.capture, f.deps); assert.equal(f.calls.filter(c => c === "upload").length, 1);
});
test("account change after initialize stops upload and retains original account journal", async () => {
  const f = fixture(); const initialize = f.deps.initialize;
  f.deps.initialize = async key => { const id = await initialize(key); f.setAccount("other"); return id; };
  await assert.rejects(recoverCaptureCompletion(f.capture, f.deps), { code: "ACCOUNT_CHANGED" });
  assert.equal(f.calls.includes("upload"), false); assert.equal(f.capture.recovery.userId, "seller"); assert.equal(f.capture.recovery.phase, "NEEDS_SIGN_IN");
});
test("expired unaccepted declaration requires explicit new confirmation without retake", async () => {
  const f = fixture(); f.capture.uploadEvidenceId = "video"; f.proof.evidence = [{ evidenceId: "video", validationStatus: "COMMITTED" }]; f.proof.status = "EVIDENCE_COMMITTED";
  f.capture.recovery.authorization!.expiresAt = "2020-01-01T00:00:00Z";
  await assert.rejects(recoverCaptureCompletion(f.capture, f.deps), { code: "ATTESTATION_CONFIRMATION_NEEDED" });
  assert.equal(f.capture.recovery.phase, "NEEDS_ATTENTION"); assert.equal(f.capture.uploadEvidenceId, "video"); assert.equal(f.calls.includes("attest"), false);
});
test("bounded retry jitter and account checks prevent retry storms or cross-account disclosure", () => {
  assert.equal(recoveryRetry({ status: 401 }, 0).nextRetryAt, null); assert.equal(recoveryRetry({ status: 413 }, 0).retryable, false);
  assert.equal(recoveryRetry({ code: "BIOMETRIC_LOCKED_OUT" }, 0).retryable, false); assert.equal(recoveryRetry({ status: 503 }, 100, 1000, 1).nextRetryAt, 376000);
  assert.equal(sameCaptureAccount({ userId: "seller", apiBaseUrl: "https://example.test" }, "https://example.test/", "other"), false);
});

test("a stage recording requires its own finalized receipt rather than the frozen root receipt", async () => {
  const f = fixture(); await recoverCaptureCompletion(f.capture, f.deps);
  f.capture.recovery.stageId = "return-stage";
  assert.equal(mayCleanUpCapture(f.capture.recovery), false);
  f.capture.recovery.lastServerResult!.stages = [{ stageId: "return-stage", operationId: "stage-finalize:return-stage", status: "PRESERVED", receipt: f.receipt("stage-finalize:return-stage") }];
  f.capture.recovery.finalizationReceipt = f.receipt("stage-finalize:return-stage");
  assert.equal(mayCleanUpCapture(f.capture.recovery), true);
});

test("new capture rejects malformed, incompatible or unsigned server capability paths before acquisition", () => {
  for (const value of [null, {}, { schemaVersion: 2 }, { schemaVersion: 1, capture: { protocolVersions: [1], maxBytes: 0 } }])
    assert.throws(() => requireCaptureCapabilities(value, true), { code: "CAPABILITY_UPDATE_REQUIRED" });
  const valid = { schemaVersion: 1, capture: { protocolVersions: [1], maxBytes: 250000000 }, preservation: { receiptVersions: [1] }, sellerAttestation: { challengeVersions: [1], statementVersion: 1, methods: ["ANDROID_BIOMETRIC_STRONG"] } };
  assert.equal(requireCaptureCapabilities(valid, true), valid);
  assert.throws(() => requireCaptureCapabilities({ ...valid, sellerAttestation: { ...valid.sellerAttestation, methods: ["PIN"] } }, true), { code: "CAPABILITY_ATTESTATION_REQUIRED" });
});

test("a single-use gateway receipt skips retransmission after a lost upload-completion response", async () => {
  const f = fixture();
  f.deps.initialize = async () => ({ evidenceId: "video", received: true });
  await recoverCaptureCompletion(f.capture, f.deps);
  assert.equal(f.calls.includes("upload"), false);
  assert.equal(f.calls.filter(call => call === "commit").length, 1);
  assert.equal(f.capture.recovery.phase, "FINALIZED");
});
