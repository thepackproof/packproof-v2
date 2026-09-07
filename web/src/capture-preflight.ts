import type { PackProofApi } from "./api/client";

export type CaptureCapabilities = {
  schemaVersion: number;
  capture: { protocolVersions: number[]; maxBytes: number; maxDurationSeconds: number; maxActiveUploads: number };
  preservation: { receiptVersions: number[]; durableReceiptsRequired: boolean };
};

export async function capturePreflight(api: PackProofApi): Promise<CaptureCapabilities> {
  const capabilities = await api.getCapabilities();
  if (capabilities.schemaVersion !== 1 || !capabilities.capture.protocolVersions.includes(1)) {
    throw new Error("Update PackProof before recording. Your saved recordings remain available.");
  }
  if (!Number.isSafeInteger(capabilities.capture.maxBytes) || capabilities.capture.maxBytes < 1
    || !Number.isSafeInteger(capabilities.capture.maxDurationSeconds) || capabilities.capture.maxDurationSeconds < 1) {
    throw new Error("Recording is temporarily unavailable. Your saved recordings remain available; retry shortly.");
  }
  const storage = await navigator.storage?.estimate?.();
  if (storage?.quota != null && storage.usage != null && storage.quota - storage.usage < capabilities.capture.maxBytes * 1.2) {
    throw new Error("Free browser storage before recording. Existing saved recordings remain available.");
  }
  await navigator.storage?.persist?.().catch(() => false);
  return capabilities;
}
