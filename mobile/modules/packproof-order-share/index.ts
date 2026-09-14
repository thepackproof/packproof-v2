import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type SharedOrder = { id: string; text: string; warnings: string[]; attachmentCount: number };
type NativeOrderShare = {
  listPending(): Promise<Array<{ id: string; createdAt: number; attachmentCount: number }>>;
  readOrder(id: string): Promise<SharedOrder>;
  acknowledge(id: string): Promise<void>;
};

export const orderShare = Platform.OS === 'ios'
  ? requireOptionalNativeModule<NativeOrderShare>('PackProofOrderShare')
  : null;
