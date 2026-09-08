import { createPublicKey } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { MANIFEST_SIGNATURE_ALGORITHMS, verifyManifestIntegrity, type ManifestSignature, type ManifestSignatureAlgorithm } from "./manifest-signing.js";

export interface SigningTrustKey {
  keyId: string;
  algorithm: ManifestSignatureAlgorithm;
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
const invalid = (): never => { throw new Error("Invalid signed trust registry schema or public key"); };
const timestamp = (value: unknown): value is string => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
function exactFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) invalid();
}
export function validateTrustPublicKey(pem: string, algorithm: ManifestSignatureAlgorithm): void {
  if (typeof pem !== "string" || pem.includes("PRIVATE") || !pem.includes("-----BEGIN PUBLIC KEY-----") || pem.length > 32768) invalid();
  const key = createPublicKey(pem);
  if (algorithm === "ECDSA_SHA_256" && (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")) invalid();
  if (algorithm === "RSASSA_PSS_SHA_256" && (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)) invalid();
}
/** Strict signed schema: the original strings/PEM are retained because normalizing them would change signed bytes. */
export function parseSignedTrustRegistry(bytes: Buffer): SignedTrustRegistry {
  if (bytes.length === 0 || bytes.length > 1024 * 1024) invalid();
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return invalid(); }
  exactFields(value, ["registry", "signature"]);
  const registry = value.registry;
  exactFields(registry, ["version", "domain", "publishedAt", "nextReviewAt", "keys"]);
  if (registry.version !== 1 || registry.domain !== "PACKPROOF_SIGNING_TRUST_REGISTRY" || !timestamp(registry.publishedAt) || !timestamp(registry.nextReviewAt) || Date.parse(registry.nextReviewAt) <= Date.parse(registry.publishedAt) || !Array.isArray(registry.keys) || registry.keys.length > 100) invalid();
  const seen = new Set<string>();
  for (const candidate of registry.keys as unknown[]) {
    exactFields(candidate, ["keyId", "algorithm", "publicKeyPem", "validFrom", "validUntil", "status", "statusEffectiveAt", "reason"]);
    const key = candidate as unknown as SigningTrustKey;
    if (typeof key.keyId !== "string" || !/^[A-Za-z0-9_:/.-]{1,200}$/.test(key.keyId) || seen.has(key.keyId) || !(MANIFEST_SIGNATURE_ALGORITHMS as readonly unknown[]).includes(key.algorithm) || !["ACTIVE", "RETIRED", "REVOKED", "COMPROMISED"].includes(key.status) || !timestamp(key.validFrom) || (key.validUntil !== null && (!timestamp(key.validUntil) || Date.parse(key.validUntil) < Date.parse(key.validFrom))) || (key.reason !== null && (typeof key.reason !== "string" || key.reason.length > 2000))) invalid();
    if (key.status === "ACTIVE" ? key.statusEffectiveAt !== null : (!timestamp(key.statusEffectiveAt) || Date.parse(key.statusEffectiveAt) < Date.parse(key.validFrom) || Date.parse(key.statusEffectiveAt) > Date.parse(registry.publishedAt as string))) invalid();
    validateTrustPublicKey(key.publicKeyPem, key.algorithm);
    seen.add(key.keyId);
  }
  exactFields(value.signature, ["algorithm", "keyId", "signatureBase64", "signedAt"]);
  const signature = value.signature as unknown as ManifestSignature;
  if (!(MANIFEST_SIGNATURE_ALGORITHMS as readonly unknown[]).includes(signature.algorithm) || typeof signature.keyId !== "string" || !/^[A-Za-z0-9_:/.-]{1,200}$/.test(signature.keyId) || !timestamp(signature.signedAt) || typeof signature.signatureBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.signatureBase64) || signature.signatureBase64.length > 16384) invalid();
  return value as unknown as SignedTrustRegistry;
}
export function verifySignedTrustRegistry(signedRegistry: SignedTrustRegistry, pinnedRegistryAuthorityKeys: Record<string, string>, now: Date) {
  let parsed: SignedTrustRegistry;
  try { parsed = parseSignedTrustRegistry(Buffer.from(JSON.stringify(signedRegistry))); }
  catch { return { signatureValid: false, current: false }; }
  const { registry, signature } = parsed;
  const authority = pinnedRegistryAuthorityKeys[signature.keyId];
  try { validateTrustPublicKey(authority, signature.algorithm); }
  catch { return { signatureValid: false, current: false }; }
  const serialized = canonicalize(registry);
  const verification = verifyManifestIntegrity({ canonicalJson: serialized, expectedSha256: sha256Hex(serialized), signature, publicKeyPem: authority });
  const signatureValid = verification.signatureValid === true && Date.parse(signature.signedAt) <= now.getTime() && Date.parse(registry.publishedAt) <= now.getTime();
  return { signatureValid, current: signatureValid && now.getTime() < Date.parse(registry.nextReviewAt) };
}
export function trustKeyPermitsSignature(key: SigningTrustKey, signature: ManifestSignature, now: Date): boolean {
  const signedAt = Date.parse(signature.signedAt);
  return key.algorithm === signature.algorithm && Number.isFinite(signedAt) && signedAt <= now.getTime() && signedAt >= Date.parse(key.validFrom)
    && (!key.validUntil || signedAt <= Date.parse(key.validUntil))
    && (key.status === "ACTIVE" || (key.status === "RETIRED" && !!key.statusEffectiveAt && signedAt <= Date.parse(key.statusEffectiveAt)));
}
/** Registry trust must come from an independently pinned authority, never from a key bundled in the package itself. */
export function verifyWithTrustRegistry(input: {
  canonicalJson: string; expectedSha256: string; signature: ManifestSignature;
  signedRegistry: SignedTrustRegistry; pinnedRegistryAuthorityKeys: Record<string, string>;
  now: Date; onlineRevocationChecked: boolean;
}) {
  const { registry } = input.signedRegistry;
  const verification = verifySignedTrustRegistry(input.signedRegistry, input.pinnedRegistryAuthorityKeys, input.now);
  const key = verification.signatureValid ? registry.keys.find(row => row.keyId === input.signature.keyId) : undefined;
  const crypto = verifyManifestIntegrity({ canonicalJson: input.canonicalJson, expectedSha256: input.expectedSha256, signature: input.signature, publicKeyPem: key?.publicKeyPem });
  // A self-asserted historical signing date cannot rescue a key known compromised.
  const keyTrusted = !!key && trustKeyPermitsSignature(key, input.signature, input.now);
  return {
    digestValid: crypto.digestValid,
    signatureValid: crypto.signatureValid,
    registrySignatureValid: verification.signatureValid,
    keyStatus: key?.status ?? "UNKNOWN",
    historicalTrust: !verification.signatureValid ? "UNTRUSTED_REGISTRY" : !key ? "UNKNOWN_KEY" : !keyTrusted ? "REQUIRES_REVIEW" : "TRUSTED_AT_REGISTRY_SNAPSHOT",
    trustSnapshotAt: registry.publishedAt,
    trustSnapshotStale: !verification.current,
    currentRevocationKnowledge: input.onlineRevocationChecked && verification.current ? "CHECKED" : "UNAVAILABLE",
    fullyVerified: crypto.digestValid && crypto.signatureValid === true && keyTrusted && verification.current,
    physicalTruthVerified: false,
  };
}
