import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDatabase } from "../src/db/postgres.js";
import { createHarness, createUser, prepareCameraCapture, type TestHarness } from "./helpers.js";
import { createTransaction } from "../src/domain/transactions.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { initializeEvidenceUpload, commitEvidence } from "../src/domain/evidence.js";
import { commitAttestation } from "../src/domain/attestations.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { getRecoveryStatus, processRecoveryOutbox, type RecoveryPublisher } from "../src/domain/recovery-journal.js";
import { appendProofSupplement, getProofSupplementSnapshot, verifyProofSupplementSnapshot } from "../src/domain/proof-supplements.js";
import { createRetentionHold } from "../src/domain/retention-controls.js";
import { assignRetentionPolicy, DRAFT_RETENTION_POLICIES, lockProofDisposition } from "../src/domain/retention-policy.js";
import { sha256Hex } from "../src/hash.js";
import type { ManifestSigner } from "../src/domain/manifest-signing.js";
import { processPolicyRecoveryOutbox } from "../src/domain/policy-recovery.js";

const databaseUrl = process.env.PACKPROOF_RELEASE_TEST_DATABASE_URL;
if (process.env.PACKPROOF_REQUIRE_POSTGRES_RELEASE_GATES === "1" && !databaseUrl) throw new Error("POSTGRES_RELEASE_DATABASE_REQUIRED");

