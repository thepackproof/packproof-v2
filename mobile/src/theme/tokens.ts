export type ColorScheme = "light" | "dark";

export type AppearancePreference = "system" | "light" | "dark";

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceElevated: string;
  surfacePressed: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnPrimary: string;
  border: string;
  divider: string;
  accent: string;
  accentPressed: string;
  accentSoft: string;
  accentSoftBorder: string;
  accentText: string;
  primary: string;
  primaryHover: string;
  logoBlue: string;
  logoGreen: string;
  primaryPressed: string;
  success: string;
  successSoft: string;
  successSoftBorder: string;
  successText: string;
  warning: string;
  warningSoft: string;
  warningSoftBorder: string;
  warningText: string;
  error: string;
  errorMuted: string;
  errorSoft: string;
  inputBackground: string;
  disabledBackground: string;
  disabledText: string;
  overlay: string;
  scanBackground: string;
  scanText: string;
  scanMuted: string;
  fab: string;
  shipment: string;
  commerce: string;
  proof: string;
  evidence: string;
  integrity: string;
  navigationBar: string;
  statusBar: string;
}

export interface ThemeShadows {
  card: {
    shadowColor: string;
    shadowOffset: { width: number; height: number };
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
  };
  tab: {
    shadowColor: string;
    shadowOffset: { width: number; height: number };
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
  };
  create: {
    shadowColor: string;
    shadowOffset: { width: number; height: number };
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
  };
}

/** Approved UI palette. Bright logo accents are reserved for brand artwork. */
export const lightColors: ThemeColors = {
  background: "#E9EEF4",
  surface: "#F7F9FC",
  surfaceElevated: "#E2E8F0",
  surfacePressed: "#E2E8F0",
  textPrimary: "#23262D",
  textSecondary: "#526174",
  textMuted: "#526174",
  textOnPrimary: "#FFFFFF",
  border: "#CBD5E1",
  divider: "#CBD5E1",
  accent: "#1769D2",
  accentPressed: "#104790",
  accentSoft: "#E6F0FF",
  accentSoftBorder: "#CBD5E1",
  accentText: "#1769D2",
  primary: "#1769D2",
  primaryHover: "#1255AD",
  primaryPressed: "#104790",
  logoBlue: "#2583E9",
  logoGreen: "#20AA70",
  success: "#14805E",
  successSoft: "#E5F5ED",
  successSoftBorder: "#CBD5E1",
  successText: "#14805E",
  warning: "#895000",
  warningSoft: "#FFF1D6",
  warningSoftBorder: "#CBD5E1",
  warningText: "#895000",
  error: "#B42318",
  errorMuted: "#B42318",
  errorSoft: "#FEECEB",
  inputBackground: "#F7F9FC",
  disabledBackground: "#E2E8F0",
  disabledText: "#526174",
  overlay: "rgba(35, 38, 45, 0.48)",
  scanBackground: "#23262D",
  scanText: "#FFFFFF",
  scanMuted: "#E2E8F0",
  fab: "#1769D2",
  shipment: "#1769D2",
  commerce: "#526174",
  proof: "#23262D",
  evidence: "#1769D2",
  integrity: "#526174",
  navigationBar: "#E9EEF4",
  statusBar: "#E9EEF4",
};

/** Existing optional dark appearance keeps cool surfaces and the same semantic roles. */
export const darkColors: ThemeColors = {
  background: "#18202B",
  surface: "#232C39",
  surfaceElevated: "#2C3747",
  surfacePressed: "#344256",
  textPrimary: "#F7F9FC",
  textSecondary: "#CBD5E1",
  textMuted: "#CBD5E1",
  textOnPrimary: "#FFFFFF",
  border: "#526174",
  divider: "#526174",
  accent: "#1769D2",
  accentPressed: "#104790",
  accentSoft: "#243C5B",
  accentSoftBorder: "#526174",
  accentText: "#91BEF5",
  primary: "#1769D2",
  primaryHover: "#1255AD",
  primaryPressed: "#104790",
  logoBlue: "#2583E9",
  logoGreen: "#20AA70",
  success: "#14805E",
  successSoft: "#193D33",
  successSoftBorder: "#526174",
  successText: "#7AD4B5",
  warning: "#895000",
  warningSoft: "#45351C",
  warningSoftBorder: "#526174",
  warningText: "#F5CB80",
  error: "#FFB4AA",
  errorMuted: "#FFB4AA",
  errorSoft: "#4D292B",
  inputBackground: "#232C39",
  disabledBackground: "#2C3747",
  disabledText: "#CBD5E1",
  overlay: "rgba(35, 38, 45, 0.48)",
  scanBackground: "#23262D",
  scanText: "#FFFFFF",
  scanMuted: "#E2E8F0",
  fab: "#1769D2",
  shipment: "#1769D2",
  commerce: "#CBD5E1",
  proof: "#F7F9FC",
  evidence: "#1769D2",
  integrity: "#CBD5E1",
  navigationBar: "#18202B",
  statusBar: "#18202B",
};

