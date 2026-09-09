import React from 'react';
import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

export type UnifiedCameraResult = {
  uri: string;
  durationMs: number;
  byteSize: number;
  interrupted: boolean;
};

export type UnifiedBarcodeDetection = {
  rawValue: string;
  format: string;
  /** Approximate video seek point from CameraX encoder progress; not an exact frame PTS. */
  detectedAtMs: number;
  detectedAtUnixMs: number;
  latencyMs: number;
  source?: "LIVE_CAMERA_ANALYSIS" | "ENCODED_VIDEO_FRAME";
  coordinateSpace?: "ROTATED_ANALYSIS_PIXELS" | "DECODED_VIDEO_PIXELS";
  decoderVersion?: string;
  frameWidth?: number;
  frameHeight?: number;
  bounds?: { left: number; top: number; right: number; bottom: number } | null;
};

export type UnifiedCameraViewRef = {
  /** Resolves after VideoRecordEvent.Finalize; do not await this before enabling Stop. */
  startRecording(sessionId: string, audioEnabled: boolean): Promise<UnifiedCameraResult>;
  /** Requests finalization. Await startRecording's promise for the completed file. */
  stopRecording(): Promise<void>;
};

type NativeEvent<T> = { nativeEvent: T };

export type UnifiedCameraViewProps = ViewProps & {
  active: boolean;
  torchEnabled: boolean;
  onReady?: (event: NativeEvent<Record<string, never>>) => void;
  onBarcodeDetected?: (event: NativeEvent<UnifiedBarcodeDetection>) => void;
  onRecordingStarted?: (event: NativeEvent<{ startedAtUnixMs: number }>) => void;
  onCaptureError?: (event: NativeEvent<{ code: string; message: string }>) => void;
};

export interface EncodedVideoInspection {
  playable: boolean;
  inspectedFrames: number;
  durationMs: number;
  observations: Array<UnifiedBarcodeDetection & { source: "ENCODED_VIDEO_FRAME" }>;
  frames: Array<{ uri: string; sha256: string; requestedOffsetMs: number; timestampPrecision: "NEAR_REQUESTED_TIME"; transform: string }>;
  timestampPrecision: "NEAR_REQUESTED_TIME";
}

const nativeModule = Platform.OS === 'android' ? requireOptionalNativeModule<{ bindCaptureContext?(sessionId:string,proofId:string,contextJson:string):Promise<void>; readCaptureJournal?(sessionId:string):Promise<string>; getHapticsEnabled(): Promise<boolean>; newOperationNonce(): string; inspectRecordedVideo?(sessionId: string, offsetsMs: number[]): Promise<EncodedVideoInspection> }>('PackProofUnifiedCamera') : null;
const nativeAvailable = nativeModule != null;
export function newStudyOperationNonce():string {
  if(!nativeModule?.newOperationNonce)throw new Error('This build cannot enable study collection. Install the current native build.');
  return nativeModule.newOperationNonce();
}
export async function systemHapticsEnabled(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try { return nativeModule ? await nativeModule.getHapticsEnabled() : false; } catch { return false; }
}

/** Reads only this session's finalized original; older installed bundles truthfully return unavailable. */
export async function inspectRecordedVideo(sessionId: string, offsetsMs: number[]): Promise<EncodedVideoInspection | null> {
  return nativeModule?.inspectRecordedVideo ? nativeModule.inspectRecordedVideo(sessionId, offsetsMs.slice(0, 8)) : null;
}

export function isUnifiedCameraAvailable(): boolean {
  return nativeAvailable;
}

const NativeView = nativeAvailable
  ? requireNativeViewManager<UnifiedCameraViewProps & React.RefAttributes<UnifiedCameraViewRef>>('PackProofUnifiedCamera')
  : null;

/** Android-only hardware spike. The caller must unmount every other camera first. */
export const UnifiedCameraView = React.forwardRef<UnifiedCameraViewRef, UnifiedCameraViewProps>(
  function UnifiedCameraView(props, ref) {
    if (!NativeView) return null;
    return <NativeView {...props} ref={ref} />;
  },
);

export async function bindNativeCaptureContext(sessionId:string,proofId:string,contextJson:string):Promise<void> {
  if(!nativeModule?.bindCaptureContext) throw new Error('Install the current capture build before opening this recording.');
  await nativeModule.bindCaptureContext(sessionId,proofId,contextJson);
}
export async function readNativeCaptureJournal(sessionId:string):Promise<string> {
  if(!nativeModule?.readCaptureJournal) throw new Error('This build cannot recover the native capture journal.');
  return nativeModule.readCaptureJournal(sessionId);
}

export function isNativeCaptureEngineAvailable():boolean {return !!nativeModule?.bindCaptureContext && !!nativeModule?.readCaptureJournal;}
