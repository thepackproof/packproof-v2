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

/** Paper surfaces and charcoal ink, with slate-blue interaction and forest-green records. */
export const lightColors: ThemeColors = {
  background: "#F5F2E9",
  surface: "#FFFEFA",
  surfaceElevated: "#F0EEE6",
  surfacePressed: "#E9E8DF",
  textPrimary: "#26302D",
  textSecondary: "#59635F",
  textMuted: "#59635F",
  textOnPrimary: "#FFFEFA",
  border: "#D9D8CF",
  divider: "#D9D8CF",
  accent: "#56727B",
  accentPressed: "#456A7C",
  accentSoft: "#EAF0F0",
  accentSoftBorder: "#C3D2D5",
  accentText: "#456A7C",
  primary: "#26302D",
  primaryPressed: "#34423E",
  success: "#365F4C",
  successSoft: "#EAF0E8",
  successSoftBorder: "#C5D3C6",
  successText: "#365F4C",
  warning: "#986A24",
  warningSoft: "#F7F0DF",
  warningSoftBorder: "#DDCFAC",
  warningText: "#78551E",
  error: "#A13930",
  errorMuted: "#B95C52",
  errorSoft: "#F7EAE5",
  inputBackground: "#FFFEFA",
  disabledBackground: "#E9E8DF",
  disabledText: "#72796F",
  overlay: "rgba(37, 48, 46, 0.48)",
  scanBackground: "#1C2421",
  scanText: "#F5F2E9",
  scanMuted: "#C5CEC4",
  fab: "#26302D",
  shipment: "#56727B",
  commerce: "#59635F",
  proof: "#26302D",
  evidence: "#56727B",
  integrity: "#365F4C",
  navigationBar: "#F5F2E9",
  statusBar: "#F5F2E9",
};

/** Optional dark appearance uses charcoal surfaces instead of blue panels. */
export const darkColors: ThemeColors = {
  background: "#1C2421",
  surface: "#26302D",
  surfaceElevated: "#2D3834",
  surfacePressed: "#37443E",
  textPrimary: "#F6F3E9",
  textSecondary: "#C5CEC4",
  textMuted: "#ACB8AC",
  textOnPrimary: "#1C2421",
  border: "#4C5A50",
  divider: "#3D4941",
  accent: "#9CBAC6",
  accentPressed: "#B8D0D8",
  accentSoft: "#2C3C3E",
  accentSoftBorder: "#506B72",
  accentText: "#B8D0D8",
  primary: "#BFD0D4",
  primaryPressed: "#D1DFDF",
  success: "#A2C4A8",
  successSoft: "#2C3C31",
  successSoftBorder: "#506B54",
  successText: "#B6D3B9",
  warning: "#DCC08A",
  warningSoft: "#3E3627",
  warningSoftBorder: "#695C40",
  warningText: "#E2CA9B",
  error: "#E4A298",
  errorMuted: "#E4A298",
  errorSoft: "#44312B",
  inputBackground: "#26302D",
  disabledBackground: "#2D3834",
  disabledText: "#929F92",
  overlay: "rgba(22, 29, 25, 0.72)",
  scanBackground: "#1C2421",
  scanText: "#F6F3E9",
  scanMuted: "#C5CEC4",
  fab: "#BFD0D4",
  shipment: "#9CBAC6",
  commerce: "#C5CEC4",
  proof: "#F6F3E9",
  evidence: "#9CBAC6",
  integrity: "#B6D3B9",
  navigationBar: "#1C2421",
  statusBar: "#1C2421",
};

export function colorsForScheme(scheme: ColorScheme): ThemeColors {
  return scheme === "dark" ? darkColors : lightColors;
}

export function shadowsFor(scheme: ColorScheme): ThemeShadows {
  const shadowColor = scheme === "dark" ? "#000000" : "#26302D";
  return {
    card: {
      shadowColor,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: scheme === "dark" ? 0.2 : 0.03,
      shadowRadius: 8,
      elevation: 0,
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
