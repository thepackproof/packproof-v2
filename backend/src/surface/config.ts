export interface SurfaceConfig {
  collection: boolean;
  extraction: boolean;
  internalComparison: boolean;
  customerFindings: boolean;
  killSwitch: boolean;
  python: string;
  workerRoot: string;
  timeoutMs: number;
}
export const SURFACE_METHOD = Object.freeze({
  profileId: 'research-paper-v1',
  extractorVersion: 'classical-residual-0.1.0',
  descriptorVersion: 'bandpass-projection-0.1.0',
  scorerVersion: 'bounded-correlation-0.1.0',
  thresholdVersion: 'none-unvalidated-0.1.0',
  coverageVersion: 'frozen-multiregion-0.1.0',
  schemaVersion: 'surface-command/1'
});
export function surfaceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SurfaceConfig {
  const enabled = (key: string) => env[key] === 'true';
  return {
    collection: enabled('PACKPROOF_SURFACE_COLLECTION'),
    extraction: enabled('PACKPROOF_SURFACE_EXTRACTION'),
    internalComparison: enabled('PACKPROOF_SURFACE_INTERNAL_COMPARISON'),
    customerFindings: enabled('PACKPROOF_SURFACE_CUSTOMER_FINDINGS'),
    killSwitch: enabled('PACKPROOF_SURFACE_KILL_SWITCH'),
    python: env.PACKPROOF_SURFACE_PYTHON ?? 'python3',
    workerRoot: env.PACKPROOF_SURFACE_WORKER_ROOT ?? '../surface-worker',
    timeoutMs: Math.min(60000, Math.max(1000, Number(env.PACKPROOF_SURFACE_TIMEOUT_MS) || 15000))
  };
}
export function surfaceCapabilities(config: SurfaceConfig) {
  return {
    collection: config.collection && !config.killSwitch,
    extraction: config.extraction && !config.killSwitch,
    internalComparison: config.internalComparison && !config.killSwitch,
    customerFindings: false,
    profileId: SURFACE_METHOD.profileId,
    qualified: false,
    killSwitch: config.killSwitch,
    limitations: ['Experimental R&D only. No physically validated profiles.', 'A surface comparison cannot establish contents, closure or custody.']
  };
}
