import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import request from "supertest";
import { canonicalize } from "../src/canonical.js";
import { sha256Hex } from "../src/hash.js";
import type { SignedTrustRegistry } from "../src/domain/signing-trust.js";
import type { ManifestSignature } from "../src/domain/manifest-signing.js";
import { collectSmallZip, streamZip, zipBytes } from "../src/export/zip-stream.js";
import { verifyPortableLifecycleSnapshot, type PortableLifecycleSnapshot } from "../src/verification/lifecycle-verifier.js";
import { finalizeProof, getManifest } from "../src/domain/finalize.js";
import { appendProofSupplement } from "../src/domain/proof-supplements.js";
import { createLifecycleSnapshot } from "../src/domain/lifecycle-snapshots.js";
import { exportEvidencePackageStream } from "../src/domain/evidence-review.js";
import { auth, commitFulfillmentAndAttest, createHarness, login } from "./helpers.js";

function fixture() {
  const now = new Date(), stamp = now.toISOString();
  const authority = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signature = (raw: string, pair = key, keyId = "test-record"): ManifestSignature => ({ algorithm: "ECDSA_SHA_256", keyId,
    signatureBase64: sign("sha256", Buffer.from(raw), pair.privateKey).toString("base64"), signedAt: stamp });
  const media = Buffer.from("Synthetic preserved footage bytes");
  // Intentionally retain a legacy byte layout. Neither checker may reserialize it.
  const raw = '{ "manifestVersion":1, "proofId":"proof_test", "transactionId":"txn_test", "note":"café 東京 😀", "number":1e-7, "evidence":' +
    JSON.stringify([{ evidenceId: "ev_test", sha256: sha256Hex(media), byteSize: media.length }]) + ' }';
  const root = { manifestId: "man_test", proofId: "proof_test", canonicalJson: raw, sha256: sha256Hex(raw), signature: signature(raw) };
  const facts = { version: 1, domain: "PACKPROOF_LIFECYCLE_SNAPSHOT", snapshotId: "snapshot_test", proofId: "proof_test",
    transactionId: "txn_test", tenantId: "tenant_test", actorUserId: "user_test", purpose: "REVIEW", createdAt: stamp, cutoffAt: stamp,
    scope: "SEALED_COMMERCE_LIFECYCLE", root: { manifestId: root.manifestId, sha256: root.sha256 }, supplements: [], stages: [],
    watermark: { supplementSequence: 0, supplementSha256: root.sha256 }, limitations: {
      completeness: "RECEIVED_SNAPSHOT_ONLY", freshness: "UNKNOWN_OFFLINE", currentRevocationKnowledge: "UNAVAILABLE_OFFLINE",
      excluded: ["UNSEALED_STAGES", "UNSEALED_OBSERVATIONS", "EVIDENCE_BYTES"] } };
  const encoded = canonicalize(facts);
  const snapshot: PortableLifecycleSnapshot = { snapshotId: facts.snapshotId, proofId: facts.proofId,
    canonicalJson: encoded, sha256: sha256Hex(encoded), signature: signature(encoded), root, supplements: [], stages: [] };
  const registry: SignedTrustRegistry["registry"] = { version: 1, domain: "PACKPROOF_SIGNING_TRUST_REGISTRY", publishedAt: stamp,
    nextReviewAt: new Date(now.getTime() + 86_400_000).toISOString(), keys: [{ keyId: "test-record", algorithm: "ECDSA_SHA_256",
      publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }).toString(), validFrom: new Date(now.getTime() - 86_400_000).toISOString(),
      validUntil: null, status: "ACTIVE", statusEffectiveAt: null, reason: null }] };
  const authorityPem = authority.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signedRegistry = (): SignedTrustRegistry => ({ registry, signature: signature(canonicalize(registry), authority, "external-authority") });
  const check = (record = snapshot, options: { expectedTenantId?: string; expectedSnapshotSha256?: string } = {}) => verifyPortableLifecycleSnapshot({
    snapshot: record, trust: { signedRegistry: signedRegistry(), pinnedRegistryAuthorityKeys: { "external-authority": authorityPem } }, now,
    expectedProofId: "proof_test", ...options });
  return { now, media, snapshot, facts, signature, registry, signedRegistry, authorityPem, check };
}

