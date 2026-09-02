export const colors = {
  navy: "#142735",
  blue: "#13A8E8",
  green: "#0DCE70",
  slate: "#66737D",
  background: "#F4F6F8",
  border: "#E2E7EA",
  white: "#FFFFFF",
  text: "#142735",
  textSecondary: "#66737D",
  textMuted: "#8A959E",
  danger: "#B42318",
  dangerMuted: "#D64545",
  dangerBg: "#FDECEC",
  overlay: "rgba(20, 39, 53, 0.48)",
  navyMuted: "#1E3A4C",
  blueSoft: "#E8F6FC",
  greenSoft: "#E7F9EF",
  purpleSoft: "#EEE8F8",
  warningSoft: "#FFF6E8",
  scanBg: "#0E1A22",
  scanInk: "#F4F6F8",
  scanMuted: "#9AA8B2",
} as const;

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

export const shadows = {
  card: {
    shadowColor: "#142735",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  tab: {
    shadowColor: "#142735",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 8,
  },
  create: {
    shadowColor: "#142735",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
} as const;

export const sourceColors = {
  PROOF: colors.navy,
  COMMERCE: colors.blue,
  SHIPMENT: "#5B7380",
  PARTICIPANT: colors.slate,
  EVIDENCE: "#0B6F99",
  INTEGRITY: "#0A8A4B",
} as const;
