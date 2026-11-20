import { reconstructionFeatureEnabled } from './reconstruction-features.js';

export function facilityEnabled(flag: 'guided' | 'assistant', organization: string, environment: string, location: string | null) {
  if (!location || !reconstructionFeatureEnabled('orderWorkspace')) return false;
  const scope = [organization, environment, location].join(':');
  const allowed = (name: string) => (process.env[name] ?? '').split(',').map(item => item.trim()).includes(scope);
  return allowed('PACKPROOF_GUIDED_FACILITIES') && (flag === 'guided' || allowed('PACKPROOF_SETUP_AI_FACILITIES'));
}
