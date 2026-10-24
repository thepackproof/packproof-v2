import { signalColors } from './signal';
import { SIGNAL_ENABLED } from '../experience/signal';
import { useFonts } from 'expo-font';
import { EXPERIENCE_RESTORATION_REVIEW } from '../experience/restoration-review';
import { restorationColors } from './restoration-colors';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Appearance, AppState, type ColorSchemeName } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseAppearancePreference, resolveColorScheme, APPEARANCE_STORAGE_KEY } from './appearance';
import { ANDROID_TASK_FIRST_REBUILD } from '../experience/android-task-first';
import { MOTION_STORAGE_KEY, parseMotionPreference, resolveMotionMode, type MotionPreference, type MotionMode } from './motion';
import { colorsForScheme, shadowsFor, type AppearancePreference, type ColorScheme, type ThemeColors, type ThemeShadows } from './tokens';

export interface Theme {
  hydrated: boolean;
  preference: AppearancePreference;
  scheme: ColorScheme;
  colors: ThemeColors;
  shadows: ThemeShadows;
  /** Compatibility: true whenever large decorative movement is disallowed. */
  reducedMotion: boolean;
  motionPreference: MotionPreference;
  motionMode: MotionMode;
  setPreference: (preference: AppearancePreference) => Promise<void>;
  setMotionPreference: (preference: MotionPreference) => Promise<void>;
  setMotionSuppressed: (reason: string, suppressed: boolean) => void;
}
const ThemeContext = createContext<Theme | null>(null);
const defaultNativePreference: AppearancePreference = 'system';
function schemeFromSystem(value: ColorSchemeName): ColorScheme { return value === 'dark' ? 'dark' : 'light'; }

export function ThemeProvider(props: { children: ReactNode }) {
  const [fontsLoaded, fontError] = useFonts({
    'IBMPlexMono-Medium': require('../../assets/fonts/IBMPlexMono-Medium.ttf'),
    Inter: require('../../assets/fonts/Inter-Regular.ttf'),
    'Inter-Medium': require('../../assets/fonts/Inter-Medium.ttf'),
    'Inter-SemiBold': require('../../assets/fonts/Inter-SemiBold.ttf'),
    'Inter-Bold': require('../../assets/fonts/Inter-Bold.ttf'),
    'Inter-ExtraBold': require('../../assets/fonts/Inter-ExtraBold.ttf'),
  });
  const [preference, setPreferenceState] = useState<AppearancePreference>(defaultNativePreference);
  const [systemScheme, setSystemScheme] = useState<ColorScheme>(() => schemeFromSystem(Appearance.getColorScheme()));
  const [systemReduced, setSystemReduced] = useState(true);
  const [motionPreference, setMotionPreferenceState] = useState<MotionPreference>('system');
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [suppression, setSuppression] = useState<ReadonlySet<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [stored, storedMotion] = await Promise.all([
          AsyncStorage.getItem(APPEARANCE_STORAGE_KEY), AsyncStorage.getItem(MOTION_STORAGE_KEY),
        ]);
        if (!cancelled) {
          const next = stored === 'light' || stored === 'dark' || stored === 'system' ? parseAppearancePreference(stored) : defaultNativePreference;
          setPreferenceState(next); setMotionPreferenceState(parseMotionPreference(storedMotion));
          Appearance.setColorScheme(next === 'system' ? null : next);
        }
      } catch {
        if (!cancelled) Appearance.setColorScheme(defaultNativePreference === 'system' ? null : defaultNativePreference);
      } finally { if (!cancelled) setHydrated(true); }
    })();
    const appearance = Appearance.addChangeListener(({ colorScheme }) => setSystemScheme(schemeFromSystem(colorScheme)));
    const reduce = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReduced);
    const state = AppState.addEventListener('change', next => setForeground(next === 'active'));
    void AccessibilityInfo.isReduceMotionEnabled().then(enabled => { if (!cancelled) setSystemReduced(enabled); }).catch(() => {
      // If the OS preference cannot be read, keep the conservative static presentation.
    });
    return () => { cancelled = true; appearance.remove(); reduce.remove(); state.remove(); };
  }, []);
  const setPreference = useCallback(async (next: AppearancePreference) => {
    setPreferenceState(next); Appearance.setColorScheme(next === 'system' ? null : next);
    await AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, next);
  }, []);
  const setMotionPreference = useCallback(async (next: MotionPreference) => {
    setMotionPreferenceState(next); await AsyncStorage.setItem(MOTION_STORAGE_KEY, next);
  }, []);
  const setMotionSuppressed = useCallback((reason: string, suppressed: boolean) => {
    setSuppression(previous => {
      if (previous.has(reason) === suppressed) return previous;
      const next = new Set(previous); if (suppressed) next.add(reason); else next.delete(reason); return next;
    });
  }, []);
  const scheme = resolveColorScheme(preference, systemScheme);
  const motionMode = resolveMotionMode(motionPreference, systemReduced, !foreground || suppression.size > 0);
  const value = useMemo<Theme>(() => ({
    hydrated: hydrated && (fontsLoaded || Boolean(fontError)), preference, scheme,
    colors: SIGNAL_ENABLED ? signalColors(scheme) : EXPERIENCE_RESTORATION_REVIEW ? restorationColors(scheme) : colorsForScheme(scheme, ANDROID_TASK_FIRST_REBUILD),
    shadows: shadowsFor(scheme), reducedMotion: motionMode !== 'full', motionPreference, motionMode,
    setPreference, setMotionPreference, setMotionSuppressed,
  }), [hydrated, fontsLoaded, fontError, preference, scheme, motionMode, motionPreference, setPreference, setMotionPreference, setMotionSuppressed]);
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}
export function useTheme(): Theme {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within ThemeProvider');
  return value;
}
/** Register recording, high-throughput station or measured-performance suppression without remounting work. */
export function useMotionSuppression(reason: string, suppressed: boolean): void {
  const { setMotionSuppressed } = useTheme(); const id = useId();
  useEffect(() => {
    const key = `${reason}:${id}`; setMotionSuppressed(key, suppressed);
    return () => setMotionSuppressed(key, false);
  }, [reason, id, suppressed, setMotionSuppressed]);
}
