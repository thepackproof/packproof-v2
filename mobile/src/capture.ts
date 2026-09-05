import * as FileSystem from "expo-file-system";
import type { FileSystemUploadResult } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  ApiError,
  newIdempotencyKey,
  resolveUploadUrl,
  type UploadTarget,
  type PackProofV2Client,
} from "./v2-api";

const LOCAL_CAPTURE_NAME = "packproof-seller-evidence.mp4";

export interface LocalCapture {
  uri: string;
  contentType: string;
  byteSize: number | null;
  durationMs: number | null;
}

export async function requestCapturePermissions(): Promise<void> {
  const camera = await ImagePicker.requestCameraPermissionsAsync();
  if (camera.granted) {
    return;
  }
  if (!camera.canAskAgain) {
    throw new Error(
      "Camera permission denied. Enable camera access in Android settings to record packing evidence.",
    );
  }
  throw new Error("Camera permission is required to record packing evidence.");
}

/** Native camera owns the device for packing video. Finish-scan uses expo-camera after this returns. */
export async function captureGradingPhoto(): Promise<{
  uri: string;
  contentType: string;
} | null> {
  await requestCapturePermissions();
  let result: ImagePicker.ImagePickerResult;
  try {
    result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      cameraType: ImagePicker.CameraType.back,
      allowsEditing: false,
      quality: 0.92,
    });
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Photo capture failed: ${error.message}` : "Camera is unavailable.",
    );
  }
  if (result.canceled || !result.assets[0]?.uri) {
    return null;
  }
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    contentType: asset.mimeType ?? "image/jpeg",
  };
}

export async function recordPackingEvidence(): Promise<LocalCapture | null> {
  await requestCapturePermissions();
  let result: ImagePicker.ImagePickerResult;
  try {
    result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["videos"],
      cameraType: ImagePicker.CameraType.back,
      videoMaxDuration: 180,
      allowsEditing: false,
    });
  } catch (error) {
    throw new Error(
      error instanceof Error ? `Recording failed: ${error.message}` : "Camera is unavailable.",
    );
  }
  if (result.canceled || !result.assets[0]?.uri) {
    return null;
  }
  const asset = result.assets[0];
  if (asset.type && asset.type !== "video") {
    throw new Error("Packing evidence must be a video recording.");
  }
  return persistLocalCapture({
    uri: asset.uri,
    contentType: asset.mimeType ?? "video/mp4",
    byteSize: asset.fileSize ?? null,
    durationMs: asset.duration ?? null,
  });
}

export function durableCaptureUri(): string {
  const directory = FileSystem.documentDirectory;
  if (!directory) {
    throw new Error("Local document storage is unavailable.");
  }
  return `${directory}${LOCAL_CAPTURE_NAME}`;
}

export async function persistLocalCapture(capture: LocalCapture): Promise<LocalCapture> {
  const dest = `${FileSystem.documentDirectory}packproof-evidence-${newIdempotencyKey()}.mp4`;
  if (capture.uri !== dest) {
    const existing = await FileSystem.getInfoAsync(dest);
    if (existing.exists) {
      await FileSystem.deleteAsync(dest, { idempotent: true });
    }
    await FileSystem.copyAsync({ from: capture.uri, to: dest });
  }
  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists || info.isDirectory) {
    throw new Error("Captured video could not be saved locally.");
  }
  return {
    uri: dest,
    contentType: capture.contentType || "video/mp4",
    byteSize: "size" in info && typeof info.size === "number" ? info.size : capture.byteSize,
    durationMs: capture.durationMs,
  };
}

export async function localCaptureExists(uri: string | null | undefined): Promise<boolean> {
  if (!uri) {
    return false;
  }
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && !info.isDirectory;
}

export async function discardLocalCapture(uri: string | null | undefined): Promise<void> {
  if (!uri) {
    return;
  }
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // A missing temporary file is not Proof state.
  }
}

export async function describeLocalCapture(
  uri: string,
  fallback: {
    byteSize?: number | null;
    durationMs?: number | null;
    contentType?: string | null;
  },
): Promise<LocalCapture | null> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory) {
    return null;
  }
  return {
    uri,
    contentType: fallback.contentType ?? "video/mp4",
    byteSize:
      "size" in info && typeof info.size === "number" ? info.size : (fallback.byteSize ?? null),
    durationMs: fallback.durationMs ?? null,
  };
}

export async function uploadCaptureFile(input: {
  baseUrl: string;
  target: UploadTarget;
  fileUri: string;
  contentType: string;
  onProgress?: (percent: number) => void;
}): Promise<void> {
  const exists = await localCaptureExists(input.fileUri);
  if (!exists) {
    throw new Error("Captured video is no longer available. Record packing evidence again.");
  }
  const url = resolveUploadUrl(input.baseUrl, input.target.url);
  input.onProgress?.(0);
  const task = FileSystem.createUploadTask(
    url,
    input.fileUri,
    {
      httpMethod: input.target.method,
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        ...input.target.headers,
        "Content-Type": input.contentType,
      },
    },
    (data) => {
      if (data.totalBytesExpectedToSend > 0) {
        const percent = Math.min(
          99,
          Math.round((data.totalBytesSent / data.totalBytesExpectedToSend) * 100),
        );
        input.onProgress?.(percent);
      }
    },
  );
  let result: FileSystemUploadResult | undefined;
  try {
    result = await task.uploadAsync();
  } catch (error) {
    throw new Error(error instanceof Error ? `Upload failed: ${error.message}` : "Upload failed.");
  }
  if (!result || result.status < 200 || result.status >= 300) {
    throw new ApiError(
      "UPLOAD_FAILED",
      `Upload failed (HTTP ${result?.status ?? "unknown"})`,
      result?.status ?? 0,
    );
  }
  input.onProgress?.(100);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) {
    return "size unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null || durationMs < 0) {
    return "duration unknown";
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

/** Durable 5 MiB parts; server lists completed parts after an app restart. */
export async function uploadCaptureResumable(input: {
  client: PackProofV2Client;
  baseUrl: string;
  proofId: string;
  evidenceId: string;
  fileUri: string;
  onProgress?: (percent: number) => void;
}): Promise<void> {
  const info = await FileSystem.getInfoAsync(input.fileUri);
  if (!info.exists || info.isDirectory || !("size" in info) || !info.size)
    throw new Error("Recorded video is unavailable");
  const state = await input.client.listUploadParts(input.proofId, input.evidenceId);
  const count = Math.ceil(info.size / state.partSize);
  if (count > state.maxParts)
    throw new Error("This recording exceeds 200 MiB. Record a shorter video.");
  const saved = new Set(state.parts.map((p) => p.partNumber));
  for (let part = 1; part <= count; part++) {
    if (!saved.has(part)) {
      const position = (part - 1) * state.partSize,
        length = Math.min(state.partSize, info.size - position);
      const chunkUri = `${FileSystem.cacheDirectory}packproof-${input.evidenceId}-${part}.part`;
      try {
        const data = await FileSystem.readAsStringAsync(input.fileUri, {
          encoding: FileSystem.EncodingType.Base64,
          position,
          length,
        });
        await FileSystem.writeAsStringAsync(chunkUri, data, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await uploadCaptureFile({
          baseUrl: input.baseUrl,
          target: input.client.uploadPartTarget(input.proofId, input.evidenceId, part),
          fileUri: chunkUri,
          contentType: "application/octet-stream",
          onProgress: (percent) =>
            input.onProgress?.(
              Math.min(99, Math.round(((part - 1 + percent / 100) / count) * 100)),
            ),
        });
      } finally {
        await FileSystem.deleteAsync(chunkUri, { idempotent: true }).catch(() => undefined);
      }
    }
    input.onProgress?.(Math.min(99, Math.round((part / count) * 100)));
  }
  await input.client.completeUploadParts(input.proofId, input.evidenceId, info.size);
  input.onProgress?.(100);
}
