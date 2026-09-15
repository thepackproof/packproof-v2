import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = Platform.OS === 'ios'
  ? requireOptionalNativeModule<{ externalCheckoutAllowed(): Promise<boolean> }>('PackProofStorefront')
  : null;

/** Storefront is the Apple purchasing account's region, never language, GPS, or IP. */
export async function getExternalCheckoutAllowed(): Promise<boolean> {
  if (!native) return false;
  try { return await native.externalCheckoutAllowed(); } catch { return false; }
}
