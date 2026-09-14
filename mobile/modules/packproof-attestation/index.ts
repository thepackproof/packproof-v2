import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { NativeAttestationMethod } from '../../src/attestation/authorization';

export type AttestationAvailability = {
  available: boolean;
  code?: string;
  message?: string;
};

type NativeAttestation = {
  getAvailability(): Promise<AttestationAvailability>;
  prepareKey(userId: string): Promise<{ publicKey: string }>;
  sign(userId: string, payload: string): Promise<{ signature: string }>;
  cancel(): Promise<void>;
};

const nativeModule = Platform.OS === 'android' || Platform.OS === 'ios'
  ? requireOptionalNativeModule<NativeAttestation>('PackProofAttestation')
  : null;

function unavailable(): AttestationAvailability {
  return Platform.OS !== 'android' && Platform.OS !== 'ios'
    ? { available: false, code: 'ATTESTATION_NATIVE_REQUIRED', message: 'Use the PackProof mobile app to attest and submit this recording.' }
    : { available: false, code: 'ATTESTATION_UPGRADE_REQUIRED', message: 'Update PackProof to use biometric attestation.' };
}

export function getAttestationMethod(): NativeAttestationMethod {
  if (Platform.OS === 'ios') return 'IOS_BIOMETRIC';
  if (Platform.OS === 'android') return 'ANDROID_BIOMETRIC_STRONG';
  const status = unavailable();
  throw Object.assign(new Error(status.message), { code: status.code });
}

function native(): NativeAttestation {
  if (nativeModule) return nativeModule;
  const status = unavailable();
  throw Object.assign(new Error(status.message), { code: status.code });
}

/** Only availability is inspected. No biometric image, template, or identifier is read. */
export async function getAttestationAvailability(): Promise<AttestationAvailability> {
  return nativeModule ? nativeModule.getAvailability() : unavailable();
}

/** Returns only a base64 SPKI DER public key; private keys stay in the native key store. */
export async function prepareAttestationKey(userId: string): Promise<{ publicKey: string }> {
  return native().prepareKey(userId);
}

/** The operating system authorizes this exact signature using a fresh biometric prompt. */
export async function signAttestationPayload(userId: string, payload: string): Promise<{ signature: string }> {
  return native().sign(userId, payload);
}

export async function cancelAttestation(): Promise<void> {
  await nativeModule?.cancel();
}
