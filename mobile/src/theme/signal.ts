import { colorsForScheme, type ColorScheme, type ThemeColors } from './tokens';

/** SIGNAL semantic roles. Mint is reserved for canonical saved evidence. */
export const signal = {
  canvas: '#F3F5F4', paper: '#FFFFFF', ink: '#111916', secondary: '#53605A',
  line: '#CBD3CE', wash: '#E7ECE8', cobalt: '#3158D5', pressed: '#2445B3',
  cobaltInk: '#2547AA', cobaltWash: '#E9EEFF', mint: '#70E4C2', mintInk: '#073D2E',
  lavender: '#DAD4F0', camera: '#18221F', cameraMuted: '#A7B6AE',
  recording: '#E95A5A', error: '#C13338', illustrationTape: '#F36B3F',
} as const;

export function signalColors(scheme: ColorScheme): ThemeColors {
  const dark = scheme === 'dark';
  const ink = dark ? '#F3F5F4' : signal.ink;
  const secondary = dark ? '#B8C5BD' : signal.secondary;
  const canvas = dark ? '#111916' : signal.canvas;
  const paper = dark ? '#18221F' : signal.paper;
  const wash = dark ? '#26342E' : signal.wash;
  const line = dark ? '#44564C' : signal.line;
  return {
    ...colorsForScheme(scheme), background: canvas, surface: paper, surfaceElevated: paper,
    surfacePressed: wash, textPrimary: ink, textSecondary: secondary, textMuted: secondary,
    textOnPrimary: '#FFFFFF', border: line, controlBorder: dark ? '#899B90' : '#75857B', divider: line,
    accent: signal.cobalt, accentPressed: signal.pressed, accentText: dark ? '#A9BAFF' : signal.cobaltInk,
    accentSoft: dark ? '#23325E' : signal.cobaltWash, accentSoftBorder: dark ? '#52669E' : '#B6C4F7',
    primary: signal.cobalt, primaryHover: signal.pressed, primaryPressed: signal.pressed,
    logoBlue: signal.cobalt, logoGreen: signal.mint, fab: signal.cobalt,
    success: signal.mint, successSoft: signal.mint, successSoftBorder: '#4EBB9F', successText: signal.mintInk,
    warning: secondary, warningText: secondary, warningSoft: wash, warningSoftBorder: line,
    error: dark ? '#FF9B9F' : signal.error, errorMuted: dark ? '#FF9B9F' : signal.error,
    errorSoft: dark ? '#46272B' : '#FFEBEB', inputBackground: paper, disabledBackground: wash, disabledText: secondary,
    scanBackground: signal.camera, scanText: '#FFFFFF', scanMuted: signal.cameraMuted,
    shipment: secondary, shipmentSoft: wash, shipmentText: secondary,
    commerce: signal.cobalt, proof: signal.cobalt, evidence: dark ? '#DAD4F0' : '#645484',
    integrity: secondary, integrityText: secondary, integritySoft: wash,
    navigationBar: canvas, statusBar: canvas,
  };
}

export const signalType = {
  display: { fontFamily: 'SpaceGrotesk-Bold', fontSize: 44, lineHeight: 46, letterSpacing: -1.8 },
  title: { fontFamily: 'SpaceGrotesk-Bold', fontSize: 36, lineHeight: 40, letterSpacing: -1.1 },
  heading: { fontFamily: 'SpaceGrotesk-Bold', fontSize: 25, lineHeight: 30, letterSpacing: -0.5 },
  subheading: { fontFamily: 'SpaceGrotesk-Bold', fontSize: 20, lineHeight: 25, letterSpacing: -0.3 },
  body: { fontFamily: 'Manrope', fontSize: 16, lineHeight: 24 },
  strong: { fontFamily: 'Manrope-SemiBold', fontSize: 16, lineHeight: 23 },
  small: { fontFamily: 'Manrope', fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: 'Manrope-SemiBold', fontSize: 12, lineHeight: 17 },
  mono: { fontFamily: 'IBMPlexMono-Medium', fontSize: 11, lineHeight: 16, letterSpacing: 0.5 },
  receipt: { fontFamily: 'SpaceGrotesk-Bold', fontSize: 56, lineHeight: 56, letterSpacing: -2 },
} as const;
