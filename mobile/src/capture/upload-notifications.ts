import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as Notifications from 'expo-notifications';
import { localUploadNotificationsAllowed } from '../notifications/client';
import type { CompletionCapture, CompletionProof } from './recover-completion';
import { uploadCompletionConfirmed } from './upload-outcome';

const native = Platform.OS === 'android' ? requireOptionalNativeModule<{
  beginUploadService?(operationId: string): Promise<boolean>;
  endUploadService?(operationId: string): Promise<void>;
  notifyUploadComplete?(operationId: string, proofId: string): Promise<boolean>;
}>('PackProofUnifiedCamera') : null;

/** Permission denial never blocks recording or the durable upload queue. */
export async function requestUploadNotifications(): Promise<void> {
  if (Platform.OS === 'ios' && AppState.currentState === 'active') {
    try {
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted && permission.canAskAgain && permission.ios?.status !== Notifications.IosAuthorizationStatus.PROVISIONAL)
        await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } });
    } catch { /* Notification permission never prevents preserving a recording. */ }
    return;
  }
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
  if (Platform.OS === 'ios' && localUploadNotificationsAllowed(capture.recovery.userId, capture.recovery.apiBaseUrl, proof.proofId)) {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
      await Notifications.scheduleNotificationAsync({
        identifier: `packproof-upload-${capture.recovery.operationId}`,
        content: { title: 'Proof ready', body: 'Your recording has uploaded and your Proof is ready to view.',
          data: { userId: capture.recovery.userId, proofId: proof.proofId, category: 'uploads' }, sound: 'default' },
        trigger: null,
      });
    }
  } else if (Platform.OS === 'android') await native?.notifyUploadComplete?.(capture.recovery.operationId, proof.proofId);
  // Denied/disabled permission is handled without repeatedly alerting on old work.
  capture.recovery.completionNotificationHandled = true;
}