it("separates byte/signature/trust/context results without making media or physical truth claims", () => {
  const f = fixture(), original = f.snapshot.root.canonicalJson;
  expect(f.check({} as PortableLifecycleSnapshot)).toMatchObject({ verifiedReceivedSnapshot: false, issues: ["INVALID_INPUT"], availableFileDigests: "NOT_CHECKED" });
  expect(f.check()).toMatchObject({ verifiedReceivedSnapshot: true, availableFileDigests: "NOT_CHECKED", evidenceAvailability: "NOT_CHECKED",
    physicalTruthVerified: false, freshness: "UNKNOWN_OFFLINE", currentRevocationKnowledge: "UNAVAILABLE_OFFLINE",
    root: { digestValid: true, signatureValid: true }, snapshot: { digestValid: true, signatureValid: true } });
  expect(f.snapshot.root.canonicalJson).toBe(original);
  const modified = structuredClone(f.snapshot);
  modified.root.canonicalJson += " ";
  expect(f.check(modified).issues).toContain("ROOT:DIGEST_MISMATCH");
  expect(f.check(f.snapshot, { expectedTenantId: "different-tenant" }).issues).toContain("TENANT_CONTEXT_MISMATCH");
  expect(f.check(f.snapshot, { expectedSnapshotSha256: "0".repeat(64) }).issues).toContain("EXPECTED_SNAPSHOT_MISMATCH");
  const missing = structuredClone(f.snapshot), changed = { ...f.facts, supplements: [{ supplementId: "missing", sequence: 1, sha256: "0".repeat(64), previousSha256: f.snapshot.root.sha256 }] };
  missing.canonicalJson = canonicalize(changed); missing.sha256 = sha256Hex(missing.canonicalJson); missing.signature = f.signature(missing.canonicalJson);
  expect(f.check(missing).issues).toContain("SUPPLEMENT_INVENTORY_MISMATCH");
  f.registry.keys[0].status = "COMPROMISED"; f.registry.keys[0].statusEffectiveAt = f.now.toISOString();
  expect(f.check()).toMatchObject({ verifiedReceivedSnapshot: false, snapshot: { signatureValid: true, trustedAtSnapshot: false } });
  f.registry.keys[0].status = "ACTIVE"; f.registry.keys[0].statusEffectiveAt = null;
  f.registry.nextReviewAt = new Date(f.now.getTime() + 1).toISOString();
  expect(verifyPortableLifecycleSnapshot({ snapshot: f.snapshot, trust: { signedRegistry: f.signedRegistry(),
    pinnedRegistryAuthorityKeys: { "external-authority": f.authorityPem } }, now: new Date(f.now.getTime() + 2), expectedProofId: "proof_test" }))
    .toMatchObject({ verifiedReceivedSnapshot: false, snapshot: { signatureValid: true, trustCurrent: false } });
  expect(verifyPortableLifecycleSnapshot({ snapshot: f.snapshot, trust: { signedRegistry: f.signedRegistry(), pinnedRegistryAuthorityKeys: {} },
    now: f.now, expectedProofId: "proof_test" }).verifiedReceivedSnapshot).toBe(false);
});

it("independently verifies a TypeScript-signed exact-byte snapshot and originals using Python/OpenSSL offline", async () => {
  const f = fixture(), s = f.snapshot, folder = await mkdtemp(path.join(tmpdir(), "packproof-snapshot-portable-"));
  try {
    const descriptor = { path: "lifecycle/snapshot.json", snapshotId: s.snapshotId, sha256: s.sha256 };
    const packageJson = { schema: "packproof.proof-package.v1", proofId: s.proofId, manifestId: s.root.manifestId,
      canonicalManifest: JSON.parse(s.root.canonicalJson), canonicalJson: s.root.canonicalJson, manifestSha256: s.root.sha256, signature: s.root.signature,
      sources: { lifecycleSnapshot: descriptor, signedSupplements: { path: "proof-supplements.json", sequence: 0, sha256: s.root.sha256, snapshotAt: f.now.toISOString() } } };
    const json = (value: unknown) => Buffer.from(JSON.stringify(value));
    const files: Record<string, Buffer> = { "package.json": json(packageJson), "manifest.json": Buffer.from(s.root.canonicalJson),
      "media/original.bin": f.media, "integrity/evidence.json": json([{ evidenceId: "ev_test", path: "media/original.bin", status: "INCLUDED" }]),
      "lifecycle/stages.json": json([]), "lifecycle/snapshot.json": json({ canonicalJson: s.canonicalJson, sha256: s.sha256, signature: s.signature }),
      "proof-supplements.json": json({ schema: "packproof.signed-supplement-snapshot.v1", proofId: s.proofId, snapshotAt: f.now.toISOString(),
        coreManifestSha256: s.root.sha256, sequence: 0, sha256: s.root.sha256, supplements: [] }) };
    files["integrity/hashes.json"] = json(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256Hex(bytes)])));
    await writeFile(path.join(folder, "proof.zip"), await collectSmallZip(streamZip((async function* () {
      for (const [name, bytes] of Object.entries(files)) yield zipBytes(name, bytes);
    })())));
    await writeFile(path.join(folder, "registry.json"), json(f.signedRegistry()));
    await writeFile(path.join(folder, "authority.pem"), f.authorityPem);
    const verified = spawnSync("python3", ["-B", "../verifier/verify.py", path.join(folder, "proof.zip"),
      "--trust-registry", path.join(folder, "registry.json"), "--trust-authority-key", path.join(folder, "authority.pem"),
      "--trust-authority-key-id", "external-authority", "--expected-proof-id", s.proofId, "--expected-tenant-id", "tenant_test",
      "--expected-lifecycle-snapshot-sha256", s.sha256], { encoding: "utf8", env: { ...process.env, http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1" } });
    expect(verified.error).toBeUndefined(); expect(verified.status, verified.stderr || verified.stdout).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: "VERIFIED", manifestSha256: s.root.sha256, evidenceVerified: 1, completeMedia: true,
      lifecycleSnapshot: { status: "VERIFIED_RECEIVED_SNAPSHOT", signatureVerified: true, expectedSnapshotMatched: true, expectedTenantMatched: true,
        freshness: "UNKNOWN_OFFLINE", currentRevocationKnowledge: "UNAVAILABLE_OFFLINE" } });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("executes independently authored snapshot tamper, omission, stale, context and lineage rejection fixtures", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "../verifier", "-p", "test_lifecycle_snapshot.py"], { encoding: "utf8" });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toContain("Ran 8 tests");
});

