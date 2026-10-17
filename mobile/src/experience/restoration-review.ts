import { Platform } from 'react-native';

/** G2 review composition only; store profiles do not enable this flag. */
export const EXPERIENCE_RESTORATION_REVIEW = Platform.OS === 'android'
  && process.env.EXPO_PUBLIC_PACKPROOF_EXPERIENCE_RESTORATION === 'true';
