import { useFonts } from "expo-font";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, Appearance, type ColorSchemeName } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseAppearancePreference, resolveColorScheme } from "./appearance";
import { APPEARANCE_STORAGE_KEY } from "./appearance";
import { MOBILE_TASK_UX_ENABLED } from "../experience/mobile-ux";
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
const defaultNativePreference = MOBILE_TASK_UX_ENABLED ? "dark" : "light";

function schemeFromSystem(value: ColorSchemeName): ColorScheme {
  return value === "dark" ? "dark" : "light";
}

export function ThemeProvider(props: { children: ReactNode }) {
  const [fontsLoaded, fontError] = useFonts({
    Inter: require("../../assets/fonts/Inter-Regular.ttf"),
    "Inter-SemiBold": require("../../assets/fonts/Inter-SemiBold.ttf"),
    "Inter-Bold": require("../../assets/fonts/Inter-Bold.ttf"),
  });
  const [preference, setPreferenceState] = useState<AppearancePreference>(defaultNativePreference);
  const [systemScheme, setSystemScheme] = useState<ColorScheme>(() => schemeFromSystem(Appearance.getColorScheme()));
  const [reducedMotion, setReducedMotion] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(APPEARANCE_STORAGE_KEY);
        if (!cancelled) {
          const next = stored === "light" || stored === "dark" || stored === "system" ? parseAppearancePreference(stored) : defaultNativePreference;
          setPreferenceState(next);
          Appearance.setColorScheme(next === "system" ? null : next);
        }
      } catch {
        // Preserve a deterministic native theme even if preferences cannot be read.
        if (!cancelled) Appearance.setColorScheme(defaultNativePreference);
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
      hydrated: hydrated && (fontsLoaded || Boolean(fontError)),
      preference,
      scheme,
      colors: colorsForScheme(scheme),
      shadows: shadowsFor(scheme),
      reducedMotion,
      setPreference,
    }),
    [hydrated, fontsLoaded, fontError, preference, reducedMotion, scheme, setPreference],
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