it("exports a real old lifecycle snapshot after a later correction and verifies only its frozen head offline", async () => {
  const f = fixture(), clock = { now: () => f.now }, h = await createHarness(clock);
  const folder = await mkdtemp(path.join(tmpdir(), "packproof-stored-snapshot-"));
  const signer = { signManifest: async (input: { canonicalJson: string }) => f.signature(input.canonicalJson) };
  try {
    const seller = await login(h.app, "frozen-export-seller");
    const transaction = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Stored portable fixture" });
    const proof = await request(h.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller));
    const proofId = proof.body.proofId;
    await commitFulfillmentAndAttest(h, seller, proofId);
    const root = await finalizeProof(h.db, clock, seller, proofId, signer);
    const first = await appendProofSupplement(h.db, clock, signer, seller, proofId,
      { operationId: "portable-first", kind: "CORRECTION", facts: { note: "Original received note", scalar: 1e-7 } });
    const old = await createLifecycleSnapshot(h.db, clock, signer, seller, proofId, { operationId: "freeze-portable", purpose: "ARCHIVE" });
    const later = await appendProofSupplement(h.db, clock, signer, seller, proofId,
      { operationId: "portable-later", kind: "CORRECTION", facts: { note: "Later excluded correction" }, supersedesSupplementId: first.supplementId });
    const archive = await collectSmallZip(await exportEvidencePackageStream(h.db, clock, h.objectStore, seller, proofId,
      { lifecycleSnapshotId: old.snapshotId }));
    await writeFile(path.join(folder, "proof.zip"), archive);
    await writeFile(path.join(folder, "registry.json"), JSON.stringify(f.signedRegistry()));
    await writeFile(path.join(folder, "authority.pem"), f.authorityPem);
    const result = spawnSync("python3", ["-B", "../verifier/verify.py", path.join(folder, "proof.zip"),
      "--trust-registry", path.join(folder, "registry.json"), "--trust-authority-key", path.join(folder, "authority.pem"),
      "--trust-authority-key-id", "external-authority", "--expected-proof-id", proofId,
      "--expected-lifecycle-snapshot-sha256", old.sha256], { encoding: "utf8", env: { ...process.env,
        http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1" } });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout).toBe(0);
    const checked = JSON.parse(result.stdout);
    expect(checked).toMatchObject({ status: "VERIFIED", manifestSha256: root.manifest.sha256, completeMedia: true,
      supplements: { sequence: 1, headSha256: first.sha256 }, lifecycleSnapshot: { snapshotId: old.snapshotId,
        sha256: old.sha256, status: "VERIFIED_RECEIVED_SNAPSHOT", expectedSnapshotMatched: true, tenantBinding: "NOT_ESTABLISHED" } });
    expect(checked.supplements.entries.map((row: { supplementId: string }) => row.supplementId)).not.toContain(later.supplementId);
    expect((await getManifest(h.db, seller, proofId)).canonicalJson).toBe(root.manifest.canonicalJson);
  } finally { await h.close(); await rm(folder, { recursive: true, force: true }); }
});
