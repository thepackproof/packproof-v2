import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { canonicalize } from "../src/canonical.js";
import { commitAttestation } from "../src/domain/attestations.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { DomainError, errorCodeFromSql } from "../src/domain/errors.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import {
  bindProofExternalReference,
  findProofExternalReference,
  findProofIdByExternalReference,
} from "../src/domain/external-references.js";
import { finalizeProof } from "../src/domain/finalize.js";
import { sha256Hex } from "../src/hash.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { createTransaction, updateTransaction } from "../src/domain/transactions.js";
import {
  CANONICAL_PROOF_SCHEMA,
  PACKPROOF_TRANSACTION_TENANT,
  PROOF_SUMMARY_SCHEMA,
  TRUST_KIND,
} from "../src/domain/trust.js";
import { auth, createHarness, createUser, login, type TestHarness } from "./helpers.js";

async function readyProof(harness: TestHarness, seller: string, buyer: string) {
  const txn = await createTransaction(harness.db, harness.clock, seller, {
    externalReference: `ext-${seller}`,
    itemTitle: "Canonical camera",
    shipping: { carrier: "UPS", trackingNumber: "1ZCANON" },
  });
  const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
  const invite = await createInvitation(
    harness.db,
    harness.clock,
    seller,
    proof.proofId,
    { inviteeUserId: buyer },
  );
  await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.token);
  return { txn, proofId: proof.proofId };
}

