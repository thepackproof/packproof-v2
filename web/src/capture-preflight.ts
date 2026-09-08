import type { PackProofApi } from "./api/client";

export type CaptureCapabilities = {
  schemaVersion: number;
  capture: { protocolVersions: number[]; maxBytes: number; maxDurationSeconds: number; maxActiveUploads: number };
  shippingReview?: { requiredForObservedConflicts: boolean; noLabelAllowed: boolean };
  correctionPolicy?: { importedFactsReadOnly: boolean; captureBindingLocksManualDetails: boolean };
  sellerAttestation?: { contextBindingVersion?: number };
  preservation: { receiptVersions: number[]; durableReceiptsRequired: boolean };
};

/** Only an explicit current server policy permits completion before durable receipts.
 * This never grants permission to discard the local original. */
export async function requiresDurableReceipts(api: PackProofApi): Promise<boolean> {
  try {
    const value = await api.getCapabilities();
    return !(value.schemaVersion === 1 && value.preservation?.receiptVersions?.includes(1)
      && value.preservation.durableReceiptsRequired === false);
  } catch { return true; }
}

export async function capturePreflight(api: PackProofApi, orderRecording = false): Promise<CaptureCapabilities> {
  const capabilities = await api.getCapabilities();
  if (!capabilities || capabilities.schemaVersion !== 1 || !Array.isArray(capabilities.capture?.protocolVersions) ||
      !capabilities.capture.protocolVersions.includes(1) || !Array.isArray(capabilities.preservation?.receiptVersions) ||
      !capabilities.preservation.receiptVersions.includes(1) || typeof capabilities.preservation.durableReceiptsRequired !== 'boolean') {
    throw new Error("Update PackProof before recording. Your saved recordings remain available.");
  }
  if (!Number.isSafeInteger(capabilities.capture.maxBytes) || capabilities.capture.maxBytes < 1
    || !Number.isSafeInteger(capabilities.capture.maxDurationSeconds) || capabilities.capture.maxDurationSeconds < 1
    || !Number.isSafeInteger(capabilities.capture.maxActiveUploads) || capabilities.capture.maxActiveUploads < 1) {
    throw new Error("Recording is temporarily unavailable. Your saved recordings remain available; retry shortly.");
  }
  if (orderRecording && (capabilities.shippingReview?.requiredForObservedConflicts !== true || capabilities.shippingReview.noLabelAllowed !== true ||
      capabilities.correctionPolicy?.importedFactsReadOnly !== true || capabilities.correctionPolicy.captureBindingLocksManualDetails !== true ||
      capabilities.sellerAttestation?.contextBindingVersion !== 1)) {
    throw new Error("Packing is being updated. Please retry later; your saved recordings remain available.");
  }
  const storage = await navigator.storage?.estimate?.();
  if (storage?.quota != null && storage.usage != null && storage.quota - storage.usage < capabilities.capture.maxBytes * 1.2) {
    throw new Error("Free browser storage before recording. Existing saved recordings remain available.");
  }
  await navigator.storage?.persist?.().catch(() => false);
  return capabilities;
}
