import type { ApiCapabilities } from "../v2-api";

/** Only an explicit, compatible server declaration permits legacy completion.
 * Missing or malformed capabilities retain both durable-receipt gates. */
export function requiresDurableCaptureReceipts(value: unknown): boolean {
  const capabilities = value as Partial<ApiCapabilities> | null;
  return !(capabilities?.schemaVersion === 1 &&
    Array.isArray(capabilities.capture?.protocolVersions) && capabilities.capture.protocolVersions.includes(1) &&
    Number.isFinite(capabilities.capture.maxBytes) && capabilities.capture.maxBytes > 0 &&
    Array.isArray(capabilities.preservation?.receiptVersions) &&
    capabilities.preservation.receiptVersions.includes(1) &&
    capabilities.preservation.durableReceiptsRequired === false);
}

export function requireCaptureCapabilities(value: unknown, sellerAttestation: boolean): ApiCapabilities {
  const capabilities = value as Partial<ApiCapabilities> | null;
  if (!capabilities || capabilities.schemaVersion !== 1 ||
      !Array.isArray(capabilities.capture?.protocolVersions) || !capabilities.capture.protocolVersions.includes(1) ||
      !Number.isSafeInteger(capabilities.capture.maxBytes) || capabilities.capture.maxBytes <= 0 ||
      !Number.isSafeInteger(capabilities.capture.maxDurationSeconds) || capabilities.capture.maxDurationSeconds <= 0 ||
      !Number.isSafeInteger(capabilities.capture.maxActiveUploads) || capabilities.capture.maxActiveUploads <= 0 ||
      !Array.isArray(capabilities.preservation?.receiptVersions) || !capabilities.preservation.receiptVersions.includes(1) ||
      typeof capabilities.preservation.durableReceiptsRequired !== 'boolean')
    throw Object.assign(new Error("This app cannot safely complete a new recording with the current server. Update PackProof or retry later. Saved recordings remain available."), { code: "CAPABILITY_UPDATE_REQUIRED" });
  if (sellerAttestation && (!Array.isArray(capabilities.sellerAttestation?.challengeVersions) || !capabilities.sellerAttestation.challengeVersions.includes(1) ||
      capabilities.sellerAttestation.statementVersion !== 1 || !Array.isArray(capabilities.sellerAttestation.methods) ||
      !capabilities.sellerAttestation.methods.includes("ANDROID_BIOMETRIC_STRONG")))
    throw Object.assign(new Error("Shipment confirmation is not available on this server yet. Return to your order and retry later."), { code: "CAPABILITY_ATTESTATION_REQUIRED" });
  return capabilities as ApiCapabilities;
}

/** Gate new order recordings separately so legacy journal completion stays compatible. */
export function requireOrderCaptureCapabilities(value: ApiCapabilities): void {
  if (value.shippingReview?.requiredForObservedConflicts !== true || value.shippingReview.noLabelAllowed !== true ||
      value.correctionPolicy?.importedFactsReadOnly !== true || value.correctionPolicy.captureBindingLocksManualDetails !== true ||
      value.sellerAttestation?.contextBindingVersion !== 1)
    throw Object.assign(new Error("Packing is being updated. Please retry later; your saved recordings remain available."), { code: "CAPABILITY_UPDATE_REQUIRED" });
}
