import { useEffect, useState } from 'react';
import { MOTION_STORAGE_KEY, parseMotionPreference, resolveMotionMode, type MotionPreference } from '../../../mobile/src/theme/motion';
const eventName = 'packproof-motion-preference';
function readPreference(): MotionPreference {
  try { return parseMotionPreference(window.localStorage.getItem(MOTION_STORAGE_KEY)); } catch { return 'system'; }
}
/** Renderer-only preferences never cross or expand the privileged bridge. */
export function useDesktopMotion(suppressed: boolean) {
  const [preference, setPreferenceState] = useState<MotionPreference>(readPreference);
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onSystem = () => setSystemReduced(query.matches);
    const onPreference = (event: Event) => setPreferenceState(event instanceof CustomEvent ? parseMotionPreference(event.detail) : readPreference());
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    query.addEventListener('change', onSystem); window.addEventListener(eventName, onPreference);
    window.addEventListener('storage', onPreference); document.addEventListener('visibilitychange', onVisibility);
    return () => { query.removeEventListener('change', onSystem); window.removeEventListener(eventName, onPreference);
      window.removeEventListener('storage', onPreference); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  const mode = resolveMotionMode(preference, systemReduced, suppressed || !visible);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.motion = mode; root.dataset.motionSuppressed = String(suppressed || !visible);
    root.dataset.decorativeMotion = mode === 'full' ? 'on' : 'off';
  }, [mode, suppressed, visible]);
  function setPreference(next: MotionPreference) {
    setPreferenceState(next);
    try { window.localStorage.setItem(MOTION_STORAGE_KEY, next); } catch { /* Keep this session preference. */ }
    window.dispatchEvent(new CustomEvent(eventName, { detail: next }));
  }
  return { preference, setPreference, mode };
}
