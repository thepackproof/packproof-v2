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

/** Workstation surfaces: blue actions and selections, green preserved-record states. */
export const lightColors: ThemeColors = {
  background: "#EDF1F6",
  surface: "#FFFFFF",
  surfaceElevated: "#F4F7FA",
  surfacePressed: "#E9EEF5",
  textPrimary: "#232D3C",
  // Slightly deeper than web's muted text to retain 4.5:1 on the native canvas.
  textSecondary: "#5F6D82",
  textMuted: "#5F6D82",
  textOnPrimary: "#FFFFFF",
  border: "#E0E6EE",
  controlBorder: "#7C8794",
  divider: "#E0E6EE",
  accent: "#1769D2",
  accentPressed: "#105BB9",
  accentSoft: "#E9F1FC",
  accentSoftBorder: "#D1DFEF",
  accentText: "#1769D2",
  primary: "#1769D2",
  primaryHover: "#105BB9",
  primaryPressed: "#105BB9",
  logoBlue: "#2583E9",
  logoGreen: "#20AA70",
  success: "#14745C",
  successSoft: "#E8F5EF",
  successSoftBorder: "#CDE8DD",
  successText: "#14745C",
  warning: "#92600E",
  warningSoft: "#FFF5DF",
  warningSoftBorder: "#EEDCB4",
  warningText: "#92600E",
  error: "#A22A37",
  errorMuted: "#A22A37",
  errorSoft: "#FEEEEE",
  inputBackground: "#FFFFFF",
  disabledBackground: "#E0E6EE",
  disabledText: "#5F6D82",
  overlay: "rgba(20, 29, 42, 0.48)",
  scanBackground: "#23262D",
  scanText: "#FFFFFF",
  scanMuted: "#E2E8F0",
  fab: "#1769D2",
  shipment: "#0F767D",
  shipmentSoft: "#E4F7F8",
  shipmentText: "#0F767D",
  commerce: "#1769D2",
  proof: "#1769D2",
  evidence: "#7051CA",
  integrity: "#7051CA",
  integritySoft: "#F0EBFF",
  integrityText: "#6341C6",
  navigationBar: "#EDF1F6",
  statusBar: "#EDF1F6",
};

/** The desktop workstation's layered navy surfaces, adapted to native text contrast. */
export const darkColors: ThemeColors = {
  background: "#141D2A",
  surface: "#1A2535",
  surfaceElevated: "#202D3E",
  surfacePressed: "#26364A",
  textPrimary: "#DCE5EF",
  textSecondary: "#9CAABE",
  textMuted: "#9CAABE",
  textOnPrimary: "#FFFFFF",
  border: "#2D3B4E",
  controlBorder: "#65758B",
  divider: "#2D3B4E",
  accent: "#68A8F5",
  accentPressed: "#1C60B0",
  accentSoft: "#213B5A",
  accentSoftBorder: "#304F70",
  accentText: "#68A8F5",
  primary: "#256FC7",
  primaryHover: "#1C60B0",
  primaryPressed: "#1C60B0",
  logoBlue: "#2583E9",
  logoGreen: "#20AA70",
  success: "#80C7AF",
  successSoft: "#1B3A33",
  successSoftBorder: "#34584B",
  successText: "#80C7AF",
  warning: "#E6BC69",
  warningSoft: "#44391F",
  warningSoftBorder: "#615232",
  warningText: "#E6BC69",
  error: "#F3A6AD",
  errorMuted: "#F3A6AD",
  errorSoft: "#492B35",
  inputBackground: "#1A2535",
  disabledBackground: "#28384B",
  disabledText: "#9CAABE",
  overlay: "rgba(5, 12, 22, 0.70)",
  scanBackground: "#23262D",
  scanText: "#FFFFFF",
  scanMuted: "#E2E8F0",
  fab: "#256FC7",
  shipment: "#9CAABE",
  shipmentSoft: "#202D3E",
  shipmentText: "#9CAABE",
  commerce: "#68A8F5",
  proof: "#68A8F5",
  evidence: "#B5A0FF",
  integrity: "#B5A0FF",
  integritySoft: "#352C51",
  integrityText: "#C9B9FF",
  navigationBar: "#141D2A",
  statusBar: "#141D2A",
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
  md: 8,
  lg: 10,
  pill: 8,
} as const;

export const typography = {
  pageTitle: { fontFamily: "Inter-Bold", fontSize: 28, lineHeight: 36, fontWeight: "700" as const },
  sectionTitle: { fontFamily: "Inter-SemiBold", fontSize: 18, lineHeight: 26, fontWeight: "600" as const },
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
