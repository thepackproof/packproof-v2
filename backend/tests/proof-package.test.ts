import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProofPackage, verifyProofPackage } from "../src/domain/proof-package.js";
import type { ManifestSignature } from "../src/domain/manifest-signing.js";

function signCanonicalJson(canonicalJson: string): {
  signature: ManifestSignature;
  publicKeyPem: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signer = createSign("sha256");
  signer.update(canonicalJson, "utf8");
  signer.end();
  return {
    signature: {
      algorithm: "ECDSA_SHA_256",
      keyId: "test-kms-key",
      signatureBase64: signer.sign(privateKey, "base64"),
      signedAt: "2026-09-04T00:00:00.000Z",
    },
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("portable Proof package", () => {
  it("verifies canonical JSON, digest, and an asymmetric manifest signature", () => {
    const unsigned = createProofPackage({
      proofId: "proof_1",
      manifestId: "manifest_1",
      manifest: {
        manifestVersion: 1,
        proofId: "proof_1",
        evidence: [{ evidenceId: "evd_1", sha256: "abc" }],
      },
    });
    const signed = signCanonicalJson(unsigned.canonicalJson);
    const pkg = { ...unsigned, signature: signed.signature };

    expect(verifyProofPackage({ package: pkg, publicKeyPem: signed.publicKeyPem })).toEqual({
      schemaValid: true,
      canonicalJsonValid: true,
      digestValid: true,
      signaturePresent: true,
      signatureValid: true,
      algorithm: "ECDSA_SHA_256",
      keyId: "test-kms-key",
    });
  });

  it("detects a manifest changed after the package was created", () => {
    const pkg = createProofPackage({
      proofId: "proof_2",
      manifestId: "manifest_2",
      manifest: { manifestVersion: 1, proofId: "proof_2", status: "FINALIZED" },
    });
    const tampered = {
      ...pkg,
      canonicalManifest: { manifestVersion: 1, proofId: "proof_2", status: "OPEN" },
    };

    const verified = verifyProofPackage({ package: tampered });
    expect(verified.canonicalJsonValid).toBe(false);
    expect(verified.digestValid).toBe(false);
  });

  it("keeps existing hash-only manifests explicitly distinguishable from signed manifests", () => {
    const pkg = createProofPackage({
      proofId: "proof_3",
      manifestId: "manifest_3",
      manifest: { manifestVersion: 1, proofId: "proof_3" },
    });
    const verified = verifyProofPackage({ package: pkg });
    expect(verified.digestValid).toBe(true);
    expect(verified.signaturePresent).toBe(false);
    expect(verified.signatureValid).toBeNull();
  });
});
