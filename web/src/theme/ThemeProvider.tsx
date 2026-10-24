import { eimPrimitives } from '../../../packages/evidence-in-motion/tokens.generated';
import { MOTION_STORAGE_KEY, parseMotionPreference, resolveMotionMode, type MotionPreference, type MotionMode } from '../../../mobile/src/theme/motion';
import { signalColors } from '../../../mobile/src/theme/signal';
import { SIGNAL_ENABLED } from '../signal/Signal';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useId,
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
  motionPreference: MotionPreference;
  motionMode: MotionMode;
  effectiveMotion: MotionMode;
  setMotionPreference: (preference: MotionPreference) => void;
  setMotionSuppressed: (reason: string, suppressed: boolean) => void;
}

const ThemeContext = createContext<WebTheme | null>(null);

function systemScheme(): ColorScheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyCssVars(scheme: ColorScheme) {
  const colors = SIGNAL_ENABLED ? signalColors(scheme) : colorsForScheme(scheme);
  const root = document.documentElement;
  const vars: Record<string, string> = {
    '--eim-midnight': eimPrimitives.midnight, '--eim-navy': eimPrimitives.navy, '--eim-blue': eimPrimitives.blue,
    '--eim-primary': eimPrimitives.action, '--eim-mint': eimPrimitives.mint, '--eim-cyan': eimPrimitives.cyan,
    '--eim-paper': eimPrimitives.paper, '--eim-raised-dark': eimPrimitives.raised,
    '--eim-background': colors.background, '--eim-surface': colors.surface,
    '--eim-text': colors.textPrimary, '--eim-secondary': colors.textSecondary,
    '--eim-border': colors.border, '--eim-wash': colors.surfacePressed,
    '--eim-confirmed-ink': colors.successText, '--eim-confirmed-soft': colors.successSoft,
    "--navy": colors.textPrimary,
    "--navy-muted": colors.surfacePressed,
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
    "--primary-hover": colors.primaryHover,
    "--logo-blue": colors.logoBlue,
    "--logo-green": colors.logoGreen,
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
    "--shadow": "none",
    "--shadow-fab": "none",
  };
  root.dataset.theme = scheme;
  root.style.colorScheme = scheme;
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

export function ThemeProvider(props: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<AppearancePreference>(() =>
    (() => { try { return parseAppearancePreference(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)); } catch { return 'system'; } })(),
  );
  const [system, setSystem] = useState<ColorScheme>(() => systemScheme());
  const [motionPreference, setMotionPreferenceState] = useState<MotionPreference>(() => {
    try { return parseMotionPreference(window.localStorage.getItem(MOTION_STORAGE_KEY)); } catch { return 'system'; }
  });
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [suppression, setSuppression] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReduced(query?.matches ?? true);
    const visibility = () => setVisible(document.visibilityState !== 'hidden');
    query?.addEventListener('change', update); document.addEventListener('visibilitychange', visibility);
    return () => { query?.removeEventListener('change', update); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const setMotionPreference = useCallback((next: MotionPreference) => {
    setMotionPreferenceState(next); try { window.localStorage.setItem(MOTION_STORAGE_KEY, next); } catch { /* Session preference remains active. */ }
  }, []);
  const setMotionSuppressed = useCallback((reason: string, suppressed: boolean) => {
    setSuppression(previous => {
      if (previous.has(reason) === suppressed) return previous;
      const next = new Set(previous); if (suppressed) next.add(reason); else next.delete(reason); return next;
    });
  }, []);
  const motionSuppressed = !visible || suppression.size > 0;
  const motionMode = resolveMotionMode(motionPreference, systemReduced, motionSuppressed);
  useEffect(() => {
    document.documentElement.dataset.motion = motionMode;
    document.documentElement.dataset.motionSuppressed = String(motionSuppressed);
    document.documentElement.dataset.decorativeMotion = motionMode === 'full' ? 'on' : 'off';
  }, [motionMode, motionSuppressed]);

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
    try { window.localStorage.setItem(APPEARANCE_STORAGE_KEY, next); } catch { /* Session preference remains active. */ }
  }, []);

  const scheme = resolveColorScheme(preference, system);

  useEffect(() => {
    applyCssVars(scheme);
  }, [scheme]);

  const value = useMemo<WebTheme>(
    () => ({
      preference,
      scheme,
      colors: SIGNAL_ENABLED ? signalColors(scheme) : colorsForScheme(scheme),
      shadows: shadowsFor(scheme),
      setPreference, motionPreference, motionMode, effectiveMotion: motionMode, setMotionPreference, setMotionSuppressed,
    }),
    [preference, scheme, setPreference, motionPreference, motionMode, setMotionPreference, setMotionSuppressed],
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

/** Register capture/station/performance contexts without replacing a durable owner. */
export function useMotionSuppression(reason: string, suppressed: boolean): void {
  const setMotionSuppressed = useContext(ThemeContext)?.setMotionSuppressed; const id = useId();
  useEffect(() => {
    if (!setMotionSuppressed) return;
    const key = `${reason}:${id}`; setMotionSuppressed(key, suppressed);
    return () => setMotionSuppressed(key, false);
  }, [reason, id, suppressed, setMotionSuppressed]);
}
