import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSellerChallenge, recordedSellerAuthorization } from "../../mobile/src/attestation/authorization";
import { SELLER_SHIPPING_STATEMENT } from "../../mobile/src/attestation/statement";
import type { ProofView } from "../../mobile/src/v2-api";

const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
const expected = { proofId: "proof_1", userId: "seller_1", captureSessionId: "capture_1", sha256: "a".repeat(64), publicKey };
const expiresAt = "2026-09-07T22:00:00.000Z";
const payload = { version: 1, method: "ANDROID_BIOMETRIC_STRONG", challengeId: "challenge_1", nonce: "b".repeat(64), actorUserId: expected.userId, proofId: expected.proofId, captureSessionId: expected.captureSessionId, sha256: expected.sha256, statement: SELLER_SHIPPING_STATEMENT, publicKeySha256: createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex"), expiresAt };
const challenge = { challengeId: payload.challengeId, payload: JSON.stringify(payload), expiresAt };
const now = Date.parse("2026-09-06T22:00:00.000Z");

describe("seller statement challenge binding before Android authentication", () => {
  it("accepts the server payload for this exact account, original, statement, and key", () => {
    expect(() => validateSellerChallenge(challenge, expected, now)).not.toThrow();
  });
  it.each([
    ["actorUserId", "another-seller"], ["proofId", "another-proof"], ["captureSessionId", "retaken-video"],
    ["sha256", "c".repeat(64)], ["statement", "A different assertion"], ["publicKeySha256", "d".repeat(64)],
    ["method", "DEVICE_CREDENTIAL"], ["version", 2], ["nonce", ""], ["challengeId", "another-challenge"],
  ])("rejects a mismatched %s before requesting a signature", (field, value) => {
    expect(() => validateSellerChallenge({ ...challenge, payload: JSON.stringify({ ...payload, [field]: value }) }, expected, now)).toThrow();
  });
  it("rejects expired and malformed challenges", () => {
    expect(() => validateSellerChallenge(challenge, expected, Date.parse(expiresAt))).toThrow();
    expect(() => validateSellerChallenge({ ...challenge, payload: "null" }, expected, now)).toThrow();
    expect(() => validateSellerChallenge({ ...challenge, payload: "{" }, expected, now)).toThrow();
  });
  it("does not reuse a legacy, unrelated, pending, or another seller's attestation", () => {
    const receipt = { challengeId: "challenge_1", signature: "signed", signatureVerification: "SERVER_VERIFIED", method: "ANDROID_BIOMETRIC_STRONG" };
    const proof = { evidence: [{ evidenceId: "evidence_1", validationStatus: "COMMITTED" }], attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "seller_1", relatedEvidenceId: "evidence_1", authorization: receipt }] } as unknown as ProofView;
    expect(recordedSellerAuthorization(proof, "evidence_1", "seller_1")).toEqual({ challengeId: "challenge_1", signature: "signed" });
    expect(recordedSellerAuthorization(proof, "different-original", "seller_1")).toBeNull();
    expect(recordedSellerAuthorization(proof, "evidence_1", "another-seller")).toBeNull();
    expect(recordedSellerAuthorization({ ...proof, evidence: [] }, "evidence_1", "seller_1")).toBeNull();
    expect(recordedSellerAuthorization({ ...proof, attestations: proof.attestations!.map(row => ({ ...row, authorization: undefined })) }, "evidence_1", "seller_1")).toBeNull();
  });
});
