import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type IntakeSurface = 'ANDROID_SHARE' | 'IOS_SHARE' | 'EXPLICIT_PASTE';
export interface SharedOrderReceipt {
  id: string;
  clientSubmissionId: string;
  createdAt: string | number;
  accountId: string | null;
  deliveryState: 'LOCAL_PENDING' | 'SERVER_ACCEPTED';
  serverSubmissionId: string | null;
  attachmentCount: number;
  errorCode?: string | null;
}
export interface SharedOrder extends SharedOrderReceipt {
  text: string;
  payloadKind: 'TEXT' | 'URL';
  surface?: IntakeSurface;
  payloadHash: string;
  warnings: string[];
}
export interface IntakeNativeSession {
  token: string; sessionId: string; accountId: string; accountLabel: string;
  expiresAt: string; apiBaseURL: string;
}
export interface NativeOrderShare {
  listPending(): Promise<SharedOrderReceipt[]>;
  readOrder(id: string): Promise<SharedOrder>;
  assignAccount(id: string, accountId: string): Promise<void>;
  acknowledge(id: string, serverSubmissionId: string): Promise<void>;
  discard(id: string): Promise<void>;
  setActiveAccount(accountId: string | null): Promise<void>;
  enqueue(text: string, payloadKind: 'TEXT' | 'URL', surface: IntakeSurface): Promise<SharedOrder>;
  setIntakeSession(session: IntakeNativeSession): Promise<void>;
  clearIntakeSession(): Promise<void>;
}
export const orderShare = ['ios', 'android'].includes(Platform.OS)
  ? requireOptionalNativeModule<NativeOrderShare>('PackProofOrderShare') : null;