describe.skipIf(!databaseUrl)("release invariants on independent real PostgreSQL pools", () => {
  let harness: TestHarness;
  let admin: pg.Client;
  let first: ReturnType<typeof createPgDatabase>;
  let second: ReturnType<typeof createPgDatabase>;
  const schema = `release_test_${randomBytes(10).toString("hex")}`;
  let now = new Date("2026-09-07T12:00:00.000Z");
  const clock = { now: () => new Date(now) };
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const signer: ManifestSigner = { signManifest: async input => ({ algorithm: "ECDSA_SHA_256", keyId: "release-fixture-key", signedAt: clock.now().toISOString(),
    signatureBase64: sign("sha256", Buffer.from(input.canonicalJson), pair.privateKey).toString("base64") }) };
  const objects = new Map<string, Buffer>();
  const publisher: RecoveryPublisher = {
    signer, writerGeneration: "initial", protectedStoreVerified: true, trustedPublicKey: async id => id === "release-fixture-key" ? publicKey : null,
    store: {
      putIfAbsent: async (key, body) => { if (objects.has(key)) return { created: false }; objects.set(key, body); return { created: true }; },
      get: async key => objects.has(key) ? { body: objects.get(key)!, contentType: "application/json" } : null,
      head: async key => objects.has(key) ? { versionId: "synthetic-immutable-version" } : null,
    },
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    admin = new pg.Client({ connectionString: url.toString() }); await admin.connect();
    // A unique explicitly created test schema is the only cleanup target.
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    first = createPgDatabase(url.toString()); second = createPgDatabase(url.toString());
    harness = await createHarness(clock, { opened: first });
    const version = (await first.db.query<{ version: string }>("SELECT version() AS version")).rows[0].version;
    expect(version).toMatch(/^PostgreSQL /);
    expect(version).not.toContain("PGlite");
  }, 60_000);
  afterAll(async () => {
    await harness?.close();
    await Promise.all([first?.close(), second?.close()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  async function proofFor(seller: string) {
    const transaction = await createTransaction(first.db, clock, seller, { itemTitle: "Synthetic release race" });
    return { transactionId: transaction.transactionId, ...(await createOrGetProof(first.db, clock, seller, transaction.transactionId)) };
  }
  async function publishPending() {
    for (let round = 0; round < 1000; round++) {
      if ((await processPolicyRecoveryOutbox(first.db, clock, publisher)).processed === 0) break;
      if (round === 999) throw new Error("RELEASE_FIXTURE_POLICY_RECOVERY_STALLED");
    }
    for (let round = 0; round < 20; round++) {
      const results = await Promise.all([processRecoveryOutbox(first.db, clock, publisher), processRecoveryOutbox(second.db, clock, publisher)]);
      if (results.every(result => result.processed === 0)) return;
      expect(results.some(result => result.state === "DEAD_LETTER")).toBe(false);
    }
    throw new Error("RELEASE_FIXTURE_RECOVERY_STALLED");
  }

  it("resolves simultaneous creates to one canonical transaction Proof", async () => {
    const seller = await createUser(harness);
    const transaction = await createTransaction(first.db, clock, seller, { itemTitle: "Canonical race fixture" });
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => createOrGetProof(index % 2 ? first.db : second.db, clock, seller, transaction.transactionId)));
    expect(new Set(results.map(result => result.proofId)).size).toBe(1);
    expect((await first.db.query("SELECT id FROM proofs WHERE transaction_id=$1", [transaction.transactionId])).rows).toHaveLength(1);
  });

  it("enforces the shared account admission limit across independent Proof locks", async () => {
    const seller = await createUser(harness);
    const proofs = [];
    for (let index = 0; index < 6; index++) proofs.push(await proofFor(seller));
    const results = await Promise.allSettled(proofs.map((proof, index) => initializeEvidenceUpload(index % 2 ? first.db : second.db, clock, harness.objectStore, seller, proof.proofId,
      { idempotencyKey: `admission-race-${index}`, contentType: "video/mp4", byteSize: 8 })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason.code)).toEqual(Array(4).fill("UPLOAD_CONCURRENCY_LIMIT"));
    const reserved = (await first.db.query<{ reserved_bytes: string }>("SELECT reserved_bytes FROM media_admission_accounts WHERE actor_user_id=$1", [seller])).rows[0];
    expect(Number(reserved.reserved_bytes)).toBe(16);
  });

  it("concurrent commits and strict finalizations preserve one manifest and wait for durable receipts", async () => {
    const seller = await createUser(harness); const proof = await proofFor(seller);
    const capture = await prepareCameraCapture(harness, seller, proof.proofId, "postgres-camera");
    const upload = await initializeEvidenceUpload(first.db, clock, harness.objectStore, seller, proof.proofId,
      { idempotencyKey: "postgres-upload", captureSessionId: capture.captureSessionId, evidenceType: "FULFILLMENT_CAPTURE", contentType: "video/mp4", byteSize: capture.bytes.length });
    await harness.objectStore.put(upload.objectKey, capture.bytes, "video/mp4");
    const commits = await Promise.all(Array.from({ length: 6 }, (_, index) => commitEvidence(index % 2 ? first.db : second.db, clock, harness.objectStore, seller, proof.proofId, upload.evidenceId, sha256Hex(capture.bytes))));
    expect(new Set(commits.map(result => result.sha256)).size).toBe(1);
    await commitAttestation(first.db, clock, seller, proof.proofId, { statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: upload.evidenceId });
    await expect(finalizeProof(second.db, clock, seller, proof.proofId, signer, { requireDurableReceipts: true })).rejects.toMatchObject({ code: "PRESERVATION_PENDING" });
    await publishPending();
    const prepared = await Promise.all(Array.from({ length: 6 }, (_, index) => finalizeProof(index % 2 ? first.db : second.db, clock, seller, proof.proofId, signer, { requireDurableReceipts: true })));
    expect(new Set(prepared.map(result => result.manifest.sha256)).size).toBe(1);
    expect(prepared.every(result => result.proof.status !== "FINALIZED")).toBe(true);
    expect((await first.db.query("SELECT id FROM final_manifests WHERE proof_id=$1", [proof.proofId])).rows).toHaveLength(1);
    await expect(second.db.query("UPDATE transactions SET item_title='overwrite' WHERE id=$1", [proof.transactionId])).rejects.toThrow("PROOF_ALREADY_FINALIZED");
    await publishPending();
    expect((await getRecoveryStatus(second.db, `finalize:${proof.proofId}`)).status).toBe("PRESERVED");
    const complete = await finalizeProof(second.db, clock, seller, proof.proofId, signer, { requireDurableReceipts: true });
    expect(complete.proof.status).toBe("FINALIZED"); expect(complete.manifest.canonicalJson).toBe(prepared[0].manifest.canonicalJson);
    await Promise.all(Array.from({ length: 4 }, (_, index) => appendProofSupplement(index % 2 ? first.db : second.db, clock, signer, seller, proof.proofId,
      { operationId: `release-correction-${index}`, kind: "CORRECTION", facts: { source: "synthetic fixture", index } })));
    const supplement = await getProofSupplementSnapshot(first.db, proof.proofId);
    expect(supplement.supplements.map(row => row.sequence)).toEqual([1, 2, 3, 4]);
    expect(verifyProofSupplementSnapshot({ proofId: proof.proofId, coreManifestSha256: complete.manifest.sha256, supplements: supplement.supplements,
      trustedPublicKeys: { "release-fixture-key": publicKey }, trustSnapshotAt: now.toISOString() }).valid).toBe(true);
    expect((await finalizeProof(first.db, clock, seller, proof.proofId, signer)).manifest.sha256).toBe(complete.manifest.sha256);
  }, 30_000);

  it("serializes a retention hold against disposition without accepting both outcomes", async () => {
    const seller = await createUser(harness); const proof = await proofFor(seller);
    // Fixture state is sufficient for a retention race; finalization cryptography is tested above.
    await first.db.query("UPDATE proofs SET status='FINALIZED',finalized_at=$2 WHERE id=$1", [proof.proofId, now.toISOString()]);
    await assignRetentionPolicy(first.db, clock, seller, proof.proofId, { operationId: "release-retention-policy", policy: {
      ...DRAFT_RETENTION_POLICIES["paypal-us-review-v1"], approvalReference: "synthetic-test-policy-only" }, anchors: { paymentAt: now.toISOString() } });
    await first.db.query("UPDATE retention_operations_gates SET disposal_enabled=true,approved_policy_reference='synthetic-test',successful_restore_drill_reference='synthetic-test' WHERE singleton=1");
    await first.db.query("INSERT INTO proof_disposition_state(proof_id,state,notice_at,updated_at) VALUES($1,'OPEN',$2,$2)", [proof.proofId, now.toISOString()]);
    now = new Date("2028-01-01T00:00:00.000Z");
    const results = await Promise.allSettled([
      createRetentionHold(first.db, clock, seller, proof.proofId, "Synthetic active appeal"), lockProofDisposition(second.db, clock, proof.proofId),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(["DISPOSITION_ALREADY_STARTED", "RETENTION_PROTECTED"]).toContain(failure.reason.code);
    const hold = (await first.db.query("SELECT id FROM proof_retention_holds WHERE proof_id=$1 AND released_at IS NULL", [proof.proofId])).rows.length > 0;
    const state = (await first.db.query<{ state: string }>("SELECT state FROM proof_disposition_state WHERE proof_id=$1", [proof.proofId])).rows[0].state;
    expect(hold && state === "DISPOSITION_LOCKED").toBe(false);
  });
});
