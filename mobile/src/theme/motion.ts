export const motion = {
  duration: {
    instant: 120,
    fast: 180,
    glide: 220,
    reveal: 260,
    normal: 300,
    shared: 320,
    slow: 360,
    success: 360,
    trackingPulse: 1200,
  },
  pressScale: 0.97,
  liftScale: 1.015,
  fabPressScale: 0.94,
  listOffset: 6,
  stagger: 24,
  spring: {
    press: { damping: 18, stiffness: 320, mass: 0.7 },
    settle: { damping: 20, stiffness: 220, mass: 0.85 },
    pill: { damping: 22, stiffness: 260, mass: 0.8 },
    cinematic: { damping: 18, stiffness: 190, mass: 0.85 },
  },
} as const;

export function motionDuration(reducedMotion: boolean, duration: number): number {
  return reducedMotion ? Math.min(120, duration) : duration;
}

export function shouldUseLargeMotion(reducedMotion: boolean): boolean {
  return !reducedMotion;
}
