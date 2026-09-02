export const motion = {
  duration: {
    instant: 120,
    fast: 180,
    normal: 240,
    slow: 360,
    success: 560,
  },
  pressScale: 0.97,
  fabPressScale: 0.94,
  listOffset: 10,
  stagger: 28,
  spring: {
    press: { damping: 18, stiffness: 320, mass: 0.7 },
    settle: { damping: 20, stiffness: 220, mass: 0.85 },
    pill: { damping: 22, stiffness: 260, mass: 0.8 },
  },
} as const;

export function motionDuration(reducedMotion: boolean, duration: number): number {
  return reducedMotion ? Math.min(120, duration) : duration;
}

export function shouldUseLargeMotion(reducedMotion: boolean): boolean {
  return !reducedMotion;
}
