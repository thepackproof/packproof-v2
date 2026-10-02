/** Testable policy shared by native parity fixtures. Values are engineering bounds, not qualified thresholds. */
export const ACQUISITION_POLICY = Object.freeze({ cadenceMs: 250, maxPixels: 2_097_152, maxSelectedFrames: 6, maxPendingFrames: 1, maxLeaseMs: 5_000, maxTelemetry: 301 });
export function measureLuma(luma: Uint8Array, width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 1 || height <= 1 || width * height !== luma.length) throw new Error('Invalid luma plane');
  const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
  let sum = 0, edge = 0, saturated = 0, count = 0;
  for (let y = step; y < height; y += step) for (let x = step; x < width; x += step) {
    const value = luma[y * width + x]; sum += value; edge += Math.abs(value - luma[y * width + x - step]);
    if (value <= 5 || value >= 250) saturated += 1; count += 1;
  }
  return { meanLuma: sum / count, sharpness: edge / count, saturationFraction: saturated / count };
}
export function passiveChallengeWindow(challenge: { mode: string; expiresAtMs: number; activeIlluminationEnabled: boolean; commands: unknown[] }, wallTime: number): number {
  if (challenge.mode !== 'PASSIVE_LAB' || challenge.activeIlluminationEnabled || challenge.commands.length) throw new Error('Active illumination requires a reviewed hardware profile');
  if (!Number.isFinite(challenge.expiresAtMs) || challenge.expiresAtMs <= wallTime) return 0;
  return Math.min(ACQUISITION_POLICY.maxLeaseMs, challenge.expiresAtMs - wallTime);
}
