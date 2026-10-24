import { eimMotion } from '../../../packages/evidence-in-motion/tokens.generated';
/** Presentation policy only. No timing callback may own evidence or navigation commands. */
export type MotionPreference = 'system' | 'reduced' | 'off';
export type MotionMode = 'full' | 'reduced' | 'off';
export const MOTION_STORAGE_KEY = 'packproof.motion.v1';
export function parseMotionPreference(value: string | null | undefined): MotionPreference {
  return value === 'reduced' || value === 'off' ? value : 'system';
}
export function resolveMotionMode(preference: MotionPreference, systemReduced: boolean, suppressed = false): MotionMode {
  if (preference === 'off' || suppressed) return 'off';
  return preference === 'reduced' || systemReduced ? 'reduced' : 'full';
}
export const motion = {
  duration: { instant: eimMotion.press, fast: eimMotion.tab, glide: eimMotion.screen, reveal: eimMotion.screen, normal: eimMotion.sheet, shared: eimMotion.card,
    slow: eimMotion.home, success: eimMotion.receipt, trackingPulse: 1200 },
  pressScale: 0.98, liftScale: 1.01, fabPressScale: 0.98, listOffset: 6, stagger: 24,
  spring: {
    press: { damping: 18, stiffness: 320, mass: 0.7 },
    settle: { damping: 20, stiffness: 220, mass: 0.85 },
    pill: { damping: 22, stiffness: 260, mass: 0.8 },
    cinematic: { damping: 20, stiffness: 220, mass: 0.85 },
  },
} as const;
export function policyDuration(mode: MotionMode, duration: number): number {
  return mode === 'off' ? 0 : mode === 'reduced' ? Math.min(100, duration) : duration;
}
/** Compatibility for unchanged consumers. New presentation should use policyDuration. */
export function motionDuration(reducedMotion: boolean, duration: number): number {
  return reducedMotion ? Math.min(100, duration) : duration;
}
export function shouldUseLargeMotion(reducedMotion: boolean): boolean { return !reducedMotion; }
