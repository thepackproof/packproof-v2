import { classifyProofPresentation, withLocalProofWork, type ProofPresentation } from "../../backend/src/domain/proof-presentation";
import type { CanonicalProof, ProofCollectionItem } from "./api/types";
import type { LocalRecordingSummary } from "./capture-queue";
export function presentProof(proof: CanonicalProof, userId: string) {
  return proof.presentation || classifyProofPresentation({
    proofId: proof.proofId, status: proof.status, finalizedAt: proof.finalizedAt, workflowType: proof.workflowType,
    role: proof.participants.find(participant => participant.userId === userId)?.role,
    fulfillmentCaptureCount: proof.evidence.filter(item => item.validationStatus === "COMMITTED" && item.evidenceType === "FULFILLMENT_CAPTURE").length,
    workflowNextAction: proof.nextAction ? { ...proof.nextAction, actorRole: proof.nextAction.actorRole || "SELLER" } : null,
    shipmentStatus: proof.shipmentObservations?.latest?.eventType || null,
  });
}
export function withRecording(presentation: ProofPresentation, recording?: LocalRecordingSummary) {
  return withLocalProofWork(presentation, !recording || recording.finalized || recording.submitted ? null : {
    state: !recording.accepted ? "CAPTURE_UNFINISHED" : recording.errorMessage || recording.retryStopped ? "UPLOAD_INTERRUPTED" : recording.preserved ? "CONFIRMATION_NEEDED" : "UPLOADING",
    canResumeCapture: false,
  });
}
export function applyLocalWork(item: ProofCollectionItem, recording?: LocalRecordingSummary) {
  const presentation = item.presentation || classifyProofPresentation({ proofId: item.proofId, status: item.status, role: item.role, finalizedAt: item.finalizedAt });
  return { ...item, presentation: withRecording(presentation, recording) };
}
