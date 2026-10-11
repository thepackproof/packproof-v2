export interface RecordingLimits { maxRecordingBytes: number; maxRecordingSeconds: number }

/** Account limits come from the authorized session, never a guessed free allowance. */
export function sessionRecordingLimits(value: unknown): RecordingLimits {
  const session = value as Partial<RecordingLimits> | null;
  if (!session || !Number.isSafeInteger(session.maxRecordingBytes) || session.maxRecordingBytes! < 1 ||
      !Number.isSafeInteger(session.maxRecordingSeconds) || session.maxRecordingSeconds! < 1) {
    throw Object.assign(new Error('The recording allowance could not be verified. Retry before packing; your draft is kept.'), { code: 'CAPTURE_LIMITS_UNAVAILABLE' });
  }
  return { maxRecordingBytes: Math.min(250_000_000, session.maxRecordingBytes!), maxRecordingSeconds: Math.min(300, session.maxRecordingSeconds!) };
}

export function requireNativeRecordingLimits(limits: RecordingLimits, nativeLimitsSupported: boolean): void {
  if (!nativeLimitsSupported && (limits.maxRecordingBytes < 250_000_000 || limits.maxRecordingSeconds < 300))
    throw Object.assign(new Error('Update PackProof before recording with this account allowance. Your draft and saved recordings are kept.'), { code: 'CAPTURE_LIMITS_UPDATE_REQUIRED' });
}

export function recordingLimitCopy(limits: RecordingLimits): string {
  const duration = limits.maxRecordingSeconds >= 60 && limits.maxRecordingSeconds % 60 === 0
    ? `${limits.maxRecordingSeconds / 60} minutes` : `${limits.maxRecordingSeconds} seconds`;
  return `This recording allows up to ${duration} and ${Math.round(limits.maxRecordingBytes / 1_000_000 * 10) / 10} MB. Finish before either limit; an interrupted take may need recording again.`;
}
