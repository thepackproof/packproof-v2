import { createPublicKey } from 'node:crypto';
import type { Clock } from '../clock.js';
import { parseSignedTrustRegistry, verifySignedTrustRegistry, type SigningTrustKey } from '../domain/signing-trust.js';
import { createEnvelopeSigner, validateEnvelope } from './envelope-profile.js';
import type { KmsSigningTransport } from './kms-signing-runtime.js';

export interface EnvelopeTrustSource {
  /** Deployment-authenticated issuer-to-registry mapping, never package input. */
  issuer: string; clock: Clock;
  readRegistry: () => Buffer;
  readAuthorityPins: () => Record<string, string>;
}
/** Reuses the existing independently signed key-history registry. Binding that
 * registry to an issuer is explicit trusted deployment configuration, because
 * the legacy signed registry schema itself has no issuer field. */
export function createEnvelopeTrust(source: EnvelopeTrustSource) {
  const issuer = new URL(source.issuer);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) throw Error('ENVELOPE_TRUST_ISSUER_INVALID');
  function currentRegistry() {
    const signed = parseSignedTrustRegistry(source.readRegistry());
    const result = verifySignedTrustRegistry(signed, source.readAuthorityPins(), source.clock.now());
    if (!result.signatureValid || !result.current) throw Error('ENVELOPE_TRUST_REGISTRY_UNAVAILABLE');
    return signed.registry;
  }
  function validAt(key: SigningTrustKey, at: number) {
    return key.algorithm === 'ECDSA_SHA_256' && Number.isFinite(at) && at <= source.clock.now().getTime() && at >= Date.parse(key.validFrom) && (!key.validUntil || at <= Date.parse(key.validUntil)) &&
      (key.status === 'ACTIVE' || key.status === 'RETIRED' && key.statusEffectiveAt !== null && at <= Date.parse(key.statusEffectiveAt));
  }
  function activeKey(keyId: string) {
    const key = currentRegistry().keys.find(row => row.keyId === keyId);
    if (!key || key.status !== 'ACTIVE' || !validAt(key, source.clock.now().getTime())) throw Error('ENVELOPE_UNTRUSTED_KEY');
    return key;
  }
  return {
    issuer: source.issuer,
    activeKey,
    trustedPublicKey: async (requestedIssuer: string, keyId: string, issuedAt: string) => {
      if (requestedIssuer !== source.issuer) return null;
      try { const key = currentRegistry().keys.find(row => row.keyId === keyId); return key && validAt(key, Date.parse(issuedAt)) ? key.publicKeyPem : null; }
      catch { return null; }
    },
    /** Public data for independently authenticated distribution. A package must
     * never supply this snapshot as its own trust root. */
    snapshot: () => {
      const registry = currentRegistry();
      return { schema: 'packproof.envelope-trust.v1', issuer: source.issuer, publishedAt: registry.publishedAt, nextReviewAt: registry.nextReviewAt,
        keys: registry.keys.filter(key => key.algorithm === 'ECDSA_SHA_256').map(({ keyId, publicKeyPem, status, validFrom, validUntil, statusEffectiveAt }) => ({ keyId, publicKeyPem, status, validFrom, validUntil, statusEffectiveAt })) };
    },
  };
}
/** KMS startup checks the exact key ARN/SPKI. Every actual sign checks current
 * active status again; verification may still accept a retired historical key. */
export async function createTrustedEnvelopeSigner(input: {
  keyArn: string; keyId: string; transport: KmsSigningTransport;
  trust: ReturnType<typeof createEnvelopeTrust>; clock: Clock;
}) {
  const pinned = input.trust.activeKey(input.keyId).publicKeyPem;
  const pinnedDer = createPublicKey(pinned).export({ type: 'spki', format: 'der' });
  const sign = await createEnvelopeSigner({ keyArn: input.keyArn, keyId: input.keyId, pinnedPublicKeyPem: pinned, transport: input.transport });
  return async (keyId: string, bytes: Uint8Array) => {
    if (keyId !== input.keyId) throw Error('ENVELOPE_UNTRUSTED_KEY');
    const current = input.trust.activeKey(keyId);
    if (!createPublicKey(current.publicKeyPem).export({ type: 'spki', format: 'der' }).equals(pinnedDer)) throw Error('ENVELOPE_KEY_BINDING');
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    validateEnvelope(envelope);
    const age = input.clock.now().getTime() - Date.parse(envelope.issuedAt);
    if (envelope.issuer !== input.trust.issuer || age < 0 || age > 300000) throw Error('ENVELOPE_NEW_SIGNING_TIME_REQUIRED');
    const result = await sign(bytes);
    // A revocation observed while KMS was in flight cannot become accepted work.
    const after=input.trust.activeKey(keyId);
    if (!createPublicKey(after.publicKeyPem).export({ type: 'spki', format: 'der' }).equals(pinnedDer)) throw Error('ENVELOPE_KEY_BINDING');
    return result;
  };
}
