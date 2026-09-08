import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { finalizeProof, getManifest } from "../src/domain/finalize.js";
import { appendProofSupplement } from "../src/domain/proof-supplements.js";
import { exportEvidencePackageStream } from "../src/domain/evidence-review.js";
import { collectSmallZip } from "../src/export/zip-stream.js";
import type { ManifestSigner } from "../src/domain/manifest-signing.js";
import { auth, commitFulfillmentAndAttest, createHarness, login } from "./helpers.js";

it("authenticates actual frozen export chains across JS/Python while retaining the original core and the received-head limit", async () => {
  const now = new Date(), stamp = now.toISOString(), clock = { now: () => now };
  const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const root = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const supplement = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signature = (raw: string, pair: typeof root, keyId: string) => ({ algorithm: "ECDSA_SHA_256" as const, keyId,
    signatureBase64: sign("sha256", Buffer.from(raw), pair.privateKey).toString("base64"), signedAt: stamp });
  const signer = (pair: typeof root, keyId: string): ManifestSigner => ({ signManifest: async input => signature(input.canonicalJson, pair, keyId) });
  const h = await createHarness(clock), folder = await mkdtemp(path.join(tmpdir(), "packproof-portable-supplements-"));
  try {
    const seller = await login(h.app, "portable-supplement-seller");
    const tx = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Synthetic portable chain" });
    const proof = await request(h.app).post(`/transactions/${tx.body.transactionId}/proof`).set(auth(seller));
    const proofId = proof.body.proofId;
    await commitFulfillmentAndAttest(h, seller, proofId);
    const frozen = await finalizeProof(h.db, clock, seller, proofId, signer(root, "root-key"));
    const first = await appendProofSupplement(h.db, clock, signer(supplement, "supplement-key"), seller, proofId, {
      operationId: "portable-first", kind: "CORRECTION", facts: { note: "café · 東京 · 😀 · \u2028", measured: 1e-7,
        large: 1e21, fraction: 0.1, numericMembers: { "10": "ten", "2": "two" } },
    });
    const older = await exportEvidencePackageStream(h.db, clock, h.objectStore, seller, proofId);
    const second = await appendProofSupplement(h.db, clock, signer(supplement, "supplement-key"), seller, proofId, {
      operationId: "portable-second", kind: "CORRECTION", facts: { note: "Later attributed correction" }, supersedesSupplementId: first.supplementId,
    });
    await writeFile(path.join(folder, "older.zip"), await collectSmallZip(older));
    await writeFile(path.join(folder, "current.zip"), await collectSmallZip(await exportEvidencePackageStream(h.db, clock, h.objectStore, seller, proofId)));
    expect((await getManifest(h.db, seller, proofId)).canonicalJson).toBe(frozen.manifest.canonicalJson);
    const registry = {
      version: 1, domain: "PACKPROOF_SIGNING_TRUST_REGISTRY", publishedAt: stamp,
      nextReviewAt: new Date(now.valueOf() + 86_400_000).toISOString(),
      keys: [["root-key", root], ["supplement-key", supplement]].map(([keyId, pair]) => ({
        keyId: keyId as string, algorithm: "ECDSA_SHA_256", publicKeyPem: (pair as typeof root).publicKey.export({ type: "spki", format: "pem" }).toString(),
        validFrom: new Date(now.valueOf() - 86_400_000).toISOString(), validUntil: null, status: "ACTIVE", statusEffectiveAt: null as string | null, reason: null,
      })),
    };
    const publishRegistry = () => writeFile(path.join(folder, "registry.json"), JSON.stringify({ registry, signature: signature(canonicalize(registry), authority, "independent-authority") }));
    await writeFile(path.join(folder, "authority.pem"), authority.publicKey.export({ type: "spki", format: "pem" }));
    await publishRegistry();
    const verify = (name: string, code = 0) => {
      const result = spawnSync("python3", ["-B", "../verifier/verify.py", path.join(folder, name),
        "--trust-registry", path.join(folder, "registry.json"), "--trust-authority-key", path.join(folder, "authority.pem"),
        "--trust-authority-key-id", "independent-authority"], { encoding: "utf8", env: { ...process.env, http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1" } });
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout).toBe(code);
      return JSON.parse(result.stdout);
    };
    const oldResult = verify("older.zip"), currentResult = verify("current.zip");
    expect(oldResult).toMatchObject({ status: "VERIFIED", manifestSha256: frozen.manifest.sha256, signatureVerified: true,
      supplements: { status: "VERIFIED_RECEIVED_SNAPSHOT", fullyVerifiedReceivedChain: true, sequence: 1, headSha256: first.sha256,
        completeness: "RECEIVED_SNAPSHOT_ONLY", snapshotTimeIndependentlyAttested: false } });
    expect(currentResult).toMatchObject({ status: "VERIFIED", manifestSha256: frozen.manifest.sha256,
      supplements: { sequence: 2, headSha256: second.sha256, signaturesVerified: true, keysTrustedAtSnapshot: true } });
    registry.keys[1]!.status = "RETIRED"; registry.keys[1]!.statusEffectiveAt = stamp;
    await publishRegistry(); expect(verify("current.zip").supplements.fullyVerifiedReceivedChain).toBe(true);
    registry.keys[1]!.status = "COMPROMISED"; await publishRegistry();
    expect(verify("current.zip", 2)).toMatchObject({ status: "SUPPLEMENT_COMPROMISED_KEY", signatureVerified: true,
      supplements: { signaturesVerified: true, keysTrustedAtSnapshot: false, fullyVerifiedReceivedChain: false } });
  } finally { await h.close(); await rm(folder, { recursive: true, force: true }); }
});

it("runs Python signed-chain omission, duplication, ordering, tamper and independent-trust boundary cases", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "../verifier", "-p", "test_signed_supplements.py"], { encoding: "utf8" });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toContain("Ran 13 tests");
});
