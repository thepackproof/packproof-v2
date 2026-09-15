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
  controlBorder: string;
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
  shipmentSoft: string;
  shipmentText: string;
  commerce: string;
  proof: string;
  evidence: string;
  integrity: string;
  integritySoft: string;
  integrityText: string;
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

/** Flat brand surfaces; action blue and selection green have distinct roles. */
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
  controlBorder: "#7C8794",
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
  successSoft: "#E7F6EF",
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
  shipment: "#159CA5",
  shipmentSoft: "#E4F7F8",
  shipmentText: "#0F767D",
  commerce: "#1769D2",
  proof: "#1769D2",
  evidence: "#7C5CE7",
  integrity: "#7C5CE7",
  integritySoft: "#F0EBFF",
  integrityText: "#6341C6",
  navigationBar: "#E9EEF4",
  statusBar: "#E9EEF4",
};

/** Neutral charcoal keeps the blue and green brand accents clear in dark mode. */
export const darkColors: ThemeColors = {
  background: "#14181C",
  surface: "#1E2429",
  surfaceElevated: "#292F35",
  surfacePressed: "#343C43",
  textPrimary: "#F7F9FC",
  textSecondary: "#B6BEC7",
  textMuted: "#B6BEC7",
  textOnPrimary: "#FFFFFF",
  border: "#343C43",
  controlBorder: "#64707B",
  divider: "#343C43",
  accent: "#1769D2",
  accentPressed: "#104790",
  accentSoft: "#26333F",
  accentSoftBorder: "#343C43",
  accentText: "#75B6FF",
  primary: "#1769D2",
  primaryHover: "#1255AD",
  primaryPressed: "#104790",
  logoBlue: "#2583E9",
  logoGreen: "#20AA70",
  success: "#14805E",
  successSoft: "#17372A",
  successSoftBorder: "#343C43",
  successText: "#63D29B",
  warning: "#895000",
  warningSoft: "#45351C",
  warningSoftBorder: "#343C43",
  warningText: "#F5CB80",
  error: "#FFB4AA",
  errorMuted: "#FFB4AA",
  errorSoft: "#4D292B",
  inputBackground: "#1E2429",
  disabledBackground: "#292F35",
  disabledText: "#B6BEC7",
  overlay: "rgba(35, 38, 45, 0.48)",
  scanBackground: "#23262D",
  scanText: "#FFFFFF",
  scanMuted: "#E2E8F0",
  fab: "#1769D2",
  shipment: "#B6BEC7",
  shipmentSoft: "#252E34",
  shipmentText: "#B6BEC7",
  commerce: "#75B6FF",
  proof: "#75B6FF",
  evidence: "#B5A0FF",
  integrity: "#B5A0FF",
  integritySoft: "#352C51",
  integrityText: "#C9B9FF",
  navigationBar: "#14181C",
  statusBar: "#14181C",
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
  sm: 8,
  md: 12,
  lg: 18,
  pill: 12,
} as const;

export const typography = {
  pageTitle: { fontFamily: "Inter-SemiBold", fontSize: 26, lineHeight: 34, fontWeight: "600" as const },
  sectionTitle: { fontFamily: "Inter-SemiBold", fontSize: 20, lineHeight: 28, fontWeight: "600" as const },
  cardTitle: { fontFamily: "Inter-SemiBold", fontSize: 16, lineHeight: 22, fontWeight: "600" as const },
  body: { fontFamily: "Inter", fontSize: 16, lineHeight: 24, fontWeight: "400" as const },
  bodyStrong: { fontFamily: "Inter-SemiBold", fontSize: 16, lineHeight: 24, fontWeight: "600" as const },
  secondary: { fontFamily: "Inter", fontSize: 14, lineHeight: 20, fontWeight: "400" as const },
  secondaryStrong: { fontFamily: "Inter-SemiBold", fontSize: 14, lineHeight: 20, fontWeight: "600" as const },
  caption: { fontFamily: "Inter-SemiBold", fontSize: 14, lineHeight: 20, fontWeight: "600" as const },
  finePrint: { fontFamily: "Inter", fontSize: 12, lineHeight: 18, fontWeight: "400" as const },
  button: { fontFamily: "Inter-SemiBold", fontSize: 16, lineHeight: 20, fontWeight: "600" as const },
  greeting: { fontFamily: "Inter-SemiBold", fontSize: 22, lineHeight: 30, fontWeight: "600" as const },
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
