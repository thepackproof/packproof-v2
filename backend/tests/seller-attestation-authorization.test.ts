import { generateKeyPairSync, sign, verify } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import type { Database } from "../src/db/database.js";
import { createAttestationChallenge, SELLER_SHIPPING_STATEMENT } from "../src/domain/attestation-authorization.js";
import { commitAttestation } from "../src/domain/attestations.js";
import { createCaptureSession } from "../src/domain/capture-sessions.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { sha256Hex } from "../src/hash.js";
import { auth, createHarness, createUser, prepareCameraCapture, type TestHarness } from "./helpers.js";

describe("seller shipping authorization", () => {
  let h: TestHarness;
  let seller: string;
  let other: string;
  let proofId: string;
  let now: Date;
  const clock = { now: () => new Date(now) };
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const signed = (payload: string) => sign("sha256", Buffer.from(payload, "utf8"), keys.privateKey).toString("base64");
  async function proof(actor = seller) {
    const t = await request(h.app).post("/transactions").set(auth(actor)).send({ itemTitle: "A shipped camera" });
    const p = await request(h.app).post(`/transactions/${t.body.transactionId}/proof`).set(auth(actor)).send({});
    expect(p.status).toBe(200);
    return p.body.proofId as string;
  }
  beforeEach(async () => {
    now = new Date("2026-09-06T12:00:00.000Z");
    h = await createHarness(clock);
    seller = await createUser(h);
    other = await createUser(h);
    proofId = await proof();
  });
  afterEach(async () => h.close());
  async function recording(key = "native-recording", id = proofId) {
    const capture = await prepareCameraCapture(h, seller, id, key);
    const input = { captureSessionId: capture.captureSessionId, sha256: sha256Hex(capture.bytes), publicKey };
    const challenge = await createAttestationChallenge(h.db, clock, seller, id, input);
    return { ...capture, input, challenge, authorization: { challengeId: challenge.challengeId, signature: signed(challenge.payload) } };
  }
  async function upload(capture: Awaited<ReturnType<typeof recording>>, id = proofId) {
    const u = await initializeEvidenceUpload(h.db, clock, h.objectStore, seller, id, {
      contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE",
      captureSessionId: capture.captureSessionId, idempotencyKey: capture.captureSessionId,
    });
    await h.objectStore.put(u.objectKey, capture.bytes, "video/mp4");
    return commitEvidence(h.db, clock, h.objectStore, seller, id, u.evidenceId);
  }
  function submission(evidenceId: string, authorization: { challengeId: string; signature: string }) {
    return { statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: evidenceId, authorization };
  }

  it("signs the exact seller statement and video binding, freezes verification material, and preserves retry hashes", async () => {
    const capture = await recording();
    const body = JSON.parse(capture.challenge.payload);
    expect(body).toEqual({
      version: 1, method: "ANDROID_BIOMETRIC_STRONG", challengeId: capture.challenge.challengeId,
      nonce: expect.stringMatching(/^[a-f0-9]{64}$/), actorUserId: seller, proofId,
      captureSessionId: capture.captureSessionId, sha256: sha256Hex(capture.bytes),
      statement: SELLER_SHIPPING_STATEMENT, publicKeySha256: sha256Hex(Buffer.from(publicKey, "base64")),
      expiresAt: "2026-09-07T12:00:00.000Z",
    });
    expect(await createAttestationChallenge(h.db, clock, seller, proofId, capture.input)).toEqual(capture.challenge);
    const evidence = await upload(capture);
    const response = await request(h.app).post(`/proofs/${proofId}/attestations`).set(auth(seller))
      .send(submission(evidence.evidenceId, capture.authorization));
    expect(response.status).toBe(201);
    const attestation = response.body.attestation;
    expect(attestation.authorization).toMatchObject({
      method: "ANDROID_BIOMETRIC_STRONG", signatureVerification: "SERVER_VERIFIED",
      biometricMethodProvenance: "CLIENT_ASSERTED_NOT_INDEPENDENTLY_VERIFIED",
      payload: capture.challenge.payload, publicKey,
    });
    expect(attestation.digest.sha256).toBe(sha256Hex(canonicalize({
      proofId, attestedBy: seller, statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: evidence.evidenceId,
      createdAt: attestation.createdAt, authorization: attestation.authorization,
    })));
    const recovery = (await h.db.query<{ canonical_json: string }>("SELECT canonical_json FROM recovery_events WHERE proof_id=$1 ORDER BY sequence DESC LIMIT 1", [proofId])).rows[0];
    expect(JSON.parse(recovery.canonical_json).payload.rows.attestation_challenges).toEqual([
      expect.objectContaining({ id: capture.challenge.challengeId, payload: capture.challenge.payload,
        public_key_base64: publicKey, consumed_at: attestation.createdAt, attestation_id: attestation.attestationId }),
    ]);
    const final = await finalizeProof(h.db, clock, seller, proofId);
    const frozen = (final.manifest.manifest as any).attestations[0];
    expect(frozen.authorization).toEqual(attestation.authorization);
    expect(verify("sha256", Buffer.from(frozen.authorization.payload), keys.publicKey, Buffer.from(frozen.authorization.signature, "base64"))).toBe(true);
    // New ECDSA signatures over the exact consumed challenge recover the original row, even after expiry/finalization.
    now = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const retry = await commitAttestation(h.db, clock, seller, proofId, submission(evidence.evidenceId, {
      challengeId: capture.authorization.challengeId, signature: signed(capture.challenge.payload),
    }));
    expect(retry.attestation).toEqual(attestation);
    expect((await finalizeProof(h.db, clock, seller, proofId)).manifest.sha256).toBe(final.manifest.sha256);
    const canonical = await request(h.app).get(`/proofs/${proofId}`).set(auth(seller));
    expect(canonical.status).toBe(200);
    expect(canonical.body.attestations[0].authorization).toEqual(attestation.authorization);
    await expect(h.db.query("UPDATE attestations SET authorization_json='{}' WHERE id=$1", [attestation.attestationId])).rejects.toThrow("ATTESTATION_IMMUTABLE");
    await expect(h.db.query("UPDATE attestation_challenges SET payload='changed' WHERE id=$1", [capture.challenge.challengeId])).rejects.toThrow("ATTESTATION_CHALLENGE_IMMUTABLE");
  });

  it("rejects forged signatures, edited statement/hash payloads, and a signature made by another key", async () => {
    const capture = await recording();
    const evidence = await upload(capture);
    const foreign = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const invalid = [
      Buffer.alloc(70).toString("base64"),
      signed(capture.challenge.payload.replace(SELLER_SHIPPING_STATEMENT, "A different statement")),
      signed(capture.challenge.payload.replace(sha256Hex(capture.bytes), "0".repeat(64))),
      sign("sha256", Buffer.from(capture.challenge.payload), foreign.privateKey).toString("base64"),
    ];
    for (const signature of invalid) {
      await expect(commitAttestation(h.db, clock, seller, proofId, submission(evidence.evidenceId, {
        challengeId: capture.challenge.challengeId, signature,
      }))).rejects.toMatchObject({ code: "ATTESTATION_SIGNATURE_INVALID" });
    }
    expect((await h.db.query("SELECT * FROM attestations")).rows).toHaveLength(0);
    expect((await h.db.query("SELECT consumed_at FROM attestation_challenges")).rows[0].consumed_at).toBeNull();
  });

  it("rejects unrelated actors, Proofs, evidence, and capture sessions even when video bytes are identical", async () => {
    const first = await recording();
    const second = await recording("second-recording");
    const evidence = await upload(second);
    await expect(commitAttestation(h.db, clock, seller, proofId, submission(evidence.evidenceId, first.authorization)))
      .rejects.toMatchObject({ code: "ATTESTATION_EVIDENCE_MISMATCH" });
    await expect(createAttestationChallenge(h.db, clock, other, proofId, first.input)).rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED" });
    const otherProof = await proof();
    await expect(createAttestationChallenge(h.db, clock, seller, otherProof, first.input)).rejects.toMatchObject({ code: "CAPTURE_SESSION_NOT_FOUND" });
    const different = await recording("another-proof", otherProof);
    const differentEvidence = await upload(different, otherProof);
    await expect(commitAttestation(h.db, clock, seller, otherProof, submission(differentEvidence.evidenceId, first.authorization)))
      .rejects.toMatchObject({ code: "ATTESTATION_CHALLENGE_NOT_FOUND" });
    await expect(commitAttestation(h.db, clock, other, proofId, submission(evidence.evidenceId, first.authorization)))
      .rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED" });
    await expect(createAttestationChallenge(h.db, clock, seller, proofId, { ...first.input, sha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "ATTESTATION_CAPTURE_MISMATCH" });
  });

  it("requires a recorded native session and committed matching evidence before authorization can be recorded", async () => {
    const session = await createCaptureSession(h.db, clock, seller, proofId, { client: "NATIVE_CAMERA", idempotencyKey: "unfinished" });
    await expect(createAttestationChallenge(h.db, clock, seller, proofId, { captureSessionId: session.id, sha256: "0".repeat(64), publicKey }))
      .rejects.toMatchObject({ code: "ATTESTATION_CAPTURE_MISMATCH" });
    const capture = await recording();
    await expect(commitAttestation(h.db, clock, seller, proofId, { statement: "PACKED_DESCRIBED_ITEM", authorization: capture.authorization }))
      .rejects.toMatchObject({ code: "ATTESTATION_EVIDENCE_MISMATCH" });
    const u = await initializeEvidenceUpload(h.db, clock, h.objectStore, seller, proofId, {
      contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE", captureSessionId: capture.captureSessionId, idempotencyKey: "pending",
    });
    await expect(commitAttestation(h.db, clock, seller, proofId, submission(u.evidenceId, capture.authorization)))
      .rejects.toMatchObject({ code: "ATTESTATION_EVIDENCE_MISMATCH" });
  });

  it("requires another confirmation after expiry and does not consume failed or expired challenges", async () => {
    const capture = await recording();
    const evidence = await upload(capture);
    now = new Date(capture.challenge.expiresAt);
    await expect(commitAttestation(h.db, clock, seller, proofId, submission(evidence.evidenceId, capture.authorization)))
      .rejects.toMatchObject({ code: "ATTESTATION_CHALLENGE_EXPIRED" });
    const renewed = await createAttestationChallenge(h.db, clock, seller, proofId, capture.input);
    expect(renewed.challengeId).not.toBe(capture.challenge.challengeId);
    await commitAttestation(h.db, clock, seller, proofId, submission(evidence.evidenceId, { challengeId: renewed.challengeId, signature: signed(renewed.payload) }));
    expect((await h.db.query("SELECT consumed_at FROM attestation_challenges WHERE id=$1", [capture.challenge.challengeId])).rows[0].consumed_at).toBeNull();
  });

  it("rejects unknown biometric fields and malformed formats at the HTTP boundary before persisting them", async () => {
    const capture = await recording();
    const evidence = await upload(capture);
    for (const extra of [{ fingerprintImage: "raw-sample" }, { template: "raw-sample" }, { biometricData: "raw-sample" }]) {
      const challenge = await request(h.app).post(`/proofs/${proofId}/attestation-challenges`).set(auth(seller)).send({ ...capture.input, ...extra });
      expect(challenge.status).toBe(400);
      const commit = await request(h.app).post(`/proofs/${proofId}/attestations`).set(auth(seller))
        .send({ ...submission(evidence.evidenceId, capture.authorization), ...extra });
      expect(commit.status).toBe(400);
      const nested = await request(h.app).post(`/proofs/${proofId}/attestations`).set(auth(seller))
        .send(submission(evidence.evidenceId, { ...capture.authorization, ...extra }));
      expect(nested.status).toBe(400);
    }
    for (const bad of [null, [], { ...capture.input, publicKey: "raw-fingerprint" }, { ...capture.input, publicKey: publicKey + " " }]) {
      await expect(createAttestationChallenge(h.db, clock, seller, proofId, bad)).rejects.toMatchObject({ code: "INVALID_ATTESTATION" });
    }
    expect((await h.db.query("SELECT * FROM attestations")).rows).toHaveLength(0);
    expect(JSON.stringify((await h.db.query("SELECT * FROM attestation_challenges")).rows)).not.toContain("raw-sample");
  });

  it("keeps legacy attestation hashes and manifests unchanged and never relabels a legacy retry as biometric", async () => {
    const capture = await recording();
    const evidence = await upload(capture);
    const input = { statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: evidence.evidenceId };
    const legacy = await commitAttestation(h.db, clock, seller, proofId, input);
    expect(legacy.attestation).not.toHaveProperty("authorization");
    expect(legacy.attestation.digest.sha256).toBe(sha256Hex(canonicalize({ proofId, attestedBy: seller, ...input, createdAt: legacy.attestation.createdAt })));
    await expect(commitAttestation(h.db, clock, seller, proofId, submission(evidence.evidenceId, capture.authorization)))
      .rejects.toMatchObject({ code: "ATTESTATION_AUTHORIZATION_CONFLICT" });
    const final = await finalizeProof(h.db, clock, seller, proofId);
    expect((final.manifest.manifest as any).attestations[0]).not.toHaveProperty("authorization");
    expect((await finalizeProof(h.db, clock, seller, proofId)).manifest.sha256).toBe(final.manifest.sha256);
  });

  it("rolls back the attestation and audit if challenge consumption fails", async () => {
    const capture = await recording();
    const evidence = await upload(capture);
    const failing: Database = {
      query: h.db.query.bind(h.db),
      transaction: fn => h.db.transaction(tx => fn({
        transaction: tx.transaction.bind(tx),
        query: (sql, params) => {
          if (sql.startsWith("UPDATE attestation_challenges")) throw new Error("Simulated consumption failure");
          return tx.query(sql, params);
        },
      })),
    };
    await expect(commitAttestation(failing, clock, seller, proofId, submission(evidence.evidenceId, capture.authorization)))
      .rejects.toThrow("Simulated consumption failure");
    expect((await h.db.query("SELECT * FROM attestations")).rows).toHaveLength(0);
    expect((await h.db.query("SELECT * FROM audit_events WHERE event_type='ATTESTATION_COMMITTED'")).rows).toHaveLength(0);
    expect((await h.db.query("SELECT consumed_at FROM attestation_challenges")).rows[0].consumed_at).toBeNull();
    expect((await commitAttestation(h.db, clock, seller, proofId, submission(evidence.evidenceId, capture.authorization))).attestation.authorization).toBeDefined();
  });
});
