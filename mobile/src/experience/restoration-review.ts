import { Platform } from 'react-native';

/** Approved Android restoration; explicitly enabled by the production profile. */
export const EXPERIENCE_RESTORATION_REVIEW = Platform.OS === 'android'
  && process.env.EXPO_PUBLIC_PACKPROOF_EXPERIENCE_RESTORATION === 'true';
