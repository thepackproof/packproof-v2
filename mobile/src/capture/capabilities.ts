import type { ApiCapabilities } from "../v2-api";

export function requireCaptureCapabilities(value: unknown, sellerAttestation: boolean): ApiCapabilities {
  const capabilities = value as Partial<ApiCapabilities> | null;
  if (!capabilities || capabilities.schemaVersion !== 1 || !capabilities.capture?.protocolVersions?.includes(1) ||
      !Number.isFinite(capabilities.capture.maxBytes) || capabilities.capture.maxBytes <= 0 ||
      !capabilities.preservation?.receiptVersions?.includes(1))
    throw Object.assign(new Error("This app cannot safely complete a new recording with the current server. Update PackProof or retry later. Saved recordings remain available."), { code: "CAPABILITY_UPDATE_REQUIRED" });
  if (sellerAttestation && (!capabilities.sellerAttestation?.challengeVersions?.includes(1) ||
      capabilities.sellerAttestation.statementVersion !== 1 || !capabilities.sellerAttestation.methods?.includes("ANDROID_BIOMETRIC_STRONG")))
    throw Object.assign(new Error("Shipment confirmation is not available on this server yet. Return to your order and retry later."), { code: "CAPABILITY_ATTESTATION_REQUIRED" });
  return capabilities as ApiCapabilities;
}
