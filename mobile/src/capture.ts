import type { CaptureSessionGrant } from "./intake/model";
import { inspectRecordedVideo, type EncodedVideoInspection } from "../modules/packproof-unified-camera";
import { capturePreflight } from "./capture/preflight";
import {startNativeStudy,nativeStudyForCapture,type NativeStudyTimer} from './analytics/native-study';
import type { CaptureRecoveryState } from "./capture/recovery-model";
import { shippingQueue, readShippingJournal, releaseShippingQueue } from "./capture/shipping-scan-storage";
import type { ShippingScan, ShippingScanResult, ShippingScanJournal } from "./capture/shipping-scan-queue";
import { sha256 } from "@noble/hashes/sha256";
import { toByteArray } from "base64-js";
import * as FileSystem from "expo-file-system";
import type { FileSystemUploadResult } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { withRequestTimeout } from "./request-timeout";
import {
  ApiError,
  newIdempotencyKey,
  resolveUploadUrl,
  type UploadTarget,
  type PackProofV2Client,
} from "./v2-api";

const LOCAL_CAPTURE_NAME = "packproof-seller-evidence.mp4";

export interface LocalCapture {
  studyTimingRef?: string;
  recovery?: CaptureRecoveryState;
  uri: string;
  contentType: string;
  byteSize: number | null;
  durationMs: number | null;
  captureSessionId?: string;
  captureProofId?: string;
  captureStageId?: string;
  captureUserId?: string;
  captureSha256?: string;
  uploadEvidenceId?: string;
  bookmarks?: CaptureBookmark[];
  interrupted?: boolean;
  shippingBinding?: ShippingScanResult;
  encodedInspection?: EncodedVideoInspection & { originalSha256?: string };
}

