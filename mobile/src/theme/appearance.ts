import type { AppearancePreference, ColorScheme } from "./tokens";

export const APPEARANCE_STORAGE_KEY = "packproof-v2.appearance";

export function parseAppearancePreference(raw: string | null | undefined): AppearancePreference {
  if (raw === "light" || raw === "dark" || raw === "system") {
    return raw;
  }
  return "system";
}

export function resolveColorScheme(
  preference: AppearancePreference,
  systemScheme: ColorScheme | null | undefined,
): ColorScheme {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  return systemScheme === "dark" ? "dark" : "light";
}

export function systemBarContent(scheme: ColorScheme, immersive: boolean): "light" | "dark" {
  if (immersive || scheme === "dark") {
    return "light";
  }
  return "dark";
}

export function systemBarBackground(
  colors: { background: string; scanBackground: string },
  immersive: boolean,
): string {
  return immersive ? colors.scanBackground : colors.background;
}
