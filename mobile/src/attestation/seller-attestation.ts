import { nativeStudyForCapture } from "../analytics/native-study";
import { bindRecordedCapture, persistCaptureMetadata, type LocalCapture } from "../capture";
import type { PackProofV2Client, SellerAttestationAuthorization } from "../v2-api";
import { getAttestationAvailability, prepareAttestationKey, signAttestationPayload } from "./native";
import { recordedSellerAuthorization, recoverableSellerEvidence, validateSellerChallenge } from "./authorization";

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

/** Recover consent against the owner's existing committed native recording; no new capture or media copy. */
export async function authorizeCommittedSellerEvidence({ client, proofId, evidenceId, userId }: {
  client: PackProofV2Client; proofId: string; evidenceId: string; userId: string;
}): Promise<SellerAttestationAuthorization> {
  const proof = await client.getProof(proofId);
  if (!proof.participants.some(person => person.userId === userId && person.role === "SELLER")) throw new Error("Open the seller account to confirm this recording.");
  const recorded = recordedSellerAuthorization(proof,evidenceId,userId);
  if (recorded) return recorded;
  const evidence = recoverableSellerEvidence(proof,evidenceId,userId);
  if (!evidence?.captureSessionId || !evidence.sha256 || evidence.captureClient !== "NATIVE_CAMERA") throw new Error("This recording cannot be confirmed with Android biometrics. Open its original recording workflow to confirm it.");
  const available = await getAttestationAvailability();
  if (!available.available) throw Object.assign(new Error(available.message ?? "Set up Android biometrics to confirm this recording."), {code:available.code});
  const {publicKey} = await prepareAttestationKey(userId);
  const challenge = await client.createAttestationChallenge(proofId,{captureSessionId:evidence.captureSessionId,sha256:evidence.sha256,publicKey});
  validateSellerChallenge(challenge,{proofId,userId,captureSessionId:evidence.captureSessionId,sha256:evidence.sha256,publicKey});
  const {signature} = await signAttestationPayload(userId,challenge.payload);
  return {challengeId:challenge.challengeId,signature};
}
