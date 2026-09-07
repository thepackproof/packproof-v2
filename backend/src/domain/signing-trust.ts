import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { verifyManifestIntegrity, type ManifestSignature } from "./manifest-signing.js";

export interface SigningTrustKey {
  keyId: string;
  publicKeyPem: string;
  validFrom: string;
  validUntil: string | null;
  status: "ACTIVE" | "RETIRED" | "REVOKED" | "COMPROMISED";
  statusEffectiveAt: string | null;
  reason: string | null;
}
export interface SigningTrustRegistry {
  version: 1;
  domain: "PACKPROOF_SIGNING_TRUST_REGISTRY";
  publishedAt: string;
  nextReviewAt: string;
  keys: SigningTrustKey[];
}
export interface SignedTrustRegistry { registry: SigningTrustRegistry; signature: ManifestSignature; }

/** Registry trust must come from an independently pinned authority, never from a key bundled in the package itself. */
export function verifyWithTrustRegistry(input: {
  canonicalJson: string; expectedSha256: string; signature: ManifestSignature;
  signedRegistry: SignedTrustRegistry; pinnedRegistryAuthorityKeys: Record<string, string>;
  now: Date; onlineRevocationChecked: boolean;
}) {
  const { registry, signature } = input.signedRegistry;
  const serialized = canonicalize(registry);
  const registryVerification = verifyManifestIntegrity({ canonicalJson: serialized, expectedSha256: sha256Hex(serialized), signature, publicKeyPem: input.pinnedRegistryAuthorityKeys[signature.keyId] });
  const registryValid = registry.version === 1 && registry.domain === "PACKPROOF_SIGNING_TRUST_REGISTRY" && registryVerification.signatureValid === true && Number.isFinite(new Date(registry.publishedAt).getTime()) && new Date(registry.publishedAt) <= input.now && Number.isFinite(new Date(registry.nextReviewAt).getTime());
  const key = registryValid ? registry.keys.find(row => row.keyId === input.signature.keyId) : undefined;
  const crypto = verifyManifestIntegrity({ canonicalJson: input.canonicalJson, expectedSha256: input.expectedSha256, signature: input.signature, publicKeyPem: key?.publicKeyPem });
  const signedAt = new Date(input.signature.signedAt).getTime();
  const keyInPeriod = !!key && Number.isFinite(signedAt) && signedAt >= new Date(key.validFrom).getTime() && (!key.validUntil || signedAt <= new Date(key.validUntil).getTime());
  // A self-asserted historical signing date cannot rescue a key known compromised.
  const keyTrusted = keyInPeriod && (key?.status === "ACTIVE" || key?.status === "RETIRED");
  const stale = !registryValid || new Date(registry.nextReviewAt) < input.now;
  return {
    digestValid: crypto.digestValid,
    signatureValid: crypto.signatureValid,
    registrySignatureValid: registryValid,
    keyStatus: key?.status ?? "UNKNOWN",
    historicalTrust: !registryValid ? "UNTRUSTED_REGISTRY" : !key ? "UNKNOWN_KEY" : !keyTrusted ? "REQUIRES_REVIEW" : "TRUSTED_AT_REGISTRY_SNAPSHOT",
    trustSnapshotAt: registry.publishedAt,
    trustSnapshotStale: stale,
    currentRevocationKnowledge: input.onlineRevocationChecked && !stale ? "CHECKED" : "UNAVAILABLE",
    fullyVerified: crypto.digestValid && crypto.signatureValid === true && keyTrusted && registryValid && !stale,
    physicalTruthVerified: false,
  };
}
