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

/** Quiet neutral surfaces with a restrained green action color. */
export const lightColors: ThemeColors = {
  background: "#F6F7F5",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  surfacePressed: "#EFF2EE",
  textPrimary: "#232927",
  textSecondary: "#606B64",
  textMuted: "#6D776F",
  textOnPrimary: "#FFFFFF",
  border: "#DFE5DE",
  divider: "#E9EDE7",
  accent: "#137548",
  accentPressed: "#0D5E39",
  accentSoft: "#EDF6EE",
  accentSoftBorder: "#CCE4D2",
  accentText: "#137548",
  primary: "#137548",
  primaryPressed: "#0D5E39",
  success: "#137548",
  successSoft: "#EDF6EE",
  successSoftBorder: "#CCE4D2",
  successText: "#137548",
  warning: "#9A6817",
  warningSoft: "#FFF6E8",
  warningSoftBorder: "#F0D7A8",
  warningText: "#805412",
  error: "#B42318",
  errorMuted: "#D64545",
  errorSoft: "#FDECEC",
  inputBackground: "#FFFFFF",
  disabledBackground: "#E9EDE7",
  disabledText: "#748078",
  overlay: "rgba(25, 30, 27, 0.48)",
  scanBackground: "#171B19",
  scanText: "#F6F7F5",
  scanMuted: "#ACB5AE",
  fab: "#137548",
  shipment: "#606B64",
  commerce: "#4F6D61",
  proof: "#232927",
  evidence: "#137548",
  integrity: "#137548",
  navigationBar: "#F6F7F5",
  statusBar: "#F6F7F5",
};

/** Optional dark appearance uses charcoal surfaces instead of blue panels. */
export const darkColors: ThemeColors = {
  background: "#171B19",
  surface: "#222824",
  surfaceElevated: "#292F2B",
  surfacePressed: "#313A33",
  textPrimary: "#F3F5F1",
  textSecondary: "#B3BDB4",
  textMuted: "#99A59B",
  textOnPrimary: "#14231A",
  border: "#3A453C",
  divider: "#333C35",
  accent: "#83D4A5",
  accentPressed: "#63BC89",
  accentSoft: "#253A2D",
  accentSoftBorder: "#3C5B47",
  accentText: "#A5E4BD",
  primary: "#83D4A5",
  primaryPressed: "#63BC89",
  success: "#83D4A5",
  successSoft: "#253A2D",
  successSoftBorder: "#3C5B47",
  successText: "#A5E4BD",
  warning: "#EAC079",
  warningSoft: "#382F20",
  warningSoftBorder: "#5B4C32",
  warningText: "#EAC079",
  error: "#F3958C",
  errorMuted: "#F3958C",
  errorSoft: "#402924",
  inputBackground: "#222824",
  disabledBackground: "#292F2B",
  disabledText: "#88948B",
  overlay: "rgba(14, 17, 15, 0.72)",
  scanBackground: "#171B19",
  scanText: "#F3F5F1",
  scanMuted: "#B3BDB4",
  fab: "#83D4A5",
  shipment: "#B3BDB4",
  commerce: "#B3BDB4",
  proof: "#B3BDB4",
  evidence: "#83D4A5",
  integrity: "#A5E4BD",
  navigationBar: "#171B19",
  statusBar: "#171B19",
};

export function colorsForScheme(scheme: ColorScheme): ThemeColors {
  return scheme === "dark" ? darkColors : lightColors;
}

export function shadowsFor(scheme: ColorScheme): ThemeShadows {
  const shadowColor = scheme === "dark" ? "#000000" : "#232927";
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
