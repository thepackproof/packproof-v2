import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { CompletionCapture, CompletionProof } from './recover-completion';
import { uploadCompletionConfirmed } from './upload-outcome';

const native = Platform.OS === 'android' ? requireOptionalNativeModule<{
  beginUploadService?(operationId: string): Promise<boolean>;
  endUploadService?(operationId: string): Promise<void>;
  notifyUploadComplete?(operationId: string, proofId: string): Promise<boolean>;
}>('PackProofUnifiedCamera') : null;

/** Permission denial never blocks recording or the durable upload queue. */
export async function requestUploadNotifications(): Promise<void> {
  if (!native?.notifyUploadComplete || Number(Platform.Version) < 33 || AppState.currentState !== 'active') return;
  try {
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (!await PermissionsAndroid.check(permission)) await PermissionsAndroid.request(permission);
  } catch { /* In-app upload state remains available. */ }
}
export async function beginUploadService(operationId: string): Promise<void> {
  try { await native?.beginUploadService?.(operationId); } catch { /* Original and queue survive OS restrictions. */ }
}
export async function endUploadService(operationId: string): Promise<void> {
  try { await native?.endUploadService?.(operationId); } catch { /* Native lease is time bounded. */ }
}
export async function notifyUploadOutcome(capture: CompletionCapture, proof: CompletionProof): Promise<void> {
  if (capture.recovery.completionNotificationHandled || !uploadCompletionConfirmed(capture, proof)) return;
  await native?.notifyUploadComplete?.(capture.recovery.operationId, proof.proofId);
  // Denied/disabled permission is handled without repeatedly alerting on old work.
  capture.recovery.completionNotificationHandled = true;
}
