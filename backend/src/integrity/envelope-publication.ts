import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { createEnvelopeTrust } from './envelope-trust.js';
import { loadSignedTrustRegistryRuntime } from './trust-registry-runtime.js';

/** Read-only public distribution, independent of API admission and signing.
 * Issuer and authority pins come only from trusted deployment configuration.
 * Reload a single verified registry/pin pair for each response and readiness check.
 */
export function initializeEnvelopeTrustPublication(clock: Clock, env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.PACKPROOF_ENVELOPE_TRUST_PUBLICATION_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw Error('ENVELOPE_TRUST_PUBLICATION_FLAG_INVALID');
  if (enabled === 'false') return null;
  const issuer = env.PACKPROOF_ENVELOPE_ISSUER;
  if (!issuer || issuer.trim() !== issuer) throw Error('ENVELOPE_TRUST_ISSUER_REQUIRED');
  const snapshot = () => {
    try {
      const loaded = loadSignedTrustRegistryRuntime(clock, env);
      if (!loaded) throw Error('ENVELOPE_SIGNED_REGISTRY_REQUIRED');
      return createEnvelopeTrust({ issuer, clock,
        readRegistry: () => Buffer.from(loaded.signedTrustRegistryJson),
        readAuthorityPins: () => loaded.registryAuthorityKeys,
      }).snapshot();
    } catch {
      throw new DomainError('ENVELOPE_TRUST_UNAVAILABLE', 'Current independently authenticated envelope key history is unavailable.', 503);
    }
  };
  snapshot(); // Enabling publication with untrusted or stale material fails startup.
  return { snapshot };
}
export type EnvelopeTrustPublication = NonNullable<ReturnType<typeof initializeEnvelopeTrustPublication>>;
