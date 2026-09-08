import { nativeStudyForCapture } from "../analytics/native-study";
import { bindRecordedCapture, persistCaptureMetadata, type LocalCapture } from "../capture";
import type { PackProofV2Client, SellerAttestationAuthorization } from "../v2-api";
import { getAttestationAvailability, prepareAttestationKey, signAttestationPayload } from "./native";
import { recordedSellerAuthorization, validateSellerChallenge } from "./authorization";

export async function authorizeSellerCapture({ client, capture, proofId, userId }: {
  client: PackProofV2Client; capture: LocalCapture; proofId: string; userId: string;
}): Promise<SellerAttestationAuthorization> {
  if (capture.captureProofId !== proofId || capture.captureUserId !== userId || capture.captureStageId)
    throw new Error("Open the original seller account and Proof to submit this recording.");
  // A lost commit response is recovered from server state, never a local success flag.
  if (capture.uploadEvidenceId) {
    const saved = recordedSellerAuthorization(await client.getProof(proofId), capture.uploadEvidenceId, userId);
    if (saved) return saved;
  }
  // A retried delivery sends the same already-authorized signature. This does not create another signing operation.
  const held = capture.recovery?.authorization;
  if (held && held.sha256 === capture.captureSha256 && Date.parse(held.expiresAt) > Date.now())
    return { challengeId: held.challengeId, signature: held.signature };
  const available = await getAttestationAvailability();
  if (!available.available) throw Object.assign(new Error(available.message ?? "Set up biometrics in Android settings to attest. Your recording is saved."), { code: available.code });
  await bindRecordedCapture(client, capture, proofId, userId);
  if (!capture.captureSessionId || !capture.captureSha256) throw new Error("The recording could not be prepared for attestation. Your video is saved.");
  const { publicKey } = await prepareAttestationKey(userId);
  const challenge = await client.createAttestationChallenge(proofId, {
    captureSessionId: capture.captureSessionId,
    sha256: capture.captureSha256,
    publicKey,
  });
  validateSellerChallenge(challenge, { proofId, userId, captureSessionId: capture.captureSessionId, sha256: capture.captureSha256, publicKey });
  const study=await nativeStudyForCapture(client,userId,capture.studyTimingRef);
  let signature:string;
  try {
    ({signature}=await signAttestationPayload(userId,challenge.payload));
    study?.event('consent_confirmed');
  } catch (error) {
    const cancelled=(error as {code?:string})?.code==='BIOMETRIC_CANCELLED';
    study?.event(cancelled?'consent_cancelled':'consent_failed');
    study?.problem(cancelled?'cancelled':'authentication');
    throw error;
  }
  if (capture.recovery) {
    capture.recovery.authorization = { challengeId: challenge.challengeId, signature, expiresAt: challenge.expiresAt, sha256: capture.captureSha256 };
    // Persist before the first attestation HTTP request so a lost response can replay exact bytes.
    await persistCaptureMetadata(capture);
  }
  return { challengeId: challenge.challengeId, signature };
}

export async function attestSellerCapture({ client, proofId, evidenceId, authorization }: {
  client: PackProofV2Client; proofId: string; evidenceId: string; authorization: SellerAttestationAuthorization;
}) {
  return client.createAttestation(proofId, {
    statement: "PACKED_DESCRIBED_ITEM",
    relatedEvidenceId: evidenceId,
    authorization,
  });
}
