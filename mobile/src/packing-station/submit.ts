import { proofHasBuyer, sellerHasPackingAttestation, stationErrorFromUnknown } from "./display";
import type { StationCaptureRef, StationError, StationProofSnapshot, SubmitStep } from "./types";

export interface StationUploadTarget {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export interface StationSubmitApi {
  initializeEvidenceUpload(
    proofId: string,
    input: {
      contentType: string;
      evidenceType?: string;
      idempotencyKey: string;
    },
  ): Promise<{ evidenceId: string; upload: StationUploadTarget }>;
  commitEvidence(proofId: string, evidenceId: string): Promise<{ proof: StationProofSnapshot }>;
  createAttestation(
    proofId: string,
    input: { statement: string; relatedEvidenceId?: string },
  ): Promise<{ proof: StationProofSnapshot }>;
  finalizeProof(proofId: string): Promise<{ proof: StationProofSnapshot }>;
  getProof(proofId: string): Promise<StationProofSnapshot>;
}

export interface StationSubmitDeps {
  api: StationSubmitApi;
  uploadEvidence?: (
    proofId: string,
    evidenceId: string,
    capture: StationCaptureRef,
    onProgress: (percent: number) => void,
  ) => Promise<void>;
  upload: (
    target: StationUploadTarget,
    capture: StationCaptureRef,
    onProgress: (percent: number) => void,
  ) => Promise<void>;
  newIdempotencyKey: () => string;
}

export interface StationSubmitResult {
  proof: StationProofSnapshot;
  completion: "FINALIZED" | "EVIDENCE_COMMITTED";
  idempotencyKey: string;
  evidenceId: string;
}

export async function submitStationSession(input: {
  proof: StationProofSnapshot;
  actorUserId: string;
  capture: StationCaptureRef;
  idempotencyKey?: string | null;
  evidenceId?: string | null;
  onEvidenceInitialized?: (evidenceId: string) => Promise<void>;
  deps: StationSubmitDeps;
  onProgress?: (progress: { step: SubmitStep; uploadPercent: number | null }) => void;
}): Promise<StationSubmitResult> {
  const proofId = input.proof.proofId;
  const recoveredEvidence = input.evidenceId
    ? input.proof.evidence.find(
        (item) => item.evidenceId === input.evidenceId && item.validationStatus === "COMMITTED",
      )
    : null;
  if (input.proof.status === "FINALIZED" && !recoveredEvidence) {
    throw {
      code: "PROOF_ALREADY_FINALIZED",
      message: "This PackProof is already complete.",
    } satisfies StationError;
  }
  const alreadyCommitted = input.proof.evidence.some(
    (item) => item.validationStatus === "COMMITTED",
  );
  if (alreadyCommitted && !recoveredEvidence) {
    throw {
      code: "EVIDENCE_ALREADY_COMMITTED",
      message: "This order already has packing evidence.",
    } satisfies StationError;
  }

  const key = input.idempotencyKey?.trim() || input.deps.newIdempotencyKey();
  const notify = (step: SubmitStep, uploadPercent: number | null) => {
    input.onProgress?.({ step, uploadPercent });
  };

  notify("upload", 0);
  let initialized: Awaited<ReturnType<StationSubmitApi["initializeEvidenceUpload"]>> | null = null;
  let evidenceId: string | null = recoveredEvidence?.evidenceId ?? null;
  let proof: StationProofSnapshot | null = recoveredEvidence ? input.proof : null;
  if (!proof) try {
    initialized = await input.deps.api.initializeEvidenceUpload(proofId, {
      contentType: input.capture.contentType,
      evidenceType: "FULFILLMENT_CAPTURE",
      idempotencyKey: key,
    });
    // Save the exact evidence identity before bytes can be committed, so a lost
    // response or app restart can resume attestation/finalization safely.
    await input.onEvidenceInitialized?.(initialized.evidenceId);
    if (input.deps.uploadEvidence)
      await input.deps.uploadEvidence(proofId, initialized.evidenceId, input.capture, (percent) =>
        notify("upload", percent),
      );
    else
      await input.deps.upload(initialized.upload, input.capture, (percent) => {
        notify("upload", percent);
      });
  } catch (error) {
    const mapped = stationErrorFromUnknown(error);
    if (mapped.code === "EVIDENCE_ALREADY_COMMITTED") {
      notify("refresh", 100);
      proof = await input.deps.api.getProof(proofId);
      evidenceId =
        proof.evidence.find((item) => item.validationStatus === "COMMITTED" && item.evidenceId)
          ?.evidenceId ?? null;
      if (!evidenceId) {
        throw mapSubmitError(
          error,
          "NETWORK",
          "Packing evidence was committed, but recovery could not identify it.",
        );
      }
    } else {
      throw mapSubmitError(
        error,
        "UPLOAD_FAILED",
        "Upload failed. The packing video is still on this device.",
      );
    }
  }

  if (initialized) {
    evidenceId = initialized.evidenceId;
  }

  if (!proof && initialized) {
    notify("commit", 100);
    try {
      const committed = await input.deps.api.commitEvidence(proofId, initialized.evidenceId);
      proof = committed.proof;
    } catch (error) {
      throw mapSubmitError(
        error,
        "NETWORK",
        "Evidence was not committed. The packing video is still on this device.",
      );
    }
  }

  if (!proof || !evidenceId) {
    throw {
      code: "NETWORK",
      message: "Packing evidence recovery did not return a committed record.",
    } satisfies StationError;
  }

  const optional = proof.participationPolicy === "COUNTERPARTY_OPTIONAL";
  if (proof.status !== "FINALIZED" && optional && !sellerHasPackingAttestation(proof, input.actorUserId)) {
    notify("attest", 100);
    try {
      const attested = await input.deps.api.createAttestation(proofId, {
        statement: "PACKED_DESCRIBED_ITEM",
        relatedEvidenceId: evidenceId,
      });
      proof = attested.proof;
    } catch (error) {
      throw mapSubmitError(
        error,
        "NETWORK",
        "Packing video was saved. Retry to finish the PackProof.",
      );
    }
  }

  const canFinalize = optional || (proof.status === "EVIDENCE_COMMITTED" && proofHasBuyer(proof));
  if (canFinalize && proof.status !== "FINALIZED") {
    notify("finalize", 100);
    try {
      const finalized = await input.deps.api.finalizeProof(proofId);
      proof = finalized.proof;
    } catch (error) {
      const mapped = stationErrorFromUnknown(error);
      if (
        mapped.code === "PROOF_NOT_READY_FOR_FINALIZATION" ||
        mapped.code === "FULFILLMENT_CAPTURE_REQUIRED"
      ) {
        notify("refresh", 100);
        proof = await input.deps.api.getProof(proofId);
      } else if (mapped.code === "PROOF_ALREADY_FINALIZED") {
        notify("refresh", 100);
        proof = await input.deps.api.getProof(proofId);
      } else {
        throw mapSubmitError(
          error,
          "NETWORK",
          "Packing video was saved. Retry to finish the PackProof.",
        );
      }
    }
  }

  notify("refresh", 100);
  proof = await input.deps.api.getProof(proofId);
  return {
    proof,
    completion: proof.status === "FINALIZED" ? "FINALIZED" : "EVIDENCE_COMMITTED",
    idempotencyKey: key,
    evidenceId,
  };
}

function mapSubmitError(
  error: unknown,
  fallbackCode: StationError["code"],
  fallbackMessage: string,
): StationError {
  const mapped = stationErrorFromUnknown(error);
  if (mapped.code === "UNAUTHENTICATED" || mapped.code === "PROOF_ALREADY_FINALIZED") {
    return mapped;
  }
  if (mapped.code === "UPLOAD_FAILED") {
    return { code: "UPLOAD_FAILED", message: fallbackMessage };
  }
  return {
    code: mapped.code === "UNKNOWN" ? fallbackCode : mapped.code,
    message: mapped.message || fallbackMessage,
  };
}
