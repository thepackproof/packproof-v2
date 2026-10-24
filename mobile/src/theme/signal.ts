import { colorsForScheme, type ColorScheme, type ThemeColors } from './tokens';
import { eimPalette, eimColors, eimTypography } from '../../../packages/evidence-in-motion/tokens.generated';

/** Compatibility names over the versioned Evidence in Motion presentation contract. */
export const signal = eimPalette;
export function signalColors(scheme: ColorScheme): ThemeColors {
  return { ...colorsForScheme(scheme), ...eimColors[scheme] };
}
export const signalType = eimTypography;
