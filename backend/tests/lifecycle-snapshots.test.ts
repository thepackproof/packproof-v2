import { generateKeyPairSync, sign } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeProof, getManifest } from "../src/domain/finalize.js";
import { appendProofSupplement } from "../src/domain/proof-supplements.js";
import { createLifecycleSnapshot, getLifecycleSnapshot, type LifecycleSnapshotPayload } from "../src/domain/lifecycle-snapshots.js";
import { acceptCommerceReceiver, commitStageEvidence, createCommerceStage, finalizeCommerceStage, initializeStageEvidence, inviteCommerceReceiver, requireCommerceAccess } from "../src/domain/commerce-lifecycle.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { verifyManifestIntegrity, type ManifestSigner } from "../src/domain/manifest-signing.js";
import { sha256Hex } from "../src/hash.js";
import { auth, commitFulfillmentAndAttest, createHarness, login, prepareCameraCapture, type TestHarness } from "./helpers.js";

describe("frozen commerce lifecycle snapshots", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const now = new Date("2026-09-10T12:00:00.000Z"), clock = { now: () => now };
  const signer: ManifestSigner = { signManifest: async input => ({ algorithm: "ECDSA_SHA_256", keyId: "snapshot-test", signedAt: now.toISOString(), signatureBase64: sign("sha256", Buffer.from(input.canonicalJson), keys.privateKey).toString("base64") }) };
  let h: TestHarness, seller: string, buyer: string, stranger: string, proofId: string, transactionId: string, rootJson: string, rootHash: string;
  beforeAll(async () => {
    h = await createHarness(clock);
    seller = await login(h.app, "lifecycle-seller");
    buyer = await login(h.app, "lifecycle-buyer");
    stranger = await login(h.app, "lifecycle-stranger");
    const transaction = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Snapshot café · 東京 · 😀" });
    transactionId = transaction.body.transactionId;
    const proof = await request(h.app).post(`/transactions/${transactionId}/proof`).set(auth(seller));
    proofId = proof.body.proofId;
    const invitation = await createInvitation(h.db, clock, seller, proofId, { inviteeUserId: buyer });
    await acceptInvitation(h.db, clock, buyer, invitation.invitation.token);
    await commitFulfillmentAndAttest(h, seller, proofId);
    const sealed = await finalizeProof(h.db, clock, seller, proofId, signer);
    rootJson = sealed.manifest.canonicalJson;
    rootHash = sealed.manifest.sha256;
  });
  afterAll(async () => { if (h) await h.close(); });

  it("signs exact original bytes and a fixed chain; later supplements do not enter older snapshots", async () => {
    const firstSupplement = await appendProofSupplement(h.db, clock, signer, seller, proofId, { operationId: "snapshot-first", kind: "CORRECTION", facts: { note: "café · 東京", scale: 1e-7 } });
    const first = await createLifecycleSnapshot(h.db, clock, signer, seller, proofId, { operationId: "freeze-first", purpose: "CLAIM" });
    const payload = JSON.parse(first.canonicalJson) as LifecycleSnapshotPayload;
    expect(payload).toMatchObject({ version: 1, domain: "PACKPROOF_LIFECYCLE_SNAPSHOT", transactionId, tenantId: null, purpose: "CLAIM", cutoffAt: now.toISOString(), scope: "SEALED_COMMERCE_LIFECYCLE", root: { sha256: rootHash }, watermark: { supplementSequence: 1, supplementSha256: firstSupplement.sha256 }, limitations: { freshness: "UNKNOWN_OFFLINE", completeness: "RECEIVED_SNAPSHOT_ONLY" } });
    expect(first.root.canonicalJson).toBe(rootJson);
    expect(Buffer.from(first.root.canonicalJson)).toEqual(Buffer.from(rootJson));
    expect(first.supplements).toEqual([firstSupplement]);
    expect(verifyManifestIntegrity({ canonicalJson: first.canonicalJson, expectedSha256: first.sha256, signature: first.signature, publicKeyPem })).toMatchObject({ digestValid: true, signatureValid: true });

    const next = await appendProofSupplement(h.db, clock, signer, seller, proofId, { operationId: "snapshot-second", kind: "CORRECTION", facts: { note: "Later statement" }, supersedesSupplementId: firstSupplement.supplementId });
    const newer = await createLifecycleSnapshot(h.db, clock, signer, seller, proofId, { operationId: "freeze-newer", purpose: "CLAIM" });
    expect(newer.supplements.map(s => s.sha256)).toEqual([firstSupplement.sha256, next.sha256]);
    expect(await getLifecycleSnapshot(h.db, buyer, proofId, first.snapshotId)).toEqual(first);
    // A lost response can be replayed even while signing is unavailable.
    expect(await createLifecycleSnapshot(h.db, clock, undefined, seller, proofId, { operationId: "freeze-first", purpose: "CLAIM" })).toEqual(first);
    expect((await getManifest(h.db, seller, proofId)).canonicalJson).toBe(rootJson);
  });

  it("reuses sealed commerce stages while excluding unfinished stages and retaining source signatures", async () => {
    const receipt = await createCommerceStage(h.db, clock, buyer, proofId, "RECEIPT");
    const before = await createLifecycleSnapshot(h.db, clock, signer, buyer, proofId, { operationId: "receipt-before" });
    expect(before.stages).toEqual([]);
    const capture = await prepareCameraCapture(h, buyer, proofId, "receipt-capture", receipt.stageId);
    const upload = await initializeStageEvidence(h.db, clock, h.objectStore, buyer, proofId, receipt.stageId, { contentType: "video/mp4", idempotencyKey: "receipt-video", captureSessionId: capture.captureSessionId });
    const staging = (await h.db.query<{ object_key: string }>("SELECT object_key FROM commerce_stage_evidence WHERE id=$1", [upload.evidenceId])).rows[0].object_key;
    await h.objectStore.put(staging, capture.bytes, "video/mp4");
    await commitStageEvidence(h.db, clock, h.objectStore, buyer, proofId, receipt.stageId, upload.evidenceId, sha256Hex(capture.bytes));
    const sealed = await finalizeCommerceStage(h.db, clock, buyer, proofId, receipt.stageId, "I_RECORDED_RECEIPT", signer);
    await createCommerceStage(h.db, clock, buyer, proofId, "RETURN_PACKING");
    const after = await createLifecycleSnapshot(h.db, clock, signer, buyer, proofId, { operationId: "receipt-after" });
    expect(after.stages).toHaveLength(1);
    expect(after.stages[0]).toMatchObject({ stageId: receipt.stageId, proofId, type: "RECEIPT", sha256: sealed.sha256 });
    const stored = (await h.db.query<{ canonical_json: string }>("SELECT canonical_json FROM commerce_stages WHERE id=$1", [receipt.stageId])).rows[0];
    expect(after.stages[0].canonicalJson).toBe(stored.canonical_json);
    expect(after.supplements.at(-1)?.signature.keyId).toBe("snapshot-test");
    expect((await getLifecycleSnapshot(h.db, seller, proofId, before.snapshotId)).stages).toEqual([]);
  });

  it("scopes idempotency to actor and Proof, rejects changed requests, and enforces read/write access", async () => {
    await expect(createLifecycleSnapshot(h.db, clock, signer, seller, proofId, { operationId: "freeze-first", purpose: "ARCHIVE" })).rejects.toMatchObject({ code: "LIFECYCLE_SNAPSHOT_OPERATION_CONFLICT" });
    const buyerSnapshot = await createLifecycleSnapshot(h.db, clock, signer, buyer, proofId, { operationId: "freeze-first", purpose: "CLAIM" });
    expect(JSON.parse(buyerSnapshot.canonicalJson).actorUserId).toBe(buyer);
    await expect(createLifecycleSnapshot(h.db, clock, signer, stranger, proofId, { operationId: "stranger-snapshot" })).rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED" });
    await expect(getLifecycleSnapshot(h.db, stranger, proofId, buyerSnapshot.snapshotId)).rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED" });
    await expect(getLifecycleSnapshot(h.db, seller, proofId, "life_missing")).rejects.toMatchObject({ code: "LIFECYCLE_SNAPSHOT_NOT_FOUND" });
    await expect(h.db.query("UPDATE lifecycle_snapshots SET canonical_json='{}' WHERE id=$1", [buyerSnapshot.snapshotId])).rejects.toThrow("LIFECYCLE_SNAPSHOT_IMMUTABLE");
    await expect(h.db.query("DELETE FROM lifecycle_snapshots WHERE id=$1", [buyerSnapshot.snapshotId])).rejects.toThrow("LIFECYCLE_SNAPSHOT_IMMUTABLE");
  });

  it("records actual tenant identity and rolls back an unavailable or failed signature", async () => {
    await h.db.query("INSERT INTO api_tenants(id,owner_user_id,name,environment,created_at) VALUES($1,$2,$3,'sandbox',$4)", ["tenant-lifecycle", seller, "Lifecycle test", now.toISOString()]);
    await h.db.query("INSERT INTO api_tenant_proofs(tenant_id,external_id,proof_id,request_hash,created_at) VALUES($1,$2,$3,$4,$5)", ["tenant-lifecycle", "order-lifecycle", proofId, sha256Hex("binding"), now.toISOString()]);
    const snapshot = await createLifecycleSnapshot(h.db, clock, signer, seller, proofId, { operationId: "tenant-snapshot" });
    expect(JSON.parse(snapshot.canonicalJson)).toMatchObject({ tenantId: "tenant-lifecycle", transactionId });
    await expect(createLifecycleSnapshot(h.db, clock, undefined, seller, proofId, { operationId: "no-signing-key" })).rejects.toMatchObject({ code: "MANIFEST_SIGNING_UNAVAILABLE" });
    const failure: ManifestSigner = { signManifest: async () => { throw new Error("SIGNER_FAILED"); } };
    await expect(createLifecycleSnapshot(h.db, clock, failure, seller, proofId, { operationId: "failed-signing" })).rejects.toThrow("SIGNER_FAILED");
    expect((await h.db.query("SELECT id FROM lifecycle_snapshots WHERE operation_id IN ('no-signing-key','failed-signing')")).rows).toEqual([]);
  });

  it("does not extend full-record snapshots to accepted receiver-only grants", async () => {
    const transaction = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Receiver-scoped record" });
    const proof = await request(h.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller));
    const scopedProofId = proof.body.proofId;
    await commitFulfillmentAndAttest(h, seller, scopedProofId);
    await finalizeProof(h.db, clock, seller, scopedProofId, signer);
    await inviteCommerceReceiver(h.db, clock, seller, scopedProofId, stranger);
    await acceptCommerceReceiver(h.db, clock, stranger, scopedProofId);
    expect(await requireCommerceAccess(h.db, scopedProofId, stranger)).toBe("BUYER");
    const snapshot = await createLifecycleSnapshot(h.db, clock, signer, seller, scopedProofId, { operationId: "full-record-owner" });
    await expect(createLifecycleSnapshot(h.db, clock, signer, stranger, scopedProofId, { operationId: "receiver-create" })).rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED" });
    await expect(getLifecycleSnapshot(h.db, stranger, scopedProofId, snapshot.snapshotId)).rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED" });
    expect((await h.db.query("SELECT id FROM lifecycle_snapshots WHERE proof_id=$1 AND actor_user_id=$2", [scopedProofId, stranger])).rows).toEqual([]);
  });

  it("rejects an oversized history without silently signing a truncated prefix", async () => {
    const head = (await h.db.query<{ sequence: number }>("SELECT MAX(sequence) AS sequence FROM proof_supplements WHERE proof_id=$1", [proofId])).rows[0].sequence;
    // Admission check runs before any source serialization or signer request.
    await h.db.query(`INSERT INTO proof_supplements(id,proof_id,sequence,operation_id,kind,canonical_json,sha256,previous_sha256,core_manifest_sha256,signature_json,created_at)
      SELECT 'limit-'||n,$1,n,'limit:'||n,'CORRECTION','{}',$2,$2,$2,'{}'::jsonb,$3 FROM generate_series($4::integer,257) n`, [proofId, rootHash, now.toISOString(), head + 1]);
    let signCalled = false;
    const limitedSigner: ManifestSigner = { signManifest: async input => { signCalled = true; return signer.signManifest(input); } };
    await expect(createLifecycleSnapshot(h.db, clock, limitedSigner, seller, proofId, { operationId: "too-many-records" })).rejects.toMatchObject({ code: "LIFECYCLE_SNAPSHOT_LIMIT" });
    expect(signCalled).toBe(false);
    expect((await h.db.query("SELECT id FROM lifecycle_snapshots WHERE operation_id='too-many-records'")).rows).toEqual([]);
  });
});
