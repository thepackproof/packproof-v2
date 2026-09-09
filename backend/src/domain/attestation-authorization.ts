import { engineRow } from "../capture/service.js";
import { attestationContext, assertAttestationContextCurrent, readAttestationContext } from "./attestation-context.js";
import { assertShippingReviewComplete } from "./capture-label-review.js";
import { createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import { loadCaptureSession } from "./capture-sessions.js";
import { DomainError } from "./errors.js";
import { assertNotFinalized, loadProof, requireParticipant } from "./proof-access.js";
import { asRequiredIso, type AttestationAuthorization, type EvidenceRow } from "./types.js";

export const SELLER_SHIPPING_STATEMENT = "The item shown and attached in this Proof is the item I am shipping";
const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;

interface ChallengeRow {
  id: string;
  proof_id: string;
  actor_user_id: string;
  capture_session_id: string;
  evidence_sha256: string;
  public_key_base64: string;
  public_key_sha256: string;
  payload: string;
  created_at: string | Date;
  expires_at: string | Date;
  consumed_at: string | Date | null;
  attestation_id: string | null;
}

/** Reject extra fields before storage, including biometric data accidentally supplied by a client. */
export function strictAttestationObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) {
    throw new DomainError("INVALID_ATTESTATION", "Only the documented attestation fields are accepted", 400);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max || value.trim() !== value) {
    throw new DomainError("INVALID_ATTESTATION", `${name} is required in the documented format`, 400);
  }
  return value;
}

function base64Bytes(value: unknown, name: string, max: number): Buffer {
  const input = requiredString(value, name, max);
  const bytes = Buffer.from(input, "base64");
  if (!bytes.length || bytes.toString("base64") !== input) {
    throw new DomainError("INVALID_ATTESTATION", `${name} must be canonical base64`, 400);
  }
  return bytes;
}

function publicKeyFromInput(value: unknown): { key: KeyObject; base64: string; sha256: string } {
  const bytes = base64Bytes(value, "publicKey", 256);
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      || !key.export({ format: "der", type: "spki" }).equals(bytes)) throw new Error("Unsupported key");
    return { key, base64: bytes.toString("base64"), sha256: sha256Hex(bytes) };
  } catch {
    throw new DomainError("INVALID_ATTESTATION", "publicKey must be a P-256 SPKI DER public key", 400);
  }
}

function challengeView(row: ChallengeRow) {
  return { challengeId: row.id, payload: row.payload, expiresAt: asRequiredIso(row.expires_at) };
}

export async function createAttestationChallenge(db: Database, clock: Clock, actorUserId: string, proofId: string, value: unknown) {
  const input = strictAttestationObject(value, ["captureSessionId", "sha256", "publicKey"]);
  const captureSessionId = requiredString(input.captureSessionId, "captureSessionId");
  const sha256 = requiredString(input.sha256, "sha256", 64);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new DomainError("INVALID_ATTESTATION", "sha256 must be a lowercase SHA-256 digest", 400);
  const publicKey = publicKeyFromInput(input.publicKey);

  return db.transaction(async tx => {
    const proof = await loadProof(tx, proofId, true);
    await requireParticipant(tx, proofId, actorUserId, "SELLER");
    assertNotFinalized(proof);
    if ((proof.workflow_type ?? "COMMERCE_SALE") !== "COMMERCE_SALE") {
      throw new DomainError("INVALID_ATTESTATION", "Shipping attestation applies to a seller's commerce Proof", 400);
    }
    const session = await loadCaptureSession(tx, actorUserId, proofId, captureSessionId, true);
    if (session.client !== "NATIVE_CAMERA" || session.stage_id || session.workflow_step !== "PACKING"
      || !["RECORDED", "UPLOADING", "COMMITTED"].includes(session.state)
      || session.expected_sha256 !== sha256 || !session.recorded_at) {
      throw new DomainError("ATTESTATION_CAPTURE_MISMATCH", "Attestation must match this seller's completed native packing recording", 409);
    }
    await assertShippingReviewComplete(tx, proofId, captureSessionId);
    const context = await attestationContext(tx, proof.transaction_id);
    const engine = await engineRow(tx, captureSessionId);
    if (engine && !engine.manifest_sha256) throw new DomainError("CAPTURE_SEAL_REQUIRED", "Seal this recording before confirming it", 409);
    const now = clock.now();
    if (session.state !== "COMMITTED" && now.getTime() >= new Date(session.recover_until).getTime()) {
      throw new DomainError("CAPTURE_RECOVERY_EXPIRED", "This recording is beyond its upload recovery window", 409);
    }
    const active = await tx.query<ChallengeRow>(
      `SELECT * FROM attestation_challenges WHERE proof_id=$1 AND actor_user_id=$2
        AND capture_session_id=$3 AND public_key_sha256=$4 AND consumed_at IS NULL
        AND expires_at>$5 ORDER BY created_at DESC LIMIT 1`,
      [proofId, actorUserId, captureSessionId, publicKey.sha256, now.toISOString()],
    );
    if (active.rows[0] && readAttestationContext(active.rows[0].payload).contextSha256 === context.contextSha256) return challengeView(active.rows[0]);
    const count = await tx.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM attestation_challenges WHERE proof_id=$1 AND actor_user_id=$2
        AND consumed_at IS NULL AND expires_at>$3`, [proofId, actorUserId, now.toISOString()],
    );
    if (Number(count.rows[0].count) >= 20) throw new DomainError("ATTESTATION_CHALLENGE_LIMIT", "Finish an existing attestation before starting another", 409);
    const challengeId = newId("att_challenge");
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
    const payload = canonicalize({
      version: 1, method: "ANDROID_BIOMETRIC_STRONG", challengeId,
      nonce: randomBytes(32).toString("hex"), actorUserId, proofId, captureSessionId,
      ...context, ...(engine ? {captureManifestSha256:engine.manifest_sha256,statementSha256:sha256Hex(SELLER_SHIPPING_STATEMENT)} : {}), sha256, statement: SELLER_SHIPPING_STATEMENT, publicKeySha256: publicKey.sha256, expiresAt,
    });
    await tx.query(
      `INSERT INTO attestation_challenges (id, proof_id, actor_user_id, capture_session_id,
        evidence_sha256, public_key_base64, public_key_sha256, payload, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [challengeId, proofId, actorUserId, captureSessionId, sha256, publicKey.base64, publicKey.sha256, payload, now.toISOString(), expiresAt],
    );
    return { challengeId, payload, expiresAt };
  });
}

