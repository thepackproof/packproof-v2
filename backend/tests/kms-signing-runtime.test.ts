import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { initializeManifestSigningRuntime, type KmsSigningTransport } from "../src/integrity/kms-signing-runtime.js";
import { canonicalize } from "../src/canonical.js";
import { sha256Hex } from "../src/hash.js";
import { verifyManifestIntegrity } from "../src/domain/manifest-signing.js";

const keyArn = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
const env = { PACKPROOF_MANIFEST_SIGNING_MODE: "kms", PACKPROOF_MANIFEST_SIGNING_REQUIRED: "true", PACKPROOF_MANIFEST_KMS_KEY_ARN: keyArn, PACKPROOF_MANIFEST_SIGNING_KEY_ID: "packproof-test-key", PACKPROOF_MANIFEST_SIGNING_ALGORITHM: "ECDSA_SHA_256" };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const canonicalJson = canonicalize({ proofId: "large-proof", manifestVersion: 1, note: "x".repeat(6000) });
const sha256 = sha256Hex(canonicalJson);
function transport() {
  const getPublicKey = vi.fn<KmsSigningTransport["getPublicKey"]>(async () => ({ $metadata: {}, KeyId: keyArn, KeyUsage: "SIGN_VERIFY", KeySpec: "ECC_NIST_P256", SigningAlgorithms: ["ECDSA_SHA_256"], PublicKey: publicKey.export({ type: "spki", format: "der" }) }));
  const signRequest = vi.fn<KmsSigningTransport["sign"]>(async input => {
    expect(input).toMatchObject({ KeyId: keyArn, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" });
    expect(Buffer.from(input.Message!)).toEqual(Buffer.from(sha256, "hex"));
    return { $metadata: {}, KeyId: keyArn, SigningAlgorithm: "ECDSA_SHA_256", Signature: sign("sha256", Buffer.from(canonicalJson), privateKey) };
  });
  return { getPublicKey, sign: signRequest };
}
const clock = { now: () => new Date("2026-09-05T12:00:00Z") };
const input = { proofId: "large-proof", manifestId: "manifest", canonicalJson, sha256 };
describe("AWS KMS asymmetric manifest signer", () => {
  it("fetches the public key, signs a SHA-256 digest without a 4096-byte raw-message limit, and verifies the result", async () => {
    const mock = transport(); const runtime = await initializeManifestSigningRuntime(clock, env, mock);
    const signature = await runtime.signer!.signManifest(input);
    expect(mock.getPublicKey).toHaveBeenCalledWith({ KeyId: keyArn }); expect(mock.sign).toHaveBeenCalledTimes(1);
    expect(runtime.publicStatus).toMatchObject({ mode: "SIGNED", provider: "AWS_KMS", keyId: "packproof-test-key", required: true });
    expect(runtime.trustList!.keys[0].status).toBe("ACTIVE");
    expect(verifyManifestIntegrity({ canonicalJson, expectedSha256: sha256, signature, publicKeyPem: runtime.trustList!.keys[0].publicKeyPem }).signatureValid).toBe(true);
    expect(JSON.stringify(runtime.trustList)).not.toContain("PRIVATE");
  });
  it("rejects unsupported algorithms, key usage, wrong ARNs and incompatible Sign responses", async () => {
    const wrongAlgorithm = transport(); wrongAlgorithm.getPublicKey.mockResolvedValue({ $metadata: {}, KeyId: keyArn, KeyUsage: "SIGN_VERIFY", KeySpec: "ECC_NIST_P256", SigningAlgorithms: ["ECDSA_SHA_384"], PublicKey: publicKey.export({ type: "spki", format: "der" }) });
    await expect(initializeManifestSigningRuntime(clock, env, wrongAlgorithm)).rejects.toThrow("does not match");
    await expect(initializeManifestSigningRuntime(clock, { ...env, PACKPROOF_MANIFEST_KMS_KEY_ARN: "alias/packproof" }, transport())).rejects.toThrow("exact");
    const wrongUsage = transport(); wrongUsage.getPublicKey.mockResolvedValue({ $metadata: {}, KeyId: keyArn, KeyUsage: "ENCRYPT_DECRYPT", KeySpec: "RSA_2048" });
    await expect(initializeManifestSigningRuntime(clock, env, wrongUsage)).rejects.toThrow("does not match");
    const incompatible = transport(); const runtime = await initializeManifestSigningRuntime(clock, env, incompatible);
    incompatible.sign.mockResolvedValue({ $metadata: {}, KeyId: keyArn, SigningAlgorithm: "ECDSA_SHA_384", Signature: Buffer.from("wrong") });
    await expect(runtime.signer!.signManifest(input)).rejects.toMatchObject({ code: "MANIFEST_SIGNING_FAILED" });
  });
  it("fails closed on KMS denial, corrupt signatures and changed local manifest digests", async () => {
    const denied = transport(); denied.getPublicKey.mockRejectedValue(new Error("AccessDenied: private details"));
    await expect(initializeManifestSigningRuntime(clock, env, denied)).rejects.toThrow("task-role access was denied");
    const mock = transport(); const runtime = await initializeManifestSigningRuntime(clock, env, mock);
    await expect(runtime.signer!.signManifest({ ...input, sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "MANIFEST_SIGNING_FAILED" }); expect(mock.sign).not.toHaveBeenCalled();
    mock.sign.mockResolvedValue({ $metadata: {}, KeyId: keyArn, SigningAlgorithm: "ECDSA_SHA_256", Signature: Buffer.from("corrupt") });
    await expect(runtime.signer!.signManifest(input)).rejects.toMatchObject({ code: "MANIFEST_SIGNING_FAILED" });
    mock.sign.mockRejectedValue(new Error("AWS denied request with details"));
    await expect(runtime.signer!.signManifest(input)).rejects.toMatchObject({ code: "MANIFEST_SIGNING_FAILED", message: "The signing service could not sign the frozen manifest" });
  });
  it("refreshes expiring public trust before signing and retains operator-supplied historical revocations", async () => {
    let now = clock.now(); const mock = transport();
    const historical = [{ keyId: "old-public-key", algorithm: "ECDSA_SHA_256", status: "REVOKED", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() }];
    const runtime = await initializeManifestSigningRuntime({ now: () => now }, { ...env, PACKPROOF_MANIFEST_TRUST_TTL_SECONDS: "300", PACKPROOF_MANIFEST_TRUST_HISTORY_JSON: JSON.stringify(historical) }, mock);
    now = new Date(now.getTime() + 290000);
    await Promise.all([runtime.signer!.signManifest(input), runtime.signer!.signManifest(input)]);
    expect(mock.getPublicKey).toHaveBeenCalledTimes(2);
    expect(runtime.trustList!.generatedAt).toBe(now.toISOString());
    expect(runtime.trustList!.keys[0]).toMatchObject({ keyId: "old-public-key", status: "REVOKED" });
    now = new Date(now.getTime() + 290000); mock.getPublicKey.mockRejectedValue(new Error("offline"));
    await expect(runtime.signer!.signManifest(input)).rejects.toMatchObject({ code: "MANIFEST_TRUST_REFRESH_FAILED" });
  });
});