export function colorsForScheme(scheme: ColorScheme): ThemeColors {
  return scheme === "dark" ? darkColors : lightColors;
}

export function shadowsFor(scheme: ColorScheme): ThemeShadows {
  const shadowColor = scheme === "dark" ? "#000000" : lightColors.textPrimary;
  return {
    card: {
      shadowColor,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0,
      shadowRadius: 8,
      elevation: 0,
    },
    tab: {
      shadowColor,
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: 0,
      shadowRadius: 8,
      elevation: 0,
    },
    create: {
      shadowColor,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0,
      shadowRadius: 10,
      elevation: 0,
    },
  };
}

export function sourceColor(colors: ThemeColors, kind: "PROOF" | "COMMERCE" | "SHIPMENT" | "EVIDENCE" | "INTEGRITY"): string {
  switch (kind) {
    case "COMMERCE":
      return colors.commerce;
    case "SHIPMENT":
      return colors.shipment;
    case "EVIDENCE":
      return colors.evidence;
    case "INTEGRITY":
      return colors.integrity;
    default:
      return colors.proof;
  }
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
} as const;

export const radii = {
  sm: 4,
  md: 6,
  lg: 8,
  pill: 8,
} as const;

export const typography = {
  pageTitle: { fontFamily: "NotoSerif-Bold", fontSize: 28, lineHeight: 34, fontWeight: "700" as const },
  sectionTitle: { fontFamily: "NotoSerif-Bold", fontSize: 18, lineHeight: 24, fontWeight: "700" as const },
  cardTitle: { fontFamily: "NotoSans-Bold", fontSize: 16, lineHeight: 22, fontWeight: "700" as const },
  body: { fontFamily: "NotoSans", fontSize: 16, lineHeight: 24, fontWeight: "400" as const },
  bodyStrong: { fontFamily: "NotoSans-Bold", fontSize: 16, lineHeight: 24, fontWeight: "600" as const },
  secondary: { fontFamily: "NotoSans", fontSize: 14, lineHeight: 20, fontWeight: "400" as const },
  secondaryStrong: { fontFamily: "NotoSans-Bold", fontSize: 14, lineHeight: 20, fontWeight: "600" as const },
  caption: { fontFamily: "NotoSans-Bold", fontSize: 14, lineHeight: 20, fontWeight: "500" as const },
  button: { fontFamily: "NotoSans-Bold", fontSize: 16, lineHeight: 20, fontWeight: "700" as const },
  greeting: { fontFamily: "NotoSerif-Bold", fontSize: 22, lineHeight: 28, fontWeight: "700" as const },
} as const;

export const sizes = {
  touch: 48,
  icon: 22,
  iconSm: 18,
  iconLg: 28,
  logoSm: 28,
  logoMd: 40,
  logoLg: 72,
  tabBar: 56,
  avatar: 40,
  createFab: 76,
} as const;

/** @deprecated Prefer `useTheme().colors`. Light-only aliases for any remaining static callers. */
export const colors = {
  navy: lightColors.textPrimary,
  blue: lightColors.accent,
  green: lightColors.success,
  slate: lightColors.textSecondary,
  background: lightColors.background,
  border: lightColors.border,
  white: lightColors.surface,
  text: lightColors.textPrimary,
  textSecondary: lightColors.textSecondary,
  textMuted: lightColors.textMuted,
  danger: lightColors.error,
  dangerMuted: lightColors.errorMuted,
  dangerBg: lightColors.errorSoft,
  overlay: lightColors.overlay,
  navyMuted: lightColors.primaryPressed,
  blueSoft: lightColors.accentSoft,
  greenSoft: lightColors.successSoft,
  purpleSoft: lightColors.surfaceElevated,
  warningSoft: lightColors.warningSoft,
  scanBg: lightColors.scanBackground,
  scanInk: lightColors.scanText,
  scanMuted: lightColors.scanMuted,
} as const;

export const shadows = shadowsFor("light");

export const sourceColors = {
  PROOF: lightColors.proof,
  COMMERCE: lightColors.commerce,
  SHIPMENT: lightColors.shipment,
  PARTICIPANT: lightColors.textSecondary,
  EVIDENCE: lightColors.evidence,
  INTEGRITY: lightColors.integrity,
} as const;
