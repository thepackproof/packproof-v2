import { isUnifiedCameraAvailable } from "../../modules/packproof-unified-camera";
import * as FileSystem from "expo-file-system";
import { Platform } from "react-native";
import { getAttestationAvailability, prepareAttestationKey } from "../attestation/native";
import type { PackProofV2Client } from "../v2-api";
import { requireCaptureCapabilities, requireOrderCaptureCapabilities } from "./capabilities";

export async function capturePreflight(client: PackProofV2Client, userId: string, sellerAttestation = true): Promise<void> {
  if (Platform.OS === "android" && !isUnifiedCameraAvailable())
    throw Object.assign(new Error("Update PackProof to use recoverable recording. Your saved recordings remain available."), { code: "CAPABILITY_CAMERA_UPDATE_REQUIRED" });
  let response: unknown;
  try { response = await client.getCapabilities(); } catch (error) {
    if ((error as { status?: number }).status === 404) throw Object.assign(new Error("This server does not yet support recoverable recording. Retry later; your saved recordings remain available."), { code: "CAPABILITY_UPDATE_REQUIRED" });
    throw error;
  }
  const capabilities = requireCaptureCapabilities(response, sellerAttestation && Platform.OS === "android");
  if (sellerAttestation) requireOrderCaptureCapabilities(capabilities);
  if (sellerAttestation && Platform.OS === "android") {
    const available = await getAttestationAvailability();
    if (!available.available) throw Object.assign(new Error(available.message || "Set up a supported strong biometric in Android Settings before recording."), { code: available.code });
    await prepareAttestationKey(userId);
  }
  const freeBytes = await FileSystem.getFreeDiskStorageAsync();
  // Reserve one original plus a bounded upload part and working space. Originals are never re-encoded.
  const required = Math.min(capabilities.capture.maxBytes, 250_000_000) + 32 * 1024 * 1024;
  if (freeBytes < required) throw Object.assign(new Error(`Free at least ${Math.ceil(required / 1024 / 1024)} MB on this device before recording. Saved recordings can be managed under Account.`), { code: "STORAGE_LOW" });
}
