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

/** Existing light PackProof surfaces. Keep visually close to the current app. */
export const lightColors: ThemeColors = {
  background: "#F4F6F8",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  surfacePressed: "#E8EEF2",
  textPrimary: "#142735",
  textSecondary: "#66737D",
  textMuted: "#8A959E",
  textOnPrimary: "#FFFFFF",
  border: "#E2E7EA",
  divider: "#E2E7EA",
  accent: "#13A8E8",
  accentPressed: "#0E8FC7",
  accentSoft: "#E8F6FC",
  accentSoftBorder: "#C5E8F6",
  accentText: "#0B6F99",
  primary: "#142735",
  primaryPressed: "#0E1C26",
  success: "#0DCE70",
  successSoft: "#E7F9EF",
  successSoftBorder: "#B7E8CB",
  successText: "#0A8A4B",
  warning: "#C47F12",
  warningSoft: "#FFF6E8",
  warningSoftBorder: "#F0D7A8",
  warningText: "#8A5A10",
  error: "#B42318",
  errorMuted: "#D64545",
  errorSoft: "#FDECEC",
  inputBackground: "#FFFFFF",
  disabledBackground: "#E8EEF2",
  disabledText: "#8A959E",
  overlay: "rgba(20, 39, 53, 0.48)",
  scanBackground: "#0E1A22",
  scanText: "#F4F6F8",
  scanMuted: "#9AA8B2",
  fab: "#13A8E8",
  shipment: "#5B7380",
  commerce: "#13A8E8",
  proof: "#142735",
  evidence: "#0B6F99",
  integrity: "#0A8A4B",
  navigationBar: "#F4F6F8",
  statusBar: "#F4F6F8",
};

/** Deep navy PackProof dark theme. Not a generic black invert. */
export const darkColors: ThemeColors = {
  background: "#0B1220",
  surface: "#16243A",
  surfaceElevated: "#111B2E",
  surfacePressed: "#1B2C46",
  textPrimary: "#F3F7FC",
  textSecondary: "#9FB0C6",
  textMuted: "#7E90A8",
  textOnPrimary: "#0B1220",
  border: "#24354D",
  divider: "#24354D",
  accent: "#27B4F3",
  accentPressed: "#0F8FD1",
  accentSoft: "#123348",
  accentSoftBorder: "#1E4A68",
  accentText: "#7DD3F8",
  primary: "#27B4F3",
  primaryPressed: "#0F8FD1",
  success: "#43D17A",
  successSoft: "#123526",
  successSoftBorder: "#1E5A38",
  successText: "#43D17A",
  warning: "#F5B942",
  warningSoft: "#2A2416",
  warningSoftBorder: "#5A4A20",
  warningText: "#F5B942",
  error: "#F26D6D",
  errorMuted: "#F26D6D",
  errorSoft: "#3A1E24",
  inputBackground: "#16243A",
  disabledBackground: "#111B2E",
  disabledText: "#6B7C92",
  overlay: "rgba(8, 12, 20, 0.72)",
  scanBackground: "#0B1220",
  scanText: "#F3F7FC",
  scanMuted: "#9FB0C6",
  fab: "#27B4F3",
  shipment: "#8AA0B5",
  commerce: "#27B4F3",
  proof: "#9FB0C6",
  evidence: "#27B4F3",
  integrity: "#43D17A",
  navigationBar: "#0B1220",
  statusBar: "#0B1220",
};

export function colorsForScheme(scheme: ColorScheme): ThemeColors {
  return scheme === "dark" ? darkColors : lightColors;
}

export function shadowsFor(scheme: ColorScheme): ThemeShadows {
  const shadowColor = scheme === "dark" ? "#000000" : "#142735";
  return {
    card: {
      shadowColor,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: scheme === "dark" ? 0.35 : 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
    tab: {
      shadowColor,
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: scheme === "dark" ? 0.4 : 0.06,
      shadowRadius: 8,
      elevation: 8,
    },
    create: {
      shadowColor,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: scheme === "dark" ? 0.45 : 0.18,
      shadowRadius: 10,
      elevation: 6,
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
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  pageTitle: { fontSize: 28, lineHeight: 34, fontWeight: "700" as const },
  sectionTitle: { fontSize: 18, lineHeight: 24, fontWeight: "700" as const },
  cardTitle: { fontSize: 16, lineHeight: 22, fontWeight: "700" as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" as const },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: "600" as const },
  secondary: { fontSize: 14, lineHeight: 20, fontWeight: "400" as const },
  secondaryStrong: { fontSize: 14, lineHeight: 20, fontWeight: "600" as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" as const },
  button: { fontSize: 16, lineHeight: 20, fontWeight: "700" as const },
  greeting: { fontSize: 22, lineHeight: 28, fontWeight: "700" as const },
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
  purpleSoft: "#EEE8F8",
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
