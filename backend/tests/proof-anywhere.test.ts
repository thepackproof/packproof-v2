import { createSign, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import { sha256Hex } from "../src/hash.js";
import { createProofPackage } from "../src/domain/proof-package.js";
import { zipFiles } from "../src/export/zip.js";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const now = new Date();
const freshTrust = {
  schema: "packproof.trust-list.v1",
  generatedAt: new Date(now.getTime() - 60_000).toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  keys: [{ keyId: "fixture-key", algorithm: "ECDSA_SHA_256", status: "ACTIVE", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() }],
};
function fixture(signed = true) {
  const media = Buffer.from("Independent test recording bytes. Not real customer evidence.");
  const manifest = { manifestVersion: 1, proofId: "proof_fixture", evidence: [{ evidenceId: "evd_fixture", byteSize: media.length, sha256: sha256Hex(media) }] };
  const pkg = createProofPackage({ proofId: manifest.proofId, manifestId: "man_fixture", manifest });
  if (signed) {
    const signer = createSign("sha256"); signer.update(pkg.canonicalJson); signer.end();
    pkg.signature = { algorithm: "ECDSA_SHA_256", keyId: "fixture-key", signatureBase64: signer.sign(privateKey, "base64"), signedAt: now.toISOString() };
  }
  const files = new Map<string, Buffer>();
  const json = (name: string, value: unknown) => files.set(name, Buffer.from(canonicalize(value)));
  json("package.json", pkg); files.set("manifest.json", Buffer.from(pkg.canonicalJson)); files.set("evidence/evd_fixture.bin", media);
  json("integrity/evidence.json", [{ evidenceId: "evd_fixture", path: "evidence/evd_fixture.bin", sha256: sha256Hex(media), byteSize: media.length, status: "INCLUDED" }]);
  json("integrity/signatures.json", { manifestSignature: pkg.signature }); json("lifecycle/stages.json", []);
  json("archive.json", { schema: "packproof.proof-archive.v1", canonicalization: "packproof.sorted-json.v1", snapshot: { proofId: pkg.proofId, manifestId: pkg.manifestId, manifestSha256: pkg.manifestSha256 }, disclosure: { kind: "PARTICIPANT_FULL_RECORD" }, omissions: [], derivatives: [] });
  const rehash = () => json("integrity/hashes.json", Object.fromEntries([...files].filter(([name]) => name !== "integrity/hashes.json").map(([name, bytes]) => [name, sha256Hex(bytes)])));
  rehash(); return { files, rehash, json, pkg };
}
async function check(files: Map<string, Buffer>, trust: unknown = freshTrust, expected?: string, report = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "proof-anywhere-"));
  try {
    const zip = path.join(directory, "proof.zip"); await writeFile(zip, zipFiles([...files].map(([name, bytes]) => ({ name, bytes }))));
    const args = ["../verifier/verify.py", zip];
    if (trust) { const trustPath = path.join(directory, "independent-trust.json"); await writeFile(trustPath, JSON.stringify(trust)); args.push("--trust-list", trustPath); }
    if (expected) args.push("--expected-manifest-sha256", expected);
    const reportPath = path.join(directory, "verification.html");
    if (report) args.push("--html-report", reportPath);
    const executed = spawnSync("python3", args, { encoding: "utf8", env: { ...process.env, http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1" } });
    expect(executed.error).toBeUndefined(); return { code: executed.status, ...JSON.parse(executed.stdout), html: report ? await readFile(reportPath, "utf8") : undefined };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
describe("independent Proof Anywhere verifier", () => {
  it("verifies a signed archive offline against an independently supplied key", async () => {
    const result = await check(fixture().files);
    expect(result).toMatchObject({ status: "VERIFIED", signatureVerified: true, code: 0, evidenceVerified: 1, completeMedia: true, trust: { status: "FRESH", networkUsed: false } });
    expect(result.supplements.coveredByRootSignature).toBe(false);
  });
  it("reports modified and missing files as different failures", async () => {
    const modified = fixture(); modified.files.set("evidence/evd_fixture.bin", Buffer.from("modified"));
    expect(await check(modified.files)).toMatchObject({ code: 1, status: "MODIFIED_FILES" });
    modified.rehash(); expect(await check(modified.files)).toMatchObject({ code: 1, status: "MODIFIED_FILES" });
    const missing = fixture(); missing.files.delete("evidence/evd_fixture.bin"); expect(await check(missing.files)).toMatchObject({ code: 1, status: "MISSING_FILES" });
  });
  it("never trusts a key from the archive and distinguishes unsigned records", async () => {
    const unknown = fixture(); unknown.json("untrusted-key.json", freshTrust); unknown.rehash();
    expect(await check(unknown.files, { ...freshTrust, keys: [] })).toMatchObject({ status: "UNKNOWN_KEY", signatureVerified: false, code: 2 });
    const unsigned = fixture(false); expect(await check(unsigned.files, null)).toMatchObject({ status: "UNSIGNED", signatureVerified: false, code: 2 });
    expect(await check(unsigned.files, null, unsigned.pkg.manifestSha256)).toMatchObject({ status: "VERIFIED_INDEPENDENT_DIGEST", signatureVerified: false, code: 0 });
  });
  it("distinguishes revoked keys, stale trust, unsupported versions and invalid signatures", async () => {
    const f = fixture();
    expect(await check(f.files, { ...freshTrust, keys: freshTrust.keys.map(key => ({ ...key, status: "REVOKED" })) })).toMatchObject({ status: "REVOKED_KEY", signatureVerified: false });
    expect(await check(f.files, { ...freshTrust, generatedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-02-01T00:00:00Z" })).toMatchObject({ status: "TRUST_STALE", signatureVerified: true, code: 2 });
    f.pkg.signature!.signatureBase64 = Buffer.from("forged").toString("base64"); f.json("package.json", f.pkg); f.json("integrity/signatures.json", { manifestSignature: f.pkg.signature }); f.rehash();
    expect(await check(f.files)).toMatchObject({ status: "INVALID_SIGNATURE", signatureVerified: false });
    f.json("package.json", { ...f.pkg, schema: "packproof.proof-package.v99" }); f.rehash(); expect(await check(f.files)).toMatchObject({ status: "UNSUPPORTED_VERSION", code: 1 });
  });
  it("makes intentional omissions visible without verifying excluded bytes", async () => {
    const f = fixture(); f.files.delete("evidence/evd_fixture.bin");
    const evidence = (f.pkg.canonicalManifest as { evidence: Array<{ evidenceId: string; byteSize: number; sha256: string }> }).evidence[0];
    f.json("integrity/evidence.json", [{ ...evidence, status: "OMITTED", reason: "UNAVAILABLE" }]);
    const metadata = JSON.parse(f.files.get("archive.json")!.toString()); metadata.omissions = [{ evidenceId: evidence.evidenceId, reason: "UNAVAILABLE" }]; f.json("archive.json", metadata); f.rehash();
    expect(await check(f.files)).toMatchObject({ status: "OMITTED_FILES", signatureVerified: true, completeMedia: false, evidenceVerified: 0, code: 2 });
  });
  it("rejects hostile paths, duplicate entries and expanded archive sizes without extracting", async () => {
    expect(() => zipFiles([{ name: "../escape", bytes: Buffer.alloc(0) }])).toThrow();
    expect(() => zipFiles([{ name: "file", bytes: Buffer.alloc(0) }, { name: "file", bytes: Buffer.alloc(0) }])).toThrow();
    const dir = await mkdtemp(path.join(tmpdir(), "proof-hostile-"));
    try {
      for (const scenario of ["duplicate", "traversal", "backslash", "compression"]) {
        const file = path.join(dir, "hostile.zip");
        const made = spawnSync("python3", ["-c", "import sys,zipfile\np,s=sys.argv[1:]\nwith zipfile.ZipFile(p,'w',compression=zipfile.ZIP_DEFLATED) as z:\n if s=='duplicate': z.writestr('file',b''); z.writestr('file',b'')\n elif s=='traversal': z.writestr('../escape',b'')\n elif s=='backslash': z.writestr('C:\\\\escape',b'')\n else: z.writestr('bomb',b'0'*1000000)", file, scenario]);
        expect(made.status).toBe(0); const read = spawnSync("python3", ["../verifier/verify.py", file], { encoding: "utf8" }); expect(JSON.parse(read.stdout).status).toBe("UNSAFE_ARCHIVE");
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("creates a human-readable offline report with source hashes and escaped hostile content", async () => {
    const valid = fixture();
    const report = await check(valid.files, freshTrust, undefined, true);
    expect(report.code).toBe(0); expect(report.html).toContain("Verification report");
    expect(report.html).toContain("evidence/evd_fixture.bin"); expect(report.html).toContain("HASH_MATCHED");
    expect(report.html).toContain("Content-Security-Policy"); expect(report.html).not.toContain("<script");
    const malicious = '<img src="https://example.test/leak" onerror="alert(1)">';
    const f = fixture(false);
    const pkg = createProofPackage({ proofId: malicious, manifestId: f.pkg.manifestId, manifest: { ...(f.pkg.canonicalManifest as object), proofId: malicious } });
    f.json("package.json", pkg); f.files.set("manifest.json", Buffer.from(pkg.canonicalJson));
    const metadata = JSON.parse(f.files.get("archive.json")!.toString());
    metadata.snapshot = { proofId: malicious, manifestId: pkg.manifestId, manifestSha256: pkg.manifestSha256 };
    f.json("archive.json", metadata); f.rehash();
    const escaped = await check(f.files, null, undefined, true);
    expect(escaped.status).toBe("UNSIGNED"); expect(escaped.html).toContain("&lt;img");
    expect(escaped.html).not.toContain("<img"); expect(escaped.html).not.toContain("<iframe");
    expect(escaped.html).not.toContain("<a "); expect(escaped.html).not.toContain("<video");
  });
  it("never overwrites the input archive when a report path already exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "proof-report-"));
    try {
      const f = fixture(false), zip = path.join(dir, "proof.zip");
      const before = zipFiles([...f.files].map(([name, bytes]) => ({ name, bytes }))); await writeFile(zip, before);
      const result = spawnSync("python3", ["../verifier/verify.py", zip, "--html-report", zip], { encoding: "utf8" });
      expect(result.status).toBe(1); expect(JSON.parse(result.stdout).reportError).toContain("new writable path");
      expect(await readFile(zip)).toEqual(before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("matches published canonical byte vectors without replacing the existing algorithm", async () => {
    const vectors = JSON.parse(await readFile("../verifier/canonical-vectors.json", "utf8"));
    for (const vector of vectors.vectors) { expect(canonicalize(vector.input)).toBe(vector.canonicalJson); expect(sha256Hex(vector.canonicalJson)).toBe(vector.sha256); }
    const checked = spawnSync("python3", ["-c", "import hashlib,json,sys\nv=json.load(open(sys.argv[1]))\nassert all(hashlib.sha256(x['canonicalJson'].encode('utf-8')).hexdigest()==x['sha256'] for x in v['vectors'])", "../verifier/canonical-vectors.json"]); expect(checked.status).toBe(0);
  });
});