async function commitSellerEvidence(
  harness: TestHarness,
  seller: string,
  proofId: string,
  bytes: Buffer,
) {
  const upload = await initializeEvidenceUpload(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    { contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE", idempotencyKey: `canon-${proofId}` },
  );
  await harness.objectStore.put(upload.objectKey, bytes, "video/mp4");
  return commitEvidence(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    upload.evidenceId,
    sha256Hex(bytes),
  );
}

describe("canonical Proof contract", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("lets an authorized participant retrieve the canonical Proof and fails closed otherwise", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "canon-seller");
    const buyer = await login(harness.app, "canon-buyer");
    const stranger = await login(harness.app, "canon-stranger");
    const ready = await readyProof(harness, seller, buyer);

    const unauthenticated = await request(harness.app).get(`/proofs/${ready.proofId}`);
    expect(unauthenticated.status).toBe(401);

    const missing = await request(harness.app)
      .get("/proofs/proof_does_not_exist")
      .set(auth(stranger));
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe("PARTICIPANT_NOT_AUTHORIZED");

    const denied = await request(harness.app)
      .get(`/proofs/${ready.proofId}`)
      .set(auth(stranger));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PARTICIPANT_NOT_AUTHORIZED");

    const allowed = await request(harness.app).get(`/proofs/${ready.proofId}`).set(auth(seller));
    expect(allowed.status).toBe(200);
    expect(allowed.body.schema).toBe(CANONICAL_PROOF_SCHEMA);
    expect(allowed.body.proofId).toBe(ready.proofId);
    expect(allowed.body.identity.proofId).toBe(ready.proofId);
    expect(allowed.body.participants.map((row: { role: string }) => row.role)).toEqual([
      "BUYER",
      "SELLER",
    ]);
    expect(allowed.body.invitations[0].token).toBeUndefined();
  });

  it("returns only authorized Proof summaries from GET /me/proofs", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "summary-seller");
    const buyer = await login(harness.app, "summary-buyer");
    const stranger = await login(harness.app, "summary-stranger");
    const ready = await readyProof(harness, seller, buyer);

    const sellerList = await request(harness.app).get("/me/proofs").set(auth(seller));
    const buyerList = await request(harness.app).get("/me/proofs").set(auth(buyer));
    const strangerList = await request(harness.app).get("/me/proofs").set(auth(stranger));

    expect(sellerList.body.proofs).toHaveLength(1);
    expect(sellerList.body.proofs[0].schema).toBe(PROOF_SUMMARY_SCHEMA);
    expect(sellerList.body.proofs[0].proofId).toBe(ready.proofId);
    expect(buyerList.body.proofs).toHaveLength(1);
    expect(buyerList.body.proofs[0].proofId).toBe(ready.proofId);
    expect(strangerList.body.proofs).toEqual([]);
    expect(JSON.stringify(sellerList.body)).not.toMatch(/objectKey|attestation|FACT/i);
  });

  it("keeps committed evidence immutable through the canonical boundary and preserves the digest", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "digest-seller");
    const buyer = await login(harness.app, "digest-buyer");
    const ready = await readyProof(harness, seller, buyer);
    const bytes = Buffer.from("canonical-evidence-bytes");
    const expected = sha256Hex(bytes);
    const committed = await commitSellerEvidence(harness, seller, ready.proofId, bytes);
    expect(committed.sha256).toBe(expected);

    const again = await commitEvidence(
      harness.db,
      harness.clock,
      harness.objectStore,
      seller,
      ready.proofId,
      committed.evidenceId,
      "0".repeat(64),
    );
    expect(again.sha256).toBe(expected);

    const mutation = harness.db.query(`UPDATE evidence SET sha256 = $2 WHERE id = $1`, [
      committed.evidenceId,
      "f".repeat(64),
    ]);
    await expect(mutation).rejects.toSatisfy((error: unknown) => {
      return errorCodeFromSql(error) === "EVIDENCE_ALREADY_COMMITTED";
    });

    const patched = await request(harness.app)
      .patch(`/proofs/${ready.proofId}/evidence/${committed.evidenceId}`)
      .set(auth(seller))
      .send({ sha256: "f".repeat(64) });
    expect(patched.status).toBeGreaterThanOrEqual(400);

    const proof = await request(harness.app).get(`/proofs/${ready.proofId}`).set(auth(seller));
    const roundTrip = JSON.parse(JSON.stringify(proof.body)) as typeof proof.body;
    expect(roundTrip.evidence[0].sha256).toBe(expected);
    expect(roundTrip.evidence[0].digest.sha256).toBe(expected);
    expect(roundTrip.integrity.evidence[0].sha256).toBe(expected);
    expect(sha256Hex(canonicalize(roundTrip.integrity.evidence[0]))).toBe(
      sha256Hex(canonicalize(proof.body.integrity.evidence[0])),
    );
  });

  it("keeps attestations distinguishable from PackProof facts and preserves external provenance", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "trust-seller");
    const buyer = await login(harness.app, "trust-buyer");
    const stranger = await login(harness.app, "trust-stranger");
    const ready = await readyProof(harness, seller, buyer);
    const committed = await commitSellerEvidence(
      harness,
      seller,
      ready.proofId,
      Buffer.from("attestation-evidence"),
    );

    const denied = await request(harness.app)
      .post(`/proofs/${ready.proofId}/attestations`)
      .set(auth(stranger))
      .send({ statement: "PACKED_DESCRIBED_ITEM" });
    expect(denied.status).toBe(403);

    const first = await request(harness.app)
      .post(`/proofs/${ready.proofId}/attestations`)
      .set(auth(seller))
      .send({
        statement: "PACKED_DESCRIBED_ITEM",
        relatedEvidenceId: committed.evidenceId,
      });
    const second = await request(harness.app)
      .post(`/proofs/${ready.proofId}/attestations`)
      .set(auth(seller))
      .send({
        statement: "PACKED_DESCRIBED_ITEM",
        relatedEvidenceId: committed.evidenceId,
      });
    expect(first.status).toBe(201);
    expect(second.body.attestation.attestationId).toBe(first.body.attestation.attestationId);
    expect(first.body.attestation.kind).toBe(TRUST_KIND.ATTESTATION);

    const proof = await request(harness.app).get(`/proofs/${ready.proofId}`).set(auth(buyer));
    expect(proof.body.attestations).toHaveLength(1);
    expect(proof.body.attestations[0].kind).toBe(TRUST_KIND.ATTESTATION);
    expect(proof.body.attestations[0].statement).toBe("PACKED_DESCRIBED_ITEM");
    expect(proof.body.facts.every((fact: { kind: string }) => fact.kind === TRUST_KIND.FACT)).toBe(
      true,
    );
    expect(proof.body.facts.map((fact: { name: string }) => fact.name)).not.toContain(
      "PACKED_DESCRIBED_ITEM",
    );
    expect(
      proof.body.external.records.every(
        (record: { kind: string; verifiedByPackProof: boolean }) =>
          record.kind === TRUST_KIND.EXTERNAL && record.verifiedByPackProof === false,
      ),
    ).toBe(true);
    expect(
      proof.body.external.records.some(
        (record: { field: string; value: unknown }) =>
          record.field === "transaction.itemTitle" && record.value === "Canonical camera",
      ),
    ).toBe(true);
    expect(
      proof.body.external.records.some(
        (record: { field: string; value: unknown }) =>
          record.field === "shipping.trackingNumber" && record.value === "1ZCANON",
      ),
    ).toBe(true);
    expect(proof.body.external.references[0].tenantKey).toBe("packproof:transaction");
    expect(proof.body.events.map((event: { eventType: string }) => event.eventType)).toEqual(
      expect.arrayContaining([
        "PROOF_CREATED",
        "PARTICIPANT_INVITED",
        "PARTICIPANT_JOINED",
        "EVIDENCE_COMMITTED",
        "ATTESTATION_COMMITTED",
      ]),
    );
  });

  it("cannot bind the same tenant external transaction to two Proofs", async () => {
    harness = await createHarness();
    const seller = await createUser(harness);
    const firstTxn = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "order-a",
    });
    const secondTxn = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "order-b",
    });
    const first = await createOrGetProof(harness.db, harness.clock, seller, firstTxn.transactionId);
    const second = await createOrGetProof(
      harness.db,
      harness.clock,
      seller,
      secondTxn.transactionId,
    );

    const bound = await bindProofExternalReference(harness.db, harness.clock, seller, {
      proofId: first.proofId,
      tenantKey: "marketplace:example",
      externalTransactionId: "ORDER-99",
      source: "INTEGRATION",
    });
    const again = await bindProofExternalReference(harness.db, harness.clock, seller, {
      proofId: first.proofId,
      tenantKey: "marketplace:example",
      externalTransactionId: "ORDER-99",
      source: "INTEGRATION",
    });
    expect(again.referenceId).toBe(bound.referenceId);
    expect(await findProofIdByExternalReference(harness.db, "marketplace:example", "ORDER-99")).toBe(
      first.proofId,
    );

    await expect(
      bindProofExternalReference(harness.db, harness.clock, seller, {
        proofId: second.proofId,
        tenantKey: "marketplace:example",
        externalTransactionId: "ORDER-99",
        source: "INTEGRATION",
      }),
    ).rejects.toMatchObject({
      code: "EXTERNAL_REFERENCE_CONFLICT",
    } satisfies Partial<DomainError>);

    const otherMarket = await bindProofExternalReference(harness.db, harness.clock, seller, {
      proofId: second.proofId,
      tenantKey: "marketplace:other",
      externalTransactionId: "ORDER-99",
      source: "INTEGRATION",
    });
    expect(otherMarket.proofId).toBe(second.proofId);

    const sqlDuplicate = harness.db.query(
      `INSERT INTO proof_external_references (
         id, proof_id, tenant_key, external_transaction_id, source, provenance, created_at
       ) VALUES ($1, $2, $3, $4, 'INTEGRATION', '{}'::jsonb, $5)`,
      [
        "xref_duplicate",
        second.proofId,
        "marketplace:example",
        "ORDER-99",
        harness.clock.now().toISOString(),
      ],
    );
    await expect(sqlDuplicate).rejects.toSatisfy((error: unknown) => isUniqueViolation(error));
  });

  it("treats an established external binding as immutable identity, not transaction metadata", async () => {
    harness = await createHarness();
    const seller = await createUser(harness);
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      externalReference: "ORD-IDENTITY-1",
      itemTitle: "Identity item",
    });
    const created = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    const original = await findProofExternalReference(
      harness.db,
      created.proofId,
      PACKPROOF_TRANSACTION_TENANT,
    );
    expect(original?.externalTransactionId).toBe("ORD-IDENTITY-1");

    await updateTransaction(harness.db, harness.clock, seller, txn.transactionId, {
      externalReference: "ORD-IDENTITY-2",
      itemTitle: "Renamed item",
    });
    const afterUpdate = await createOrGetProof(
      harness.db,
      harness.clock,
      seller,
      txn.transactionId,
    );
    expect(afterUpdate.proofId).toBe(created.proofId);
    expect(afterUpdate.transaction.externalReference).toBe("ORD-IDENTITY-2");
    expect(afterUpdate.external.references).toHaveLength(1);
    expect(afterUpdate.external.references[0]).toMatchObject({
      tenantKey: PACKPROOF_TRANSACTION_TENANT,
      externalTransactionId: "ORD-IDENTITY-1",
    });
    expect(
      await findProofIdByExternalReference(
        harness.db,
        PACKPROOF_TRANSACTION_TENANT,
        "ORD-IDENTITY-1",
      ),
    ).toBe(created.proofId);
    expect(
      await findProofIdByExternalReference(
        harness.db,
        PACKPROOF_TRANSACTION_TENANT,
        "ORD-IDENTITY-2",
      ),
    ).toBeNull();

    await expect(
      bindProofExternalReference(harness.db, harness.clock, seller, {
        proofId: created.proofId,
        tenantKey: PACKPROOF_TRANSACTION_TENANT,
        externalTransactionId: "ORD-IDENTITY-2",
        source: "PARTICIPANT_SUPPLIED",
      }),
    ).rejects.toMatchObject({
      code: "EXTERNAL_REFERENCE_ALREADY_BOUND",
    } satisfies Partial<DomainError>);

    const lateTxn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "No identity yet",
    });
    const lateProof = await createOrGetProof(
      harness.db,
      harness.clock,
      seller,
      lateTxn.transactionId,
    );
    expect(lateProof.external.references).toEqual([]);
    await updateTransaction(harness.db, harness.clock, seller, lateTxn.transactionId, {
      externalReference: "ORD-LATE-1",
    });
    const established = await createOrGetProof(
      harness.db,
      harness.clock,
      seller,
      lateTxn.transactionId,
    );
    expect(established.external.references).toHaveLength(1);
    expect(established.external.references[0].externalTransactionId).toBe("ORD-LATE-1");

    const sqlSecondIdentity = harness.db.query(
      `INSERT INTO proof_external_references (
         id, proof_id, tenant_key, external_transaction_id, source, provenance, created_at
       ) VALUES ($1, $2, $3, $4, 'PARTICIPANT_SUPPLIED', '{}'::jsonb, $5)`,
      [
        "xref_second_identity",
        created.proofId,
        PACKPROOF_TRANSACTION_TENANT,
        "ORD-IDENTITY-2",
        harness.clock.now().toISOString(),
      ],
    );
    await expect(sqlSecondIdentity).rejects.toSatisfy((error: unknown) => isUniqueViolation(error));
  });

  it("preserves the existing finalize lifecycle on the canonical Proof", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "life-seller");
    const buyer = await login(harness.app, "life-buyer");
    const ready = await readyProof(harness, seller, buyer);
    await commitSellerEvidence(harness, seller, ready.proofId, Buffer.from("finalize-canonical"));

    await commitAttestation(harness.db, harness.clock, seller, ready.proofId, {
      statement: "PACKED_DESCRIBED_ITEM",
    });

    const first = await finalizeProof(harness.db, harness.clock, seller, ready.proofId);
    const second = await finalizeProof(harness.db, harness.clock, seller, ready.proofId);
    expect(second.manifest.sha256).toBe(first.manifest.sha256);
    expect(first.proof.status).toBe("FINALIZED");
    expect(first.proof.schema).toBe(CANONICAL_PROOF_SCHEMA);
    expect(first.proof.facts.some((fact) => fact.name === "PROOF_FINALIZED")).toBe(true);

    const after = await request(harness.app)
      .post(`/proofs/${ready.proofId}/attestations`)
      .set(auth(seller))
      .send({ statement: "RECEIVED_PACKAGE" });
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe("PROOF_ALREADY_FINALIZED");
  });
});

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === "23505" ||
    /unique|duplicate/i.test(candidate.message ?? "")
  );
}
