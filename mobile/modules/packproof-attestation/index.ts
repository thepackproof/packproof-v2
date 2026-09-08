import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

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

const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeAttestation>('PackProofAttestation')
  : null;

function unavailable(): AttestationAvailability {
  return Platform.OS !== 'android'
    ? { available: false, code: 'ATTESTATION_ANDROID_REQUIRED', message: 'Use the Android app to attest and submit this Proof.' }
    : { available: false, code: 'ATTESTATION_UPGRADE_REQUIRED', message: 'Update PackProof to use fingerprint attestation.' };
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

/** Returns only an SPKI DER public key, encoded as base64. The private key stays in Android Keystore. */
export async function prepareAttestationKey(userId: string): Promise<{ publicKey: string }> {
  return native().prepareKey(userId);
}

/** Android authorizes this exact signature using a fresh strong biometric prompt. */
export async function signAttestationPayload(userId: string, payload: string): Promise<{ signature: string }> {
  return native().sign(userId, payload);
}

export async function cancelAttestation(): Promise<void> {
  await nativeModule?.cancel();
}
