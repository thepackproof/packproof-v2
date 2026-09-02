import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Appearance, type ColorSchemeName } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseAppearancePreference, resolveColorScheme } from "./appearance";
import { APPEARANCE_STORAGE_KEY } from "./appearance";
import {
  colorsForScheme,
  shadowsFor,
  type AppearancePreference,
  type ColorScheme,
  type ThemeColors,
  type ThemeShadows,
} from "./tokens";

export interface Theme {
  hydrated: boolean;
  preference: AppearancePreference;
  scheme: ColorScheme;
  colors: ThemeColors;
  shadows: ThemeShadows;
  reducedMotion: boolean;
  setPreference: (preference: AppearancePreference) => Promise<void>;
}

const ThemeContext = createContext<Theme | null>(null);

function schemeFromSystem(value: ColorSchemeName): ColorScheme {
  return value === "dark" ? "dark" : "light";
}

export function ThemeProvider(props: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<AppearancePreference>("system");
  const [systemScheme, setSystemScheme] = useState<ColorScheme>(() => schemeFromSystem(Appearance.getColorScheme()));
  const [reducedMotion, setReducedMotion] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(APPEARANCE_STORAGE_KEY);
        if (!cancelled) {
          const next = parseAppearancePreference(stored);
          setPreferenceState(next);
          Appearance.setColorScheme(next === "system" ? null : next);
        }
      } finally {
        if (!cancelled) {
          setHydrated(true);
        }
      }
    })();
    const appearance = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(schemeFromSystem(colorScheme));
    });
    const reduce = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) {
        setReducedMotion(enabled);
      }
    });
    return () => {
      cancelled = true;
      appearance.remove();
      reduce.remove();
    };
  }, []);

  const setPreference = useCallback(async (next: AppearancePreference): Promise<void> => {
    setPreferenceState(next);
    Appearance.setColorScheme(next === "system" ? null : next);
    await AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, next);
  }, []);

  const scheme = resolveColorScheme(preference, systemScheme);
  const value = useMemo<Theme>(
    () => ({
      hydrated,
      preference,
      scheme,
      colors: colorsForScheme(scheme),
      shadows: shadowsFor(scheme),
      reducedMotion,
      setPreference,
    }),
    [hydrated, preference, reducedMotion, scheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return value;
}
