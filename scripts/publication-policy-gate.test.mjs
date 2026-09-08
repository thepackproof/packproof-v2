import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalSha256, evaluatePublicationPolicy, sha256 } from "./publication-policy-gate.mjs";

// These records and organizations are synthetic fixtures. The successful test
// injects local page bytes; it never publishes a policy or calls a live host.
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "packproof-policy-gate-"));
  const now = new Date("2026-09-07T12:00:00.000Z"); const pages = new Map(); let fetchCalls = 0;
  const entity = { legalName: "Gate Fixture Organization", contactAddress: "742 Policy Fixture Road, Fixture City", contactEmail: "contact@packproof-fixture.org", supportEmail: "support@packproof-fixture.org", supportUrl: "https://packproof-fixture.org/support" };
  const manifest = { schemaVersion: "packproof.publication-policy.v1", environment: "production", releaseSha: "a".repeat(40), origin: "https://packproof-fixture.org", entity, documents: {}, supportEvidence: null, offerPath: "offer.json" };
  const registry = { schemaVersion: "packproof.publication-approval-registry.v1", environment: "production", origin: manifest.origin, validUntil: "2026-09-14T12:00:00.000Z", approvals: [], workflowVerifications: [] };
  async function record(path, value) { const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value)); await writeFile(join(root, path), bytes); return { path, sha256: sha256(bytes) }; }
  const approvals = {};
  for (const kind of ["terms", "privacy", "support"]) {
    const version = `${kind}-2026-09-07`; const body = `<html><body><h1>${version}</h1><p>${entity.legalName}</p><p>${entity.contactAddress}</p><p>${entity.contactEmail}</p><p>${entity.supportEmail}</p><p>${entity.supportUrl}</p><p>This test exercises byte identity and externally supplied approval records.</p></body></html>`;
    const artifact = await record(`${kind}.html`, body);
    const approval = { schemaVersion: "packproof.policy-approval.v1", status: "approved", documentKind: kind, version, artifactSha256: artifact.sha256, entitySha256: canonicalSha256(entity), reference: `fixture-review-${kind}`, approvedAt: "2026-09-06T12:00:00.000Z", approverId: "fixture-reviewer" };
    approvals[kind] = approval;
    const approvalRecord = await record(`${kind}-approval.json`, approval);
    registry.approvals.push({ recordSha256: approvalRecord.sha256, approverId: approval.approverId });
    const servedUrl = `${manifest.origin}/${kind}/${version}`;
    manifest.documents[kind] = { version, artifact, approvalRecord, servedUrl }; pages.set(servedUrl, Buffer.from(body));
  }
  const checks = {};
  for (const kind of ["supportIntake", "supportReply", "formerSubscriberExport"]) checks[kind] = { state: "passed", evidenceReference: `fixture-run-${kind}`, evidence: await record(`${kind}.json`, { fixture: true, kind, completed: true }) };
  const support = { schemaVersion: "packproof.support-workflow-verification.v1", source: "observed", reference: "fixture-support-review", verifiedAt: "2026-09-06T12:00:00.000Z", verifierId: "fixture-operator", environment: "production", origin: manifest.origin, releaseSha: manifest.releaseSha, entitySha256: canonicalSha256(entity), supportEmail: entity.supportEmail, supportUrl: entity.supportUrl, checks };
  const offer = { schemaVersion: "packproof.billing.v1", version: "fixture-offer-v1", status: "approved", currency: "USD", priceMinor: 3900, interval: "monthly", includedFinalizedProofs: 100, maxRecordingBytes: 100_000_000, maxRecordingSeconds: 180, retentionPolicyVersion: "fixture-retention-v1", preservationStandard: "canonical-original-v1", supplements: "included_within_published_allowance", overage: "block_new_capture", approvedTermsReference: approvals.terms.reference };
  await record(manifest.offerPath, offer);
  async function saveSupport() { manifest.supportEvidence = await record("support-evidence.json", support); registry.workflowVerifications = [{ recordSha256: manifest.supportEvidence.sha256, verifierId: support.verifierId }]; }
  await saveSupport();
  async function saveApproval(kind) {
    const old = manifest.documents[kind].approvalRecord.sha256;
    manifest.documents[kind].approvalRecord = await record(`${kind}-approval.json`, approvals[kind]);
    registry.approvals = registry.approvals.map(entry => entry.recordSha256 === old ? { ...entry, recordSha256: manifest.documents[kind].approvalRecord.sha256 } : entry);
  }
  async function evaluate(options = {}) {
    const registryRecord = await record("registry.json", registry); await record("manifest.json", manifest);
    return evaluatePublicationPolicy({ manifestPath: join(root, "manifest.json"), approvalRegistryPath: join(root, "registry.json"), approvalRegistrySha256: registryRecord.sha256, now,
      fetchPage: async url => { fetchCalls++; return pages.get(url); }, ...options });
  }
  try { await run({ root, now, entity, manifest, registry, approvals, support, offer, pages, record, saveSupport, saveApproval, evaluate, fetchCalls: () => fetchCalls }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("publication is blocked without real manifest and independently pinned approval registry", async () => {
  assert.deepEqual((await evaluatePublicationPolicy()).reasons, ["PUBLICATION_MANIFEST_REQUIRED"]);
  assert.deepEqual((await evaluatePublicationPolicy({ manifestPath: "missing.json" })).reasons, ["PUBLICATION_APPROVAL_REGISTRY_PIN_REQUIRED"]);
});

test("approved exact artifacts, observed support/export checks and served bytes bind one offer receipt", async () => fixture(async context => {
  const result = await context.evaluate(); assert.equal(result.state, "passed"); assert.equal(context.fetchCalls(), 3);
  assert.equal(result.canonicalOfferSha256, canonicalSha256(context.offer)); assert.equal(result.approvedTermsReference, context.approvals.terms.reference);
  assert.equal(result.expiresAt, "2026-09-08T12:00:00.000Z");
  const { receiptSha256, ...payload } = result; assert.equal(receiptSha256, canonicalSha256(payload));
}));

test("known placeholders fail before a live page request even when hashes are freshly approved", async () => fixture(async context => {
  const doc = context.manifest.documents.terms;
  const body = `${context.pages.get(doc.servedUrl).toString()}<p>[Company Name] TODO contact@example.com</p>`;
  doc.artifact = await context.record("terms.html", body); context.approvals.terms.artifactSha256 = doc.artifact.sha256; await context.saveApproval("terms");
  const result = await context.evaluate(); assert.deepEqual(result.reasons, ["PUBLICATION_PLACEHOLDER_FOUND"]); assert.equal(context.fetchCalls(), 0);
}));

test("all existing PackProof developer-review legal placeholders are refused", async () => fixture(async context => {
  const source = await readFile(new URL("../web/src/legal/documents.ts", import.meta.url), "utf8");
  const placeholders = [...source.matchAll(/export const [A-Z_]+_PLACEHOLDER = "([^"]+)";/g)].map(match => match[1]);
  assert.ok(placeholders.length >= 5);
  const doc = context.manifest.documents.privacy; const original = context.pages.get(doc.servedUrl).toString();
  for (const placeholder of placeholders) {
    doc.artifact = await context.record("privacy.html", `${original}<mark>${placeholder}</mark>`);
    context.approvals.privacy.artifactSha256 = doc.artifact.sha256; await context.saveApproval("privacy");
    assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_PLACEHOLDER_FOUND"]);
  }
  assert.equal(context.fetchCalls(), 0);
}));

test("missing actual entity, address or support channel cannot pass", async () => fixture(async context => {
  for (const [key, value, code] of [["legalName", "", "PUBLICATION_ENTITY_REQUIRED"], ["contactAddress", "TBD", "PUBLICATION_CONTACT_REQUIRED"], ["supportEmail", "support@example.com", "PUBLICATION_SUPPORT_REQUIRED"]]) {
    const original = context.entity[key]; context.entity[key] = value;
    assert.deepEqual((await context.evaluate()).reasons, [code]); context.entity[key] = original;
  }
  assert.equal(context.fetchCalls(), 0);
}));

test("changed artifacts, unapproved status, future approval and untrusted approval record are blocked", async () => fixture(async context => {
  const artifact = context.manifest.documents.terms.artifact;
  await context.record(artifact.path, "changed after approval");
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_ARTIFACT_HASH_MISMATCH"]);
  await context.record(artifact.path, context.pages.get(context.manifest.documents.terms.servedUrl).toString());
  context.approvals.terms.status = "pending"; await context.saveApproval("terms");
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_DOCUMENT_NOT_APPROVED"]);
  context.approvals.terms.status = "approved"; context.approvals.terms.approvedAt = "2026-09-08T12:00:00.000Z"; await context.saveApproval("terms");
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_APPROVAL_IN_FUTURE"]);
  context.approvals.terms.approvedAt = "2026-09-06T12:00:00.000Z"; await context.saveApproval("terms"); context.registry.approvals.shift();
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_APPROVAL_NOT_TRUSTED"]); assert.equal(context.fetchCalls(), 0);
}));

test("an unverified, stale or failed former-subscriber export test cannot satisfy publication", async () => fixture(async context => {
  context.support.checks.formerSubscriberExport.state = "failed"; await context.saveSupport();
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_SUPPORT_CHECK_FAILED"]);
  context.support.checks.formerSubscriberExport.state = "passed"; context.support.source = "synthetic"; await context.saveSupport();
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_SUPPORT_EVIDENCE_UNVERIFIED"]);
  context.support.source = "observed"; context.support.verifiedAt = "2026-08-01T12:00:00.000Z"; await context.saveSupport();
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_SUPPORT_EVIDENCE_STALE"]);
  context.support.verifiedAt = "2026-09-06T12:00:00.000Z"; context.support.releaseSha = "b".repeat(40); await context.saveSupport();
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_SUPPORT_EVIDENCE_UNVERIFIED"]);
  context.support.releaseSha = context.manifest.releaseSha; await context.saveSupport();
  await context.record(context.support.checks.formerSubscriberExport.evidence.path, "changed observed evidence");
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_SUPPORT_CHECK_EVIDENCE_MISMATCH"]); assert.equal(context.fetchCalls(), 0);
}));

test("failed live checks and different served bytes cannot reuse captured or approved bytes", async () => fixture(async context => {
  assert.deepEqual((await context.evaluate({ fetchPage: async () => { throw new Error("private provider response must never leak"); } })).reasons, ["PUBLICATION_SERVED_PAGE_UNVERIFIED"]);
  context.pages.set(context.manifest.documents.privacy.servedUrl, Buffer.from("old privacy policy"));
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_SERVED_PAGE_HASH_MISMATCH"]);
}));

test("wrong registry pin, expired registry, mismatched offer and another page origin remain blocked", async () => fixture(async context => {
  assert.deepEqual((await context.evaluate({ approvalRegistrySha256: "0".repeat(64) })).reasons, ["PUBLICATION_APPROVAL_REGISTRY_PIN_MISMATCH"]);
  context.registry.validUntil = "2026-09-07T11:00:00.000Z";
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_APPROVAL_REGISTRY_EXPIRED"]);
  context.registry.validUntil = "2026-09-07T13:00:00.000Z";
  assert.equal((await context.evaluate()).expiresAt, context.registry.validUntil);
  context.offer.approvedTermsReference = "another-policy-review"; await context.record("offer.json", context.offer);
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_OFFER_APPROVAL_MISMATCH"]);
  context.manifest.documents.terms.servedUrl = "https://unrelated.packproof-fixture.org/terms";
  assert.deepEqual((await context.evaluate()).reasons, ["PUBLICATION_SERVED_ORIGIN_MISMATCH"]);
}));

test("explicit CLI command exits blocked and overwrites a stale success without failing ordinary CI", async () => {
  const root = await mkdtemp(join(tmpdir(), "packproof-policy-cli-"));
  try {
    const output = join(root, "receipt.json"); await writeFile(output, '{"state":"passed"}');
    const command = spawnSync(process.execPath, [fileURLToPath(new URL("./publication-policy-gate.mjs", import.meta.url)), "--output", output], { encoding: "utf8", env: { ...process.env, PACKPROOF_PUBLICATION_APPROVAL_REGISTRY_SHA256: "" } });
    assert.equal(command.status, 1); assert.equal(JSON.parse(command.stdout).state, "blocked");
    assert.equal(JSON.parse(await readFile(output, "utf8")).state, "blocked");
  } finally { await rm(root, { recursive: true, force: true }); }
});
