import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  APPEARANCE_STORAGE_KEY,
  parseAppearancePreference,
  resolveColorScheme,
} from "@packproof/theme/appearance";
import {
  colorsForScheme,
  shadowsFor,
  type AppearancePreference,
  type ColorScheme,
  type ThemeColors,
  type ThemeShadows,
} from "@packproof/theme/tokens";

export interface WebTheme {
  preference: AppearancePreference;
  scheme: ColorScheme;
  colors: ThemeColors;
  shadows: ThemeShadows;
  setPreference: (preference: AppearancePreference) => void;
}

const ThemeContext = createContext<WebTheme | null>(null);

function systemScheme(): ColorScheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyCssVars(scheme: ColorScheme) {
  const colors = colorsForScheme(scheme);
  const root = document.documentElement;
  const vars: Record<string, string> = {
    "--bg": colors.background,
    "--surface": colors.surface,
    "--surface-elevated": colors.surfaceElevated,
    "--surface-pressed": colors.surfacePressed,
    "--text": colors.textPrimary,
    "--text-secondary": colors.textSecondary,
    "--text-muted": colors.textMuted,
    "--text-on-primary": colors.textOnPrimary,
    "--border": colors.border,
    "--divider": colors.divider,
    "--white": colors.surface,
    "--slate": colors.textSecondary,
    "--blue": colors.accent,
    "--green": colors.success,
    "--danger": colors.error,
    "--danger-bg": colors.errorSoft,
    "--blue-soft": colors.accentSoft,
    "--green-soft": colors.successSoft,
    "--accent": colors.accent,
    "--accent-pressed": colors.accentPressed,
    "--accent-soft": colors.accentSoft,
    "--accent-soft-border": colors.accentSoftBorder,
    "--accent-text": colors.accentText,
    "--primary": colors.primary,
    "--primary-pressed": colors.primaryPressed,
    "--success": colors.success,
    "--success-text": colors.successText,
    "--success-soft": colors.successSoft,
    "--success-soft-border": colors.successSoftBorder,
    "--warning": colors.warning,
    "--warning-soft": colors.warningSoft,
    "--warning-soft-border": colors.warningSoftBorder,
    "--warning-text": colors.warningText,
    "--error": colors.error,
    "--error-soft": colors.errorSoft,
    "--input-bg": colors.inputBackground,
    "--disabled-bg": colors.disabledBackground,
    "--disabled-text": colors.disabledText,
    "--overlay": colors.overlay,
    "--scan-bg": colors.scanBackground,
    "--scan-text": colors.scanText,
    "--fab": colors.fab,
    "--shadow":
      scheme === "dark" ? "0 2px 8px rgba(0, 0, 0, 0.35)" : "0 2px 8px rgba(20, 39, 53, 0.06)",
    "--shadow-fab":
      scheme === "dark" ? "0 4px 10px rgba(0, 0, 0, 0.45)" : "0 4px 10px rgba(20, 39, 53, 0.18)",
  };
  root.dataset.theme = scheme;
  root.style.colorScheme = scheme;
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

export function ThemeProvider(props: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<AppearancePreference>(() =>
    parseAppearancePreference(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)),
  );
  const [system, setSystem] = useState<ColorScheme>(() => systemScheme());

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) {
      return;
    }
    const onChange = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setPreference = useCallback((next: AppearancePreference) => {
    setPreferenceState(next);
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
  }, []);

  const scheme = resolveColorScheme(preference, system);

  useEffect(() => {
    applyCssVars(scheme);
  }, [scheme]);

  const value = useMemo<WebTheme>(
    () => ({
      preference,
      scheme,
      colors: colorsForScheme(scheme),
      shadows: shadowsFor(scheme),
      setPreference,
    }),
    [preference, scheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): WebTheme {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return value;
}