/** Called inside the same proof-locked transaction as the attestation insert and challenge consumption. */
export async function verifyAttestationAuthorization(
  db: Database, clock: Clock, actorUserId: string, proofId: string,
  value: unknown, evidence: EvidenceRow | undefined,
): Promise<{ authorization: AttestationAuthorization; attestationId: string | null }> {
  const input = strictAttestationObject(value, ["challengeId", "signature"]);
  const challengeId = requiredString(input.challengeId, "challengeId");
  const signature = base64Bytes(input.signature, "signature", 112);
  const result = await db.query<ChallengeRow>(
    "SELECT * FROM attestation_challenges WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3 FOR UPDATE",
    [challengeId, proofId, actorUserId],
  );
  const challenge = result.rows[0];
  if (!challenge) throw new DomainError("ATTESTATION_CHALLENGE_NOT_FOUND", "This attestation challenge does not belong to this seller and Proof", 404);
  if (!evidence || evidence.validation_status !== "COMMITTED" || !evidence.committed_at
    || evidence.submitted_by !== actorUserId || evidence.evidence_type !== "FULFILLMENT_CAPTURE"
    || evidence.capture_session_id !== challenge.capture_session_id || evidence.sha256 !== challenge.evidence_sha256) {
    throw new DomainError("ATTESTATION_EVIDENCE_MISMATCH", "Attestation must match the committed packing video, its seller, and its capture session", 409);
  }
  const session = await loadCaptureSession(db, actorUserId, proofId, challenge.capture_session_id, true);
  if (session.state !== "COMMITTED" || session.evidence_id !== evidence.id || session.expected_sha256 !== evidence.sha256) {
    throw new DomainError("ATTESTATION_EVIDENCE_MISMATCH", "The signed recording has not been committed to this Proof", 409);
  }
  if (!challenge.consumed_at) {
    const proof = await loadProof(db, proofId);
    await assertShippingReviewComplete(db, proofId, challenge.capture_session_id);
    await assertAttestationContextCurrent(db, proof.transaction_id, challenge.payload);
  }
  const engine = await engineRow(db, challenge.capture_session_id);
  if (engine && JSON.parse(challenge.payload).captureManifestSha256 !== engine.manifest_sha256) throw new DomainError("ATTESTATION_CAPTURE_MISMATCH", "The attestation must cover this sealed capture manifest", 409);
  const publicKey = publicKeyFromInput(challenge.public_key_base64);
  let valid = false;
  try { valid = verify("sha256", Buffer.from(challenge.payload, "utf8"), { key: publicKey.key, dsaEncoding: "der" }, signature); } catch { /* Invalid DER signatures are rejected. */ }
  if (!valid) throw new DomainError("ATTESTATION_SIGNATURE_INVALID", "The attestation signature does not match this recording authorization", 400);
  // A completed exact challenge may be replayed after expiry to recover a lost commit response.
  if (!challenge.consumed_at && clock.now().getTime() >= new Date(challenge.expires_at).getTime()) {
    throw new DomainError("ATTESTATION_CHALLENGE_EXPIRED", "Confirm your shipping attestation again to continue submitting this video", 409);
  }
  return {
    attestationId: challenge.attestation_id,
    authorization: {
      version: 1, method: "ANDROID_BIOMETRIC_STRONG",
      biometricMethodProvenance: "CLIENT_ASSERTED_NOT_INDEPENDENTLY_VERIFIED",
      signatureVerification: "SERVER_VERIFIED", algorithm: "ECDSA_SHA256", challengeId,
      payload: challenge.payload, signature: signature.toString("base64"),
      publicKey: challenge.public_key_base64, publicKeySha256: challenge.public_key_sha256,
      verifiedAt: clock.now().toISOString(),
    },
  };
}
