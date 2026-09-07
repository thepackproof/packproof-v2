import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, createUser, commitFulfillmentAndAttest, type TestHarness } from "./helpers.js";
import { createTransaction } from "../src/domain/transactions.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { enqueueRecoveryEvent, buildProofRecoverySnapshot, buildRecoveryReplayPlan, processRecoveryOutbox, getRecoveryStatus, getProofRecoveryStatus, verifyRecoveryEnvelope, type RecoveryPublisher } from "../src/domain/recovery-journal.js";
import { processPolicyRecoveryOutbox } from "../src/domain/policy-recovery.js";
import { appendProofSupplement, getProofSupplementSnapshot, verifyProofSupplementSnapshot } from "../src/domain/proof-supplements.js";
import { sha256Hex } from "../src/hash.js";
import { createRetentionHold } from "../src/domain/retention-controls.js";
import { lockProofDisposition, evaluateProofDisposition, evaluateRetentionDates, DRAFT_RETENTION_POLICIES, assignRetentionPolicy } from "../src/domain/retention-policy.js";
import type { ManifestSigner } from "../src/domain/manifest-signing.js";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
let now = new Date("2026-01-01T12:00:00.000Z");
const clock = { now: () => new Date(now) };
const signer: ManifestSigner = { signManifest: async input => ({ algorithm: "ECDSA_SHA_256", keyId: "test-pinned-key", signedAt: clock.now().toISOString(), signatureBase64: sign("sha256", Buffer.from(input.canonicalJson), pair.privateKey).toString("base64") }) };
class JournalStore {
  objects = new Map<string, Buffer>();
  loseResponseOnce = false;
  async putIfAbsent(key: string, body: Buffer) {
    if (this.objects.has(key)) return { created: false };
    this.objects.set(key, body);
    if (this.loseResponseOnce) { this.loseResponseOnce = false; throw new Error("response lost after immutable publication"); }
    return { created: true };
  }
  async get(key: string) { const body = this.objects.get(key); return body ? { body, contentType: "application/json" } : null; }
  async head(key: string) { return this.objects.has(key) ? { versionId: "immutable-test-version" } : null; }
}
describe("accepted-event recovery boundaries", () => {
  let h: TestHarness;
  afterEach(async () => { await h?.close(); now = new Date("2026-01-01T12:00:00.000Z"); });
  async function setup() {
    h = await createHarness(clock);
    const seller = await createUser(h);
    const transaction = await createTransaction(h.db, clock, seller, { itemTitle: "Preserved item" });
    const proof = await createOrGetProof(h.db, clock, seller, transaction.transactionId);
    const store = new JournalStore();
    const publisher: RecoveryPublisher = { store, signer, trustedPublicKey: async id => id === "test-pinned-key" ? publicPem : null, writerGeneration: "initial", protectedStoreVerified: true };
    while((await processPolicyRecoveryOutbox(h.db,clock,publisher)).processed) { /* Preserve initial account/participant policy before receipt-boundary tests. */ }
    return { seller, proofId: proof.proofId, store, publisher };
  }
  it("freezes complete facts transactionally and rejects operation conflicts and event mutation", async () => {
    const { seller, proofId } = await setup();
    const input = { operationId: "test:event:one", proofId, actorUserId: seller, kind: "EVIDENCE_COMMITTED" as const, payload: await buildProofRecoverySnapshot(h.db, proofId) };
    await h.db.transaction(tx => enqueueRecoveryEvent(tx, clock, input));
    expect((await h.db.transaction(tx => enqueueRecoveryEvent(tx, clock, input))).status).toBe("COMMITTED_PENDING_DURABILITY");
    await expect(h.db.transaction(tx => enqueueRecoveryEvent(tx, clock, { ...input, payload: { changed: true } }))).rejects.toMatchObject({ code: "RECOVERY_OPERATION_CONFLICT" });
    const row = (await h.db.query<{ canonical_json: string }>("SELECT canonical_json FROM recovery_events WHERE operation_id=$1", [input.operationId])).rows[0];
    const event = JSON.parse(row.canonical_json);
    expect(event.payload.rows.transactions[0].item_title).toBe("Preserved item");
    expect(event.payload.rows.proofs[0].created_at).toBe(now.toISOString());
    await expect(h.db.query("UPDATE recovery_events SET canonical_json='{}' WHERE operation_id=$1", [input.operationId])).rejects.toThrow("AUDIT_IMMUTABLE");
  });
  it("recovers a lost publication response with the identical signed receipt", async () => {
    const { seller, proofId, store, publisher } = await setup();
    await h.db.transaction(async tx => enqueueRecoveryEvent(tx, clock, { operationId: "test:lost-response", proofId, actorUserId: seller, kind: "EVIDENCE_COMMITTED", payload: await buildProofRecoverySnapshot(tx, proofId) }));
    store.loseResponseOnce = true;
    expect((await processRecoveryOutbox(h.db, clock, publisher)).state).toBe("PENDING");
    expect((await getRecoveryStatus(h.db, "test:lost-response")).receipt).toBeNull();
    const originalBytes = store.objects.get(`recovery/v1/${sha256Hex("test:lost-response")}.json`)!;
    now = new Date(now.getTime() + 3000);
    expect((await processRecoveryOutbox(h.db, clock, publisher)).state).toBe("DURABLE");
    const receipt = (await getRecoveryStatus(h.db, "test:lost-response")).receipt!;
    expect(receipt.envelopeSha256).toBe(sha256Hex(originalBytes));
    expect((await processRecoveryOutbox(h.db, clock, publisher)).processed).toBe(0);
    expect((await getRecoveryStatus(h.db, "test:lost-response")).receipt).toEqual(receipt);
  });
  it("quarantines conflicting envelopes and stops ordered downstream publication", async () => {
    const { seller, proofId, store, publisher } = await setup();
    for (const operationId of ["test:conflict", "test:after-conflict"]) await h.db.transaction(tx => enqueueRecoveryEvent(tx, clock, { operationId, proofId, actorUserId: seller, kind: "EVIDENCE_COMMITTED", payload: { accepted: true } }));
    store.objects.set(`recovery/v1/${sha256Hex("test:conflict")}.json`, Buffer.from('{"tampered":true}'));
    expect((await processRecoveryOutbox(h.db, clock, publisher)).state).toBe("DEAD_LETTER");
    expect((await processRecoveryOutbox(h.db, clock, publisher)).processed).toBe(0);
    expect((await getRecoveryStatus(h.db, "test:after-conflict")).status).toBe("COMMITTED_PENDING_DURABILITY");
  });
  it("fences stale writers and refuses unverified storage or unknown signing authority", async () => {
    const { seller, proofId, publisher, store } = await setup();
    await h.db.transaction(tx => enqueueRecoveryEvent(tx, clock, { operationId: "test:fence", proofId, actorUserId: seller, kind: "EVIDENCE_COMMITTED", payload: {} }));
    await expect(processRecoveryOutbox(h.db, clock, { ...publisher, protectedStoreVerified: false })).rejects.toMatchObject({ code: "RECOVERY_STORE_NOT_VERIFIED" });
    await h.db.query("UPDATE recovery_writer_fence SET generation='replacement' WHERE singleton=1");
    await processRecoveryOutbox(h.db, clock, publisher);
    expect([...store.objects.keys()].filter(key=>key.startsWith("recovery/v1/"))).toHaveLength(0);
    expect((await getRecoveryStatus(h.db, "test:fence")).errorCode).toBe("RECOVERY_WRITER_FENCED");
    now = new Date(now.getTime() + 3000);
    await processRecoveryOutbox(h.db, clock, { ...publisher, writerGeneration: "replacement" });
    await expect(verifyRecoveryEnvelope(store.objects.get(`recovery/v1/${sha256Hex("test:fence")}.json`)!, { trustedPublicKey: async () => null })).rejects.toMatchObject({ code: "RECOVERY_ENVELOPE_CONFLICT" });
  });
  it("keeps strict finalization pending until evidence, declaration and final receipts are durable", async () => {
    const { seller, proofId, publisher, store } = await setup();
    const evidence = await commitFulfillmentAndAttest(h, seller, proofId);
    await expect(finalizeProof(h.db, clock, seller, proofId, signer, { requireDurableReceipts: true })).rejects.toMatchObject({ code: "PRESERVATION_PENDING" });
    await processRecoveryOutbox(h.db, clock, publisher);
    await processRecoveryOutbox(h.db, clock, publisher);
    const prepared = await finalizeProof(h.db, clock, seller, proofId, signer, { requireDurableReceipts: true });
    expect(prepared.proof.status).toBe("EVIDENCE_COMMITTED");
    expect(prepared.recovery?.status).toBe("COMMITTED_PENDING_DURABILITY");
    await expect(h.db.query("UPDATE transactions SET item_title='mutated after frozen manifest' WHERE id=(SELECT transaction_id FROM proofs WHERE id=$1)", [proofId])).rejects.toThrow("PROOF_ALREADY_FINALIZED");
    await processRecoveryOutbox(h.db, clock, publisher);
    const completed = await finalizeProof(h.db, clock, seller, proofId, signer, { requireDurableReceipts: true });
    expect(completed.proof.status).toBe("FINALIZED");
    expect(completed.manifest.canonicalJson).toBe(prepared.manifest.canonicalJson);
    const status = await getProofRecoveryStatus(h.db, seller, proofId);
    expect(status.evidence.find(row => row.evidenceId === evidence.evidenceId)?.status).toBe("PRESERVED");
    expect(status.finalization.status).toBe("PRESERVED");
    const envelopes = [...store.objects].filter(([key])=>key.startsWith("recovery/v1/")).map(([,bytes])=>bytes);
    const replay = await buildRecoveryReplayPlan({envelopes, trustedPublicKey: publisher.trustedPublicKey, backupBoundaryHead: null});
    expect(replay.acceptedReceipts).toHaveLength(3);
    expect(replay.proofs[0].rows.proofs[0].status).toBe("FINALIZED");
    expect(replay.proofs[0].rows.final_manifests[0].canonical_json).toBe(prepared.manifest.canonicalJson);
    expect(replay.trafficMayOpen).toBe(false);
    await expect(buildRecoveryReplayPlan({envelopes: envelopes.slice(1), trustedPublicKey:publisher.trustedPublicKey, backupBoundaryHead:null})).rejects.toMatchObject({code:"RECOVERY_REPLAY_CHAIN_GAP"});
    const stranger = await createUser(h);
    await expect(getProofRecoveryStatus(h.db, stranger, proofId)).rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED" });
  });
  it("appends signed supplements while old core bytes remain unchanged and verifies dated snapshots", async () => {
    const { seller, proofId } = await setup();
    await commitFulfillmentAndAttest(h, seller, proofId);
    const original = await finalizeProof(h.db, clock, seller, proofId, signer);
    const input = { operationId: "correction:initial", kind: "CORRECTION" as const, facts: { note: "Serial number transcription corrected" } };
    const first = await appendProofSupplement(h.db, clock, signer, seller, proofId, input);
    expect(await appendProofSupplement(h.db, clock, signer, seller, proofId, input)).toEqual(first);
    await expect(appendProofSupplement(h.db, clock, signer, seller, proofId, { ...input, facts: { note: "Changed under reused key" } })).rejects.toMatchObject({ code: "SUPPLEMENT_OPERATION_CONFLICT" });
    await appendProofSupplement(h.db, clock, signer, seller, proofId, { operationId: "correction:second", kind: "CORRECTION", facts: { note: "Additional context" }, supersedesSupplementId: first.supplementId });
    const snapshot = await getProofSupplementSnapshot(h.db, proofId);
    expect(snapshot.sequence).toBe(2);
    expect((await finalizeProof(h.db, clock, seller, proofId, signer)).manifest.canonicalJson).toBe(original.manifest.canonicalJson);
    const verify = (supplements: typeof snapshot.supplements) => verifyProofSupplementSnapshot({ proofId, coreManifestSha256: original.manifest.sha256, supplements, trustedPublicKeys: { "test-pinned-key": publicPem }, trustSnapshotAt: now.toISOString() });
    expect(verify(snapshot.supplements).valid).toBe(true);
    expect(verify(snapshot.supplements.slice(0, 1)).completeness).toBe("RECEIVED_SNAPSHOT_ONLY");
    expect(verify(snapshot.supplements.slice(1)).valid).toBe(false);
    await expect(h.db.query("DELETE FROM proof_supplements WHERE id=$1", [first.supplementId])).rejects.toThrow("AUDIT_IMMUTABLE");
  });
  it("retention holds and disposition share a lock and cannot silently shorten prior promises", async () => {
    const { seller, proofId } = await setup();
    await commitFulfillmentAndAttest(h, seller, proofId);
    await finalizeProof(h.db, clock, seller, proofId, signer);
    const policy = { ...DRAFT_RETENTION_POLICIES["paypal-us-review-v1"], approvalReference: "test-only-approved-policy" };
    await assignRetentionPolicy(h.db, clock, seller, proofId, { operationId: "policy:first", policy, anchors: { paymentAt: now.toISOString() }, contractualPreserveUntil: "2027-01-01T00:00:00.000Z" });
    await assignRetentionPolicy(h.db, clock, seller, proofId, { operationId: "policy:second", policy, anchors: { paymentAt: now.toISOString() }, contractualPreserveUntil: "2026-07-01T00:00:00.000Z" });
    expect((await evaluateProofDisposition(h.db, clock, proofId)).protectedUntil).toBe("2027-01-01T00:00:00.000Z");
    await createRetentionHold(h.db, clock, seller, proofId, "Active appeal");
    await expect(lockProofDisposition(h.db, clock, proofId)).rejects.toMatchObject({ code: "DISPOSITION_GATE_CLOSED" });
    await h.db.query("UPDATE retention_operations_gates SET disposal_enabled=true,approved_policy_reference='test',successful_restore_drill_reference='test' WHERE singleton=1");
    now = new Date("2028-01-01T00:00:00.000Z");
    await h.db.query("INSERT INTO proof_disposition_state(proof_id,state,notice_at,updated_at) VALUES($1,'OPEN','2027-01-01',$2)", [proofId, now.toISOString()]);
    await expect(lockProofDisposition(h.db, clock, proofId)).rejects.toMatchObject({ code: "RETENTION_PROTECTED" });
    await h.db.query("UPDATE proof_disposition_state SET state='DISPOSITION_LOCKED' WHERE proof_id=$1", [proofId]);
    await expect(createRetentionHold(h.db, clock, seller, proofId, "Late requested hold")).rejects.toMatchObject({ code: "DISPOSITION_ALREADY_STARTED" });
  });
});

describe("retention calendar boundaries", () => {
  const policy = { ...DRAFT_RETENTION_POLICIES["paypal-us-review-v1"], approvalReference: "test-approved" };
  it("uses payment day 180 and keeps missing anchor or active-case disposition closed", () => {
    const input = { policy, anchors: { finalizedAt: "2026-01-01", paymentAt: "2026-01-01" }, now: new Date("2026-04-01"), activeHold: false, noticeAt: "2026-01-01" };
    expect(evaluateRetentionDates(input).protectedUntil).toBe("2026-06-30T00:00:00.000Z");
    expect(evaluateRetentionDates(input).eligibleForDisposition).toBe(false);
    expect(evaluateRetentionDates({ ...input, now: new Date("2026-07-01"), activeHold: true }).eligibleForDisposition).toBe(false);
    expect(evaluateRetentionDates({ ...input, now: new Date("2026-07-01"), anchors: { finalizedAt: "2026-01-01" } }).blockers).toContain("Missing payment retention anchor requires review");
  });
});
