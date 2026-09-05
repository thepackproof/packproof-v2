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
  /** Approximate video offset, anchored to CameraX's native recording-start callback. */
  detectedAtMs: number;
  detectedAtUnixMs: number;
  latencyMs: number;
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

const nativeAvailable = Platform.OS === 'android'
  && requireOptionalNativeModule('PackProofUnifiedCamera') != null;

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