export interface CaptureBookmark { label: string; startMs: number; endMs: number; sourceType: "USER_MARKED" | "SCANNER_TRIGGERED"; recipeVersion?: string; }
export interface NativeRecordingRequest { autoStart?: boolean; onRecordingStarted?:()=>void; onRecordingStopped?:()=>void; onShippingBarcode?: (scan: ShippingScan) => Promise<ShippingScanResult>; onConfirmShipping?: (rawValue: string) => Promise<ShippingScanResult>; proofId: string; orderLabel: string; captureSessionId?: string; expiresAt?: string; stageType?: string; compatibilityWorkflow?: "GRADING_SUBMISSION"; guide?: { uri: string; headers: Record<string, string> }; }
type NativeRecorder = (request: NativeRecordingRequest) => Promise<LocalCapture | null>;
let nativeRecorder: NativeRecorder | null = null;
export function registerNativeRecorder(recorder: NativeRecorder): () => void {
  nativeRecorder = recorder;
  return () => { if (nativeRecorder === recorder) nativeRecorder = null; };
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

/** Optional grading photographs are separate from the ordinary one-video packing workflow. */
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

export async function recordPackingEvidence(input: {
  client: PackProofV2Client; authorizedSession?: CaptureSessionGrant; autoStart?: boolean; proofId: string; userId: string; orderLabel: string; stageId?: string; stageType?: string; guide?: { uri: string; headers: Record<string, string> };
}): Promise<LocalCapture | null> {
  // Starts are journaled before preflight only after explicit native study opt-in.
  const study=input.stageId?null:await startNativeStudy(input.client,input.userId);
  try{return await recordPackingEvidenceInner(input,study);}catch(error){study?.end('failed','capability');throw error;}
}
async function recordPackingEvidenceInner(input:{client:PackProofV2Client;authorizedSession?:CaptureSessionGrant;autoStart?:boolean;proofId:string;userId:string;orderLabel:string;stageId?:string;stageType?:string;guide?:{uri:string;headers:Record<string,string>}},study:NativeStudyTimer|null):Promise<LocalCapture|null>{
  await capturePreflight(input.client, input.userId, !input.stageId);
  await requestCapturePermissions();
  if (!nativeRecorder) throw new Error("The camera is not ready. Return to this screen and try again.");
  // Authorization exists before a frame is recorded. No gallery or camera-error file path.
  const session = input.authorizedSession ?? await input.client.createCaptureSession(input.proofId, newIdempotencyKey(), input.stageId);
  if (session.proofId !== input.proofId || session.state !== "ISSUED" || Date.parse(session.expiresAt) <= Date.now())
    throw new Error("This camera authorization is no longer ready. Open the original order to recover or restart its recording.");
  const journal: ShippingScanJournal = {proofId:input.proofId,sessionId:session.id,userId:input.userId,entries:[]};
  const queue = shippingQueue(input.client,journal);
  await queue.flush();
  const recovery: CaptureRecoveryState = { version: 1, operationId: session.id, apiBaseUrl: input.client.apiBaseUrl,
    userId: input.userId, proofId: input.proofId, stageId: input.stageId, phase: "RECORDING", evidenceIdempotencyKey: newIdempotencyKey(),
    submitRequested: false, needsSellerAttestation: !input.stageId, attempt: 0, nextRetryAt: null, updatedAt: new Date().toISOString() };
  // Write the account binding before native acquisition. A process restart can discover finalized native media.
  await persistCaptureMetadata({ uri: `${FileSystem.documentDirectory}packproof-captures/${session.id}/video.mp4`, contentType: "video/mp4", byteSize: null, durationMs: null,
    recovery, studyTimingRef:study?.localRef,captureSessionId: session.id, captureProofId: input.proofId, captureUserId: input.userId, captureStageId: input.stageId });
  const captured = await nativeRecorder({ autoStart: input.autoStart, proofId: input.proofId, orderLabel: input.orderLabel, captureSessionId: session.id, expiresAt: session.expiresAt, stageType: input.stageType, guide: input.guide,
    onRecordingStarted:()=>{study?.phase('recording');study?.event('recording_started');},
    onRecordingStopped:()=>{study?.event('recording_stopped');study?.phase('confirmation');},
    ...(!input.stageId ? {onShippingBarcode:async (scan:ShippingScan)=>{
      const result=await queue.detect(scan);
      if(result.status!=='UNRECOGNIZED')study?.event('label_read');
      if(result.status==='CONFLICT')study?.event('label_mismatch');
      return result;
    },onConfirmShipping:queue.confirm} : {}),
  });
  // Each detected scan already journals intent before transport. Capture metadata
  // must never wait for optional label bookkeeping after native finalization.
  void queue.flush().catch(()=>undefined);
  if (!captured) {
    study?.end('cancelled','cancelled');
    releaseShippingQueue(session.id);
    const nativeFile = await FileSystem.getInfoAsync(`${FileSystem.documentDirectory}packproof-captures/${session.id}/video.mp4`);
    if (!nativeFile.exists || !("size" in nativeFile) || nativeFile.size === 0) {
      await FileSystem.deleteAsync(captureJournalUri(session.id), { idempotent: true });
      await input.client.cancelCaptureSession(input.proofId, session.id).catch(() => undefined);
    }
    // A failed finalization can still leave original bytes. Keep its account journal and capture identity for recovery/export.
    return null;
  }
  const shippingBinding = journal.entries.some(e=>e.result.status==="CONFLICT") ? undefined : journal.entries.find(e=>e.result.status==="BOUND")?.result;
  study?.phase('confirmation');
  return persistLocalCapture({ ...captured,studyTimingRef:study?.localRef, recovery: { ...recovery, phase: "LOCAL_ONLY" }, shippingBinding, captureSessionId: session.id, captureProofId: input.proofId, captureUserId: input.userId, captureStageId: input.stageId });
}

const inspections = new Map<string, Promise<EncodedVideoInspection | null>>();
/** Optional local video inspection is shared by review and submission, and never touches original bytes. */
export function inspectCaptureShipping(client: PackProofV2Client, capture: LocalCapture): Promise<EncodedVideoInspection | null> {
  if (!capture.captureSessionId || capture.captureStageId) return Promise.resolve(null);
  if (!capture.captureProofId || !capture.captureUserId || (capture.recovery &&
      capture.recovery.apiBaseUrl.replace(/\/+$/, "") !== client.apiBaseUrl.replace(/\/+$/, "")))
    return Promise.reject(Object.assign(new Error("Open this recording in its original server and account."), { code: "ACCOUNT_CHANGED" }));
  const existing = inspections.get(capture.captureSessionId);
  if (existing) return existing;
  const sessionId = capture.captureSessionId;
  const result = (async () => {
    const journal = await readShippingJournal(sessionId) ?? { proofId: capture.captureProofId!, sessionId, userId: capture.captureUserId!, entries: [] };
    if (journal && (journal.proofId !== capture.captureProofId || journal.userId !== capture.captureUserId))
      throw new Error("Open this recording in its original account.");
    // A saved inspection may outlive a failed scan-journal write. Replay its observations
    // through the same idempotent queue before returning; never silently drop them.
    const inspection = capture.encodedInspection ?? await inspectRecordedVideo(sessionId, journal?.entries.map(entry => entry.scan.detectedAtMs) ?? []);
    if (!inspection) return null;
    capture.encodedInspection = inspection;
    await persistCaptureMetadata(capture);
    if (journal) {
      const queue = shippingQueue(client, journal);
      const study=await nativeStudyForCapture(client,capture.captureUserId!,capture.studyTimingRef);
      for (const observation of inspection.observations) {
        const previousCount=journal.entries.length;
        const result=await queue.detect({ rawValue: observation.rawValue, format: observation.format,
          detectedAtMs: Math.floor(observation.detectedAtMs), idempotencyKey: `${sessionId}:video:${newIdempotencyKey()}`,
          source: "ENCODED_VIDEO_FRAME", coordinateSpace: "DECODED_VIDEO_PIXELS", decoderVersion: observation.decoderVersion,
          frameWidth: observation.frameWidth, frameHeight: observation.frameHeight, bounds: observation.bounds });
        if(journal.entries.length>previousCount&&result.status!=='UNRECOGNIZED')study?.event('label_read');
        if(journal.entries.length>previousCount&&result.status==='CONFLICT')study?.event('label_mismatch');
      }
      await queue.flush();
    }
    return inspection;
  })().finally(() => inspections.delete(sessionId));
  inspections.set(sessionId, result);
  return result;
}

/** Called from focused review, after recording, never while the seller is packing. */
export async function confirmCaptureShipping(client: PackProofV2Client, capture: LocalCapture, observationId: string): Promise<void> {
  if (!capture.captureSessionId || !capture.captureProofId || !capture.captureUserId) throw new Error("Open the original recording to confirm its label.");
  const journal = await readShippingJournal(capture.captureSessionId);
  if (!journal || journal.proofId !== capture.captureProofId || journal.userId !== capture.captureUserId) throw new Error("The saved label is unavailable. Your recording is kept.");
  const entry = journal.entries.find(item => item.result.observationId === observationId);
  if (!entry) throw new Error("This label needs to be checked again. Your recording is kept.");
  const result = await shippingQueue(client, journal).confirm(entry.scan.rawValue);
  if (result.status !== "BOUND") throw new Error(result.status === "CONFLICT" ? "This label differs from the order’s tracking. Check the package before confirming." : "Reconnect to confirm this label. Your recording is kept.");
  capture.shippingBinding = result;
  if (capture.recovery) capture.recovery.authorization = undefined;
  await persistCaptureMetadata(capture);
}

/** Existing grading recipes retain their original actor/recipe checks and evidence origin.
 * This live-camera compatibility path never claims a commerce capture-session attestation.
 */
export async function recordGradingPackingEvidence(input: {
  proofId: string; userId: string; orderLabel: string;
}): Promise<LocalCapture | null> {
  await requestCapturePermissions();
  if (!nativeRecorder) throw new Error("The camera is not ready. Return to this screen and try again.");
  const captured = await nativeRecorder({ proofId: input.proofId, orderLabel: input.orderLabel, compatibilityWorkflow: "GRADING_SUBMISSION" });
  return captured ? persistLocalCapture({ ...captured, captureProofId: input.proofId, captureUserId: input.userId }) : null;
}

/** Stream bounded chunks after recording; hashing never runs in the live capture path. */
export async function bindRecordedCapture(client: PackProofV2Client, capture: LocalCapture, proofId: string, userId: string, stageId?: string): Promise<void> {
  if (!capture.captureSessionId || capture.captureProofId !== proofId || capture.captureUserId !== userId || capture.captureStageId !== stageId)
    throw new Error("This saved recording has no eligible session for this account and Proof. It remains on this device; record a new packing video to meet the current policy.");
  if (!stageId) {
    await inspectCaptureShipping(client, capture).catch(() => null);
    const journal = await readShippingJournal(capture.captureSessionId);
    if (journal) {
      if (journal.proofId!==proofId || journal.userId!==userId) throw new Error("This saved label belongs to another account or Proof.");
      const entries = await shippingQueue(client,journal).retry();
      if (entries.some(e=>e.result.status==="QUEUED")) throw new Error("Your video and label are saved on this device. Reconnect and retry to attach the tracking number before finishing this Proof.");
    }
    const review = await client.getCaptureShippingReview(proofId, capture.captureSessionId);
    if (review.reviewRequired) throw Object.assign(new Error("Check the labels in your recording before confirming. Your original is kept."), { code: "LABEL_REVIEW_REQUIRED", status: 409 });
    if (capture.encodedInspection && !capture.encodedInspection.playable) {
      throw Object.assign(new Error("This recording could not be played. Its original bytes are kept; review them before starting a new take."), { code: "CAPTURE_ORIGINAL_UNPLAYABLE", status: 409 });
    }
  }
  const info = await FileSystem.getInfoAsync(capture.uri);
  if (!info.exists || info.isDirectory || !("size" in info) || info.size <= 0) throw new Error("The original recording is unavailable or empty.");
  const hash = sha256.create();
  for (let position = 0; position < info.size; position += 256 * 1024) {
    const base64 = await FileSystem.readAsStringAsync(capture.uri, { encoding: FileSystem.EncodingType.Base64, position, length: Math.min(256 * 1024, info.size - position) });
    hash.update(toByteArray(base64));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const digest = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const recordedDurationMs = typeof capture.durationMs === "number" && Number.isFinite(capture.durationMs) && capture.durationMs >= 0 && capture.durationMs <= 1_800_000
    ? Math.floor(capture.durationMs)
    : undefined;
  await client.completeCaptureSession(proofId, capture.captureSessionId, {
    sha256: digest, byteSize: info.size, contentType: capture.contentType,
    ...(typeof capture.interrupted === "boolean" ? { interrupted: capture.interrupted } : {}),
    ...(recordedDurationMs !== undefined ? { recordedDurationMs } : {}),
  });
  // The server has accepted this digest for the capture session. Signing uses
  // the freshly computed original hash, never a cached or client-selected hash.
  capture.captureSha256 = digest;
  if (capture.encodedInspection) capture.encodedInspection.originalSha256 = digest;
  capture.byteSize = info.size;
  await persistCaptureMetadata(capture);
  releaseShippingQueue(capture.captureSessionId);
}

/** Bookmarks are an optional index. An index failure must never invalidate committed bytes. */
export async function saveCaptureBookmarks(client: PackProofV2Client, proofId: string, evidenceId: string, capture: LocalCapture): Promise<void> {
  const scannerBookmarks: CaptureBookmark[] = (capture.encodedInspection?.observations ?? []).map(observation => ({
    label: "Label read from video (approximate moment)", startMs: Math.floor(observation.detectedAtMs),
    endMs: Math.floor(observation.detectedAtMs) + 1000, sourceType: "SCANNER_TRIGGERED", recipeVersion: "encoded-label-review-v1",
  }));
  const bookmarks = [...(capture.bookmarks ?? []), ...scannerBookmarks];
  if (!bookmarks.length) return;
  const view = await client.signatureRequest<{ snapshot: { data: { evidence: Array<{ evidenceId: string; capturedDurationMs?: number | null }> } } }>(proofId);
  const duration = view.snapshot.data.evidence.find((item) => item.evidenceId === evidenceId)?.capturedDurationMs ?? capture.durationMs;
  for (const [index, bookmark] of bookmarks.entries()) {
    const endMs = duration ? Math.min(bookmark.endMs, Math.floor(duration)) : bookmark.endMs;
    if (bookmark.startMs >= endMs) continue;
    const anchor = await client.signatureRequest<{ anchorId: string }>(proofId, "/anchors", "POST", { ...bookmark, endMs, evidenceId, ...(capture.captureStageId ? { stageId: capture.captureStageId } : {}), idempotencyKey: `${capture.captureSessionId}:bookmark:${index}` });
    if (!capture.captureStageId) await client.disclosureRequest(proofId, `/thumbnails/${encodeURIComponent(anchor.anchorId)}`, "POST", {}).catch(() => undefined);
  }
}

export function durableCaptureUri(): string {
  const directory = FileSystem.documentDirectory;
  if (!directory) {
    throw new Error("Local document storage is unavailable.");
  }
  return `${directory}${LOCAL_CAPTURE_NAME}`;
}

export async function persistLocalCapture(capture: LocalCapture): Promise<LocalCapture> {
  if (!FileSystem.documentDirectory) throw new Error("Local document storage is unavailable.");
  // The unified native camera already writes to protected document storage. Keep that unique original.
  const dest = capture.uri.startsWith(FileSystem.documentDirectory) ? capture.uri : `${FileSystem.documentDirectory}packproof-evidence-${newIdempotencyKey()}.mp4`;
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
  const durable: LocalCapture = {
    ...capture,
    uri: dest,
    contentType: capture.contentType || "video/mp4",
    byteSize: "size" in info && typeof info.size === "number" ? info.size : capture.byteSize,
    durationMs: capture.durationMs,
  };
  await persistCaptureMetadata(durable);
  return durable;
}

export async function persistCaptureMetadata(capture: LocalCapture): Promise<void> {
  if (capture.recovery) {
    capture.recovery.updatedAt = new Date().toISOString();
    const path = captureJournalUri(capture.recovery.operationId);
    await FileSystem.writeAsStringAsync(`${path}.tmp`, JSON.stringify(capture));
    await FileSystem.moveAsync({ from: `${path}.tmp`, to: path });
  }
  const info = await FileSystem.getInfoAsync(capture.uri);
  if (info.exists) {
    await FileSystem.writeAsStringAsync(`${capture.uri}.json.tmp`, JSON.stringify(capture));
    await FileSystem.moveAsync({ from: `${capture.uri}.json.tmp`, to: `${capture.uri}.json` });
  }
}

export function captureJournalUri(operationId: string): string {
  if (!FileSystem.documentDirectory || !/^[a-zA-Z0-9_-]+$/.test(operationId)) throw new Error("Invalid local operation identity");
  return `${FileSystem.documentDirectory}packproof-journal-${operationId}.json`;
}

export async function listAccountCaptures(apiBaseUrl: string, userId: string): Promise<LocalCapture[]> {
  if (!FileSystem.documentDirectory) return [];
  const names = await FileSystem.readDirectoryAsync(FileSystem.documentDirectory);
  const captures: LocalCapture[] = [];
  for (const name of names.filter(name => /^packproof-journal-[a-zA-Z0-9_-]+\.json$/.test(name))) {
    let capture: LocalCapture;
    try { capture = JSON.parse(await FileSystem.readAsStringAsync(`${FileSystem.documentDirectory}${name}`)); } catch { continue; }
    const state = capture.recovery;
    if (!state || state.userId !== userId || state.apiBaseUrl.replace(/\/+$/, "") !== apiBaseUrl.replace(/\/+$/, "")) continue;
    if (!capture.uri.startsWith(FileSystem.documentDirectory)) continue;
    if (state.phase === "RECORDING") {
      try {
        const finalized = JSON.parse(await FileSystem.readAsStringAsync(`${capture.uri}.finalized.json`));
        if (finalized.complete === true && finalized.byteSize > 0 && finalized.durationMs > 0) {
          capture.byteSize = finalized.byteSize; capture.durationMs = finalized.durationMs;
          capture.interrupted = true; state.phase = "LOCAL_ONLY";
          await persistCaptureMetadata(capture);
        }
      } catch { /* Keep an incomplete native recording available for inspection; never fabricate a usable original. */ }
    }
    captures.push(capture);
  }
  return captures.sort((a, b) => (b.recovery?.updatedAt ?? "").localeCompare(a.recovery?.updatedAt ?? ""));
}

export async function localCaptureExists(uri: string | null | undefined): Promise<boolean> {
  if (!uri) {
    return false;
  }
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && !info.isDirectory;
}

export async function discardLocalCapture(uri: string | null | undefined, operationId?: string): Promise<void> {
  if (!uri) {
    return;
  }
  try {
    let saved: LocalCapture | null = null;
    try { saved = JSON.parse(await FileSystem.readAsStringAsync(`${uri}.json`)); } catch { /* Legacy file. */ }
    // The caller already owns deliberate discard or receipt-checked cleanup. Remove only
    // this original's three fixed local review derivatives, never another session or path.
    // No directory sweep: journals can contain user-controlled strings on legacy installs.
    const sessionId = saved?.captureSessionId;
    const nativeDirectory = sessionId && /^cap_[A-Za-z0-9_-]{1,91}$/.test(sessionId)
      ? `${FileSystem.documentDirectory}packproof-captures/${sessionId}/` : null;
    if (nativeDirectory && uri === `${nativeDirectory}video.mp4`) {
      for (let index = 0; index < 3; index += 1) await FileSystem.deleteAsync(`${nativeDirectory}review-frame-${index}.png`, { idempotent: true });
    }
    await FileSystem.deleteAsync(uri, { idempotent: true });
    await FileSystem.deleteAsync(`${uri}.finalized.json`, { idempotent: true });
    if (saved?.recovery || operationId) await FileSystem.deleteAsync(captureJournalUri(saved?.recovery?.operationId ?? operationId!), { idempotent: true });
    await FileSystem.deleteAsync(`${uri}.json`, { idempotent: true });
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
  let metadata: Partial<LocalCapture> = {};
  try { metadata = JSON.parse(await FileSystem.readAsStringAsync(`${uri}.json`)); } catch { /* Legacy origin remains unknown. */ }
  return {
    ...metadata,
    uri,
    contentType: metadata.contentType ?? fallback.contentType ?? "video/mp4",
    byteSize:
      "size" in info && typeof info.size === "number" ? info.size : (fallback.byteSize ?? null),
    durationMs: metadata.durationMs ?? fallback.durationMs ?? null,
  };
}

export async function uploadCaptureFile(input: {
  baseUrl: string;
  target: UploadTarget;
  fileUri: string;
  contentType: string;
  onProgress?: (percent: number) => void;
}): Promise<void> {
  if (input.target.received) { input.onProgress?.(100); return; }
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
    result = await withRequestTimeout(async (signal) => {
      const cancel = () => { void task.cancelAsync().catch(() => undefined); };
      signal.addEventListener("abort", cancel);
      try {
        return await task.uploadAsync();
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }, 10 * 60_000);
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
    throw new Error(`This recording exceeds the server limit of ${formatBytes(state.partSize * state.maxParts)}. The original remains on this device.`);
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
