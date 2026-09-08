import { createSign, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { createProofPackage } from "../src/domain/proof-package.js";
import { sha256Hex } from "../src/hash.js";
import { zipFiles } from "../src/export/zip.js";

it("verifies TypeScript canonical signed-registry bytes with the independent Python verifier", async () => {
  const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signer = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const stamp = new Date().toISOString();
  const signature = (raw: string, key: typeof signer.privateKey, keyId: string) => {
    const sign = createSign("sha256"); sign.update(raw); sign.end();
    return { algorithm: "ECDSA_SHA_256", keyId, signedAt: stamp, signatureBase64: sign.sign(key, "base64") };
  };
  const registry = {
    version: 1, domain: "PACKPROOF_SIGNING_TRUST_REGISTRY",
    publishedAt: new Date(Date.now() - 60_000).toISOString(), nextReviewAt: new Date(Date.now() + 86_400_000).toISOString(),
    keys: [{ keyId: "synthetic-signer", algorithm: "ECDSA_SHA_256", publicKeyPem: signer.publicKey.export({ type: "spki", format: "pem" }).toString(),
      validFrom: "2026-01-01T00:00:00.000Z", validUntil: null, status: "ACTIVE", statusEffectiveAt: null,
      reason: "Synthetic canonical-text vector: café · 東京 · 😀 · \u2028" }],
  };
  const media = Buffer.from("Synthetic offline interoperability fixture");
  const manifest = { manifestVersion: 1, proofId: "proof_registry", evidence: [{ evidenceId: "evidence_registry", byteSize: media.length, sha256: sha256Hex(media) }] };
  const pkg = createProofPackage({ proofId: manifest.proofId, manifestId: "manifest_registry", manifest });
  pkg.signature = signature(pkg.canonicalJson, signer.privateKey, "synthetic-signer") as typeof pkg.signature;
  const files = new Map<string, Buffer>([
    ["package.json", Buffer.from(canonicalize(pkg))], ["manifest.json", Buffer.from(pkg.canonicalJson)], ["media/original.bin", media],
    ["integrity/evidence.json", Buffer.from(canonicalize([{ evidenceId: "evidence_registry", path: "media/original.bin", status: "INCLUDED" }]))],
    ["lifecycle/stages.json", Buffer.from("[]")],
  ]);
  files.set("integrity/hashes.json", Buffer.from(canonicalize(Object.fromEntries([...files].map(([name, bytes]) => [name, sha256Hex(bytes)])))));
  const folder = await mkdtemp(path.join(tmpdir(), "packproof-signed-registry-"));
  try {
    await writeFile(path.join(folder, "proof.zip"), zipFiles([...files].map(([name, bytes]) => ({ name, bytes }))));
    await writeFile(path.join(folder, "registry.json"), JSON.stringify({ registry, signature: signature(canonicalize(registry), authority.privateKey, "independent-authority") }, null, 2));
    await writeFile(path.join(folder, "authority.pem"), authority.publicKey.export({ type: "spki", format: "pem" }));
    const result = spawnSync("python3", ["../verifier/verify.py", path.join(folder, "proof.zip"),
      "--trust-registry", path.join(folder, "registry.json"), "--trust-authority-key", path.join(folder, "authority.pem"),
      "--trust-authority-key-id", "independent-authority"], { encoding: "utf8", env: { ...process.env, http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1" } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "VERIFIED", signatureVerified: true, evidenceVerified: 1,
      signature: { keyStatus: "ACTIVE", keyTrustedAtSnapshot: true },
      trust: { source: "SIGNED_REGISTRY", registrySignatureVerified: true, networkUsed: false, currentRevocationKnowledge: "UNAVAILABLE" } });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("runs the real Python signed, corrupt, stale, unknown, retired and compromise timing tests", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "../verifier", "-p", "test_trust_registry.py"], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toContain("Ran 9 tests");
});
