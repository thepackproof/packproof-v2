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

/** Quiet neutral surfaces with distinct action and completion colors. */
export const lightColors: ThemeColors = {
  background: "#F7F8FA",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  surfacePressed: "#EFF2F6",
  textPrimary: "#18212C",
  textSecondary: "#5A6472",
  textMuted: "#606B78",
  textOnPrimary: "#FFFFFF",
  border: "#DCE3EB",
  divider: "#E7EBF0",
  accent: "#1767D1",
  accentPressed: "#1254AC",
  accentSoft: "#EAF2FF",
  accentSoftBorder: "#C5D9F5",
  accentText: "#155DBB",
  primary: "#1767D1",
  primaryPressed: "#1254AC",
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
  disabledBackground: "#E7EBF0",
  disabledText: "#677381",
  overlay: "rgba(25, 30, 27, 0.48)",
  scanBackground: "#16181C",
  scanText: "#F7F8FA",
  scanMuted: "#ACB5AE",
  fab: "#1767D1",
  shipment: "#5A6472",
  commerce: "#4F6D61",
  proof: "#18212C",
  evidence: "#137548",
  integrity: "#137548",
  navigationBar: "#F7F8FA",
  statusBar: "#F7F8FA",
};

/** Optional dark appearance uses charcoal surfaces instead of blue panels. */
export const darkColors: ThemeColors = {
  background: "#16181C",
  surface: "#21252B",
  surfaceElevated: "#292F37",
  surfacePressed: "#323A45",
  textPrimary: "#F3F5F7",
  textSecondary: "#BAC2CC",
  textMuted: "#A2ADBA",
  textOnPrimary: "#10233F",
  border: "#3C444E",
  divider: "#353D48",
  accent: "#78ACFF",
  accentPressed: "#5E96EC",
  accentSoft: "#23344E",
  accentSoftBorder: "#3C5B85",
  accentText: "#A8CAFF",
  primary: "#78ACFF",
  primaryPressed: "#5E96EC",
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
  inputBackground: "#21252B",
  disabledBackground: "#292F37",
  disabledText: "#9AA4B2",
  overlay: "rgba(14, 17, 15, 0.72)",
  scanBackground: "#16181C",
  scanText: "#F3F5F7",
  scanMuted: "#BAC2CC",
  fab: "#78ACFF",
  shipment: "#BAC2CC",
  commerce: "#BAC2CC",
  proof: "#BAC2CC",
  evidence: "#83D4A5",
  integrity: "#A5E4BD",
  navigationBar: "#16181C",
  statusBar: "#16181C",
};

export function colorsForScheme(scheme: ColorScheme): ThemeColors {
  return scheme === "dark" ? darkColors : lightColors;
}

export function shadowsFor(scheme: ColorScheme): ThemeShadows {
  const shadowColor = scheme === "dark" ? "#000000" : "#18212C";
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
  pageTitle: { fontSize: 28, lineHeight: 34, fontWeight: "600" as const },
  sectionTitle: { fontSize: 18, lineHeight: 24, fontWeight: "600" as const },
  cardTitle: { fontSize: 16, lineHeight: 22, fontWeight: "600" as const },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" as const },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: "600" as const },
  secondary: { fontSize: 14, lineHeight: 20, fontWeight: "400" as const },
  secondaryStrong: { fontSize: 14, lineHeight: 20, fontWeight: "600" as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" as const },
  button: { fontSize: 16, lineHeight: 20, fontWeight: "600" as const },
  greeting: { fontSize: 22, lineHeight: 28, fontWeight: "600" as const },
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

export const shadows = shadowsFor("light");

export const sourceColors = {
  PROOF: lightColors.proof,
  COMMERCE: lightColors.commerce,
  SHIPMENT: lightColors.shipment,
  PARTICIPANT: lightColors.textSecondary,
  EVIDENCE: lightColors.evidence,
  INTEGRITY: lightColors.integrity,
} as const;
