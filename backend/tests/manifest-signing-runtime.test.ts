import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { loadManifestSigningRuntime, type ManifestTrustList } from "../src/integrity/signing-runtime.js";
import { auth, commitProofEvidence, createHarness, login, type TestHarness } from "./helpers.js";
import { commitAttestation } from "../src/domain/attestations.js";
import { getManifest, finalizeProof } from "../src/domain/finalize.js";
import { exportEvidencePackage } from "../src/domain/evidence-review.js";
import { verifyManifestIntegrity } from "../src/domain/manifest-signing.js";
import { canonicalize } from "../src/canonical.js";
import { sha256Hex } from "../src/hash.js";

let h: TestHarness | undefined;
const directories: string[] = [];
afterEach(async () => { await h?.close(); h = undefined; await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const clock = { now: () => new Date("2026-09-05T12:00:00Z") };
async function config(algorithm: "ECDSA_SHA_256" | "RSASSA_PSS_SHA_256" = "ECDSA_SHA_256") {
  const keys = algorithm === "ECDSA_SHA_256" ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = await mkdtemp(path.join(tmpdir(), "manifest-signing-test-")); directories.push(dir);
  const privateFile = path.join(dir, "test-only-key.pem"), trustFile = path.join(dir, "public-trust.json");
  const publicPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  await writeFile(privateFile, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const trust: ManifestTrustList = { schema: "packproof.trust-list.v1", generatedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", keys: [{ keyId: "test-only-signing-key", algorithm, status: "ACTIVE", publicKeyPem: publicPem }] };
  await writeFile(trustFile, JSON.stringify(trust));
  return { privateFile, trustFile, trust, publicPem, dir, env: { PACKPROOF_MANIFEST_SIGNING_MODE: "pem", PACKPROOF_MANIFEST_SIGNING_REQUIRED: "true", PACKPROOF_MANIFEST_SIGNING_KEY_FILE: privateFile, PACKPROOF_MANIFEST_SIGNING_KEY_ID: "test-only-signing-key", PACKPROOF_MANIFEST_SIGNING_ALGORITHM: algorithm, PACKPROOF_MANIFEST_TRUST_LIST_FILE: trustFile } };
}
async function readyProof() {
  const seller = await login(h!.app, "signed-record-seller");
  const transaction = await request(h!.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Signed sample" });
  const response = await request(h!.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller));
  const proofId = response.body.proofId as string;
  const evidence = await commitProofEvidence(h!, seller, proofId, { evidenceType: "FULFILLMENT_CAPTURE" });
  await commitAttestation(h!.db, h!.clock, seller, proofId, { statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: evidence.evidenceId });
  return { seller, proofId };
}

describe("configured manifest signing", () => {
  it("signs finalization once, preserves the stored signature on retries, and verifies the exported package independently", async () => {
    const fixture = await config(); const runtime = loadManifestSigningRuntime(clock, fixture.env);
    h = await createHarness(clock, { manifestSigning: runtime });
    const { seller, proofId } = await readyProof();
    const result = await request(h.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.manifest.signature.keyId).toBe("test-only-signing-key");
    const manifest = await getManifest(h.db, seller, proofId);
    expect(manifest).toEqual(result.body.manifest);
    const retry = await finalizeProof(h.db, clock, seller, proofId, { signManifest: async () => { throw new Error("Must reuse frozen signature"); } });
    expect(retry.manifest).toEqual(manifest);
    const zip = path.join(fixture.dir, "signed-proof.zip"); await writeFile(zip, await exportEvidencePackage(h.db, clock, h.objectStore, seller, proofId));
    const verified = spawnSync("python3", ["../verifier/verify.py", zip, "--trust-list", fixture.trustFile], { encoding: "utf8" });
    expect(verified.status, verified.stdout).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: "VERIFIED", signatureVerified: true, evidenceVerified: 1 });
    const publicTrust = await request(h.app).get("/.well-known/packproof-trust.json");
    expect(publicTrust.status).toBe(200); expect(publicTrust.body).toEqual(runtime.trustList);
    expect(publicTrust.text).not.toContain("PRIVATE KEY"); expect(publicTrust.text).not.toContain(fixture.privateFile);
    const status = await request(h.app).get("/integrity/signing"); expect(status.body).toMatchObject({ mode: "SIGNED", required: true });
    await expect(h.db.query("UPDATE final_manifests SET signature_base64='changed' WHERE proof_id=$1", [proofId])).rejects.toThrow();
  });
  it("never silently falls back to unsigned finalization after a signer failure", async () => {
    h = await createHarness(clock); const { seller, proofId } = await readyProof();
    await expect(finalizeProof(h.db, clock, seller, proofId, { signManifest: async () => { throw new Error("Unavailable signer"); } })).rejects.toThrow("Unavailable signer");
    expect((await h.db.query("SELECT * FROM final_manifests WHERE proof_id=$1", [proofId])).rows).toHaveLength(0);
    expect((await h.db.query("SELECT status FROM proofs WHERE id=$1", [proofId])).rows[0].status).toBe("EVIDENCE_COMMITTED");
  });
  it("supports RSA-PSS SHA-256 with the same frozen canonical bytes", async () => {
    const f = await config("RSASSA_PSS_SHA_256"); const runtime = loadManifestSigningRuntime(clock, f.env);
    const canonicalJson = canonicalize({ manifestVersion: 1, proofId: "rsa-fixture", evidence: [] }); const sha256 = sha256Hex(canonicalJson);
    const signature = await runtime.signer!.signManifest({ proofId: "rsa-fixture", manifestId: "manifest", canonicalJson, sha256 });
    expect(verifyManifestIntegrity({ canonicalJson, expectedSha256: sha256, signature, publicKeyPem: f.publicPem }).signatureValid).toBe(true);
  });
  it("fails startup for missing, expired, revoked, mismatched or unsafe key configuration", async () => {
    expect(() => loadManifestSigningRuntime(clock, { PACKPROOF_MANIFEST_SIGNING_REQUIRED: "true" })).toThrow("required");
    expect(() => loadManifestSigningRuntime(clock, { PACKPROOF_MANIFEST_SIGNING_MODE: "typo" })).toThrow("choose");
    const f = await config();
    expect(() => loadManifestSigningRuntime(clock, { ...f.env, PACKPROOF_MANIFEST_SIGNING_KEY_FILE: "/not-a-real-file" })).toThrow("unavailable");
    await writeFile(f.trustFile, JSON.stringify({ ...f.trust, expiresAt: "2026-09-02T00:00:00Z" }));
    expect(() => loadManifestSigningRuntime(clock, f.env)).toThrow("current");
    await writeFile(f.trustFile, JSON.stringify({ ...f.trust, keys: f.trust.keys.map(key => ({ ...key, status: "REVOKED" })) }));
    expect(() => loadManifestSigningRuntime(clock, f.env)).toThrow("revoked");
    const other = await config();
    await writeFile(f.trustFile, JSON.stringify({ ...f.trust, keys: other.trust.keys }));
    expect(() => loadManifestSigningRuntime(clock, f.env)).toThrow("differ");
    await writeFile(f.trustFile, JSON.stringify(f.trust)); await chmod(f.privateFile, 0o644);
    if (process.platform !== "win32") expect(() => loadManifestSigningRuntime(clock, f.env)).toThrow("unsafe");
  });
  it("reports default unsigned mode explicitly and refuses expired trust while running", async () => {
    h = await createHarness(clock, { manifestSigning: loadManifestSigningRuntime(clock, {}) });
    expect((await request(h.app).get("/integrity/signing")).body).toMatchObject({ mode: "UNSIGNED" });
    expect((await request(h.app).get("/.well-known/packproof-trust.json")).status).toBe(503);
    const f = await config(); let time = clock.now();
    const runtime = loadManifestSigningRuntime({ now: () => time }, f.env); time = new Date("2027-01-01T00:00:00Z");
    await expect(runtime.signer!.signManifest({ proofId: "p", manifestId: "m", canonicalJson: "{}", sha256: sha256Hex("{}") })).rejects.toMatchObject({ code: "MANIFEST_TRUST_EXPIRED" });
  });
});
