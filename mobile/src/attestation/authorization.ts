import { sha256 } from "@noble/hashes/sha256";
import { toByteArray } from "base64-js";
import { SELLER_SHIPPING_STATEMENT } from "./statement";
import type { ProofView, SellerAttestationAuthorization } from "../v2-api";

export function validateSellerChallenge(challenge: { challengeId: string; payload: string; expiresAt: string }, expected: {
  proofId: string; userId: string; captureSessionId: string; sha256: string; publicKey: string;
}, now = Date.now()): void {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(challenge.payload); } catch { throw new Error("The attestation could not be prepared. Your recording is saved; try again."); }
  const keyHash = Array.from(sha256(toByteArray(expected.publicKey)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (!payload || payload.version !== 1 || payload.method !== "ANDROID_BIOMETRIC_STRONG" ||
      payload.challengeId !== challenge.challengeId || payload.actorUserId !== expected.userId ||
      payload.proofId !== expected.proofId || payload.captureSessionId !== expected.captureSessionId ||
      payload.sha256 !== expected.sha256 || payload.statement !== SELLER_SHIPPING_STATEMENT ||
      payload.publicKeySha256 !== keyHash || payload.expiresAt !== challenge.expiresAt ||
      typeof payload.nonce !== "string" || !/^[a-f0-9]{64}$/.test(payload.nonce) ||
      !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= now) {
    throw new Error("The attestation does not match this account and recording. Your recording is saved; try again.");
  }
}

/** A saved signature can only recover the same actor and exact committed original. */
export function recordedSellerAuthorization(proof: ProofView, evidenceId: string | undefined, userId: string): SellerAttestationAuthorization | null {
  if (!evidenceId || !proof.evidence.some(item => item.evidenceId === evidenceId && item.validationStatus === "COMMITTED")) return null;
  const row = proof.attestations?.find(item => item.attestedBy === userId && item.relatedEvidenceId === evidenceId &&
    item.statement === "PACKED_DESCRIBED_ITEM" && item.authorization?.signatureVerification === "SERVER_VERIFIED" &&
    item.authorization.method === "ANDROID_BIOMETRIC_STRONG");
  return row?.authorization ? { challengeId: row.authorization.challengeId, signature: row.authorization.signature } : null;
}

/** Owner context for recovery is server-authorized; a different participant or web recording cannot use the native declaration path. */
export function recoverableSellerEvidence(proof: ProofView, evidenceId: string, userId: string) {
  if (!proof.participants.some(person=>person.userId===userId && person.role==="SELLER")) return null;
  return proof.evidence.find(row=>row.evidenceId===evidenceId && row.validationStatus==="COMMITTED" && row.evidenceType==="FULFILLMENT_CAPTURE" && row.submittedBy===userId && row.captureClient==="NATIVE_CAMERA" && Boolean(row.captureSessionId && row.sha256)) ?? null;
}
