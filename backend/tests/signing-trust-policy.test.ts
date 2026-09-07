import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { sha256Hex } from "../src/hash.js";
import { verifyWithTrustRegistry, type SigningTrustRegistry } from "../src/domain/signing-trust.js";
import type { ManifestSignature } from "../src/domain/manifest-signing.js";

const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (value: typeof key.publicKey) => value.export({ format: "pem", type: "spki" }).toString();
const signature = (text: string, signer = key, keyId = "manifest-key"): ManifestSignature => ({ algorithm: "ECDSA_SHA_256", keyId, signatureBase64: sign("sha256", Buffer.from(text), signer.privateKey).toString("base64"), signedAt: "2026-01-05T00:00:00.000Z" });
const registry: SigningTrustRegistry = { version: 1, domain: "PACKPROOF_SIGNING_TRUST_REGISTRY", publishedAt: "2026-01-01T00:00:00.000Z", nextReviewAt: "2026-02-01T00:00:00.000Z", keys: [{ keyId: "manifest-key", publicKeyPem: pem(key.publicKey), status: "ACTIVE", validFrom: "2025-01-01T00:00:00.000Z", validUntil: null, statusEffectiveAt: null, reason: null }] };
function verify(candidate = registry, overrides: Record<string, unknown> = {}) {
  return verifyWithTrustRegistry({ canonicalJson: '{"accepted":true}', expectedSha256: sha256Hex('{"accepted":true}'), signature: signature('{"accepted":true}'), signedRegistry: { registry: candidate, signature: signature(canonicalize(candidate), authority, "pinned-authority") }, pinnedRegistryAuthorityKeys: { "pinned-authority": pem(authority.publicKey) }, now: new Date("2026-01-10"), onlineRevocationChecked: false, ...overrides });
}
describe("dated signing trust policy", () => {
  it("verifies rotated historical keys only using an independently trusted registry", () => {
    expect(verify().fullyVerified).toBe(true);
    expect(verify({ ...registry, keys: [{ ...registry.keys[0], status: "RETIRED" }] }).historicalTrust).toBe("TRUSTED_AT_REGISTRY_SNAPSHOT");
    expect(verify(registry, { pinnedRegistryAuthorityKeys: {} }).registrySignatureValid).toBe(false);
  });
  it("distinguishes compromised, revoked, unknown and stale trust from mathematical verification", () => {
    const compromised = verify({ ...registry, keys: [{ ...registry.keys[0], status: "COMPROMISED", statusEffectiveAt: "2026-01-08", reason: "Test compromise" }] });
    expect(compromised.signatureValid).toBe(true);
    expect(compromised.fullyVerified).toBe(false);
    expect(compromised.historicalTrust).toBe("REQUIRES_REVIEW");
    expect(verify({ ...registry, keys: [{ ...registry.keys[0], status: "REVOKED" }] }).fullyVerified).toBe(false);
    expect(verify({ ...registry, keys: [] }).keyStatus).toBe("UNKNOWN");
    const stale = verify(registry, { now: new Date("2026-03-01"), onlineRevocationChecked: true });
    expect(stale.signatureValid).toBe(true);
    expect(stale.trustSnapshotStale).toBe(true);
    expect(stale.currentRevocationKnowledge).toBe("UNAVAILABLE");
    expect(stale.fullyVerified).toBe(false);
  });
});
