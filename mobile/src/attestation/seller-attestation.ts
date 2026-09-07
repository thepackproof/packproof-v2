import { bindRecordedCapture, type LocalCapture } from "../capture";
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
  const { signature } = await signAttestationPayload(userId, challenge.payload);
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
