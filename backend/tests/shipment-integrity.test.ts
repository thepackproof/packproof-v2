import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { errorCodeFromSql } from "../src/domain/errors.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { hashCanonicalManifest } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import {
  getShipmentIntegrity,
  shipmentSupplementSha256,
} from "../src/domain/shipment-integrity.js";
import { recordShipmentEvent } from "../src/domain/shipment-events.js";
import { importNormalizedTransaction } from "../src/domain/transaction-import.js";
import { createTransaction } from "../src/domain/transactions.js";
import { sha256Hex } from "../src/hash.js";
import { SHIPMENT_SUPPLEMENT_SCHEMA } from "../src/domain/trust.js";
import type { ShipmentEventRow } from "../src/domain/types.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

const SAMPLE_IMPORT = {
  provider: "demo-marketplace",
  externalTransactionId: "DM-INTEG-1001",
  transactionDate: "2026-08-20",
  itemTitle: "Vintage film camera",
  itemDescription: "Fully tested body",
  quantity: 1,
  transactionValue: 250.5,
  currency: "USD",
  shipping: {
    carrier: "UPS",
    service: "Ground",
    trackingNumber: "1Z999AA10123456784",
    shipmentDate: "2026-08-21",
  },
  buyer: {
    externalId: "buyer_demo_1",
    displayName: "Alex Buyer",
    email: "alex.buyer@example.com",
  },
  provenance: {
    source: "MARKETPLACE_API" as const,
    sourceRecordId: "demo-order-DM-INTEG-1001",
    importedAt: "2026-08-31T15:00:00.000Z",
  },
};

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
    { contentType: "video/mp4", idempotencyKey: `integ-${proofId}` },
  );
  await harness.objectStore.put(upload.objectKey, bytes, "video/mp4");
  await commitEvidence(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    upload.evidenceId,
    sha256Hex(bytes),
  );
}

async function finalizeWithBuyer(
  harness: TestHarness,
  seller: string,
  buyer: string,
  proofId: string,
) {
  const invite = await createInvitation(harness.db, harness.clock, seller, proofId, {
    inviteeIdentifier: "buyer@example.com",
  });
  await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.token);
  await commitSellerEvidence(harness, seller, proofId, Buffer.from(`integ-evidence-${proofId}`));
  return request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));
}

async function importThrough(
  app: TestHarness["app"],
  seller: string,
  transactionId: string,
  throughEventType: string,
) {
  return request(app)
    .post("/integrations/shipment-events/import")
    .set(auth(seller))
    .send({
      adapterKey: "demo-carrier",
      mode: "reference",
      transactionId,
      throughEventType,
    });
}

async function loadEventRows(harness: TestHarness, proofId: string): Promise<ShipmentEventRow[]> {
  const result = await harness.db.query<ShipmentEventRow>(
    `SELECT * FROM shipment_events WHERE proof_id = $1 ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return result.rows;
}

async function withDisabledTriggers(
  harness: TestHarness,
  table: string,
  fn: () => Promise<void>,
): Promise<void> {
  await harness.db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await fn();
  } finally {
    await harness.db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}

describe("shipment integrity supplement", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("links pre-finalization shipment events to the frozen core without rewriting them", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "integ-seller");
    const buyer = await login(harness.app, "integ-buyer");
    const imported = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE_IMPORT, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    const proofId = imported.proof!.proofId;
    const transactionId = imported.transaction.transactionId;

    const beforeFinalize = await importThrough(harness.app, seller, transactionId, "CARRIER_ACCEPTED");
    expect(beforeFinalize.status).toBe(201);
    expect(beforeFinalize.body.events).toHaveLength(2);
    const snapshot = await loadEventRows(harness, proofId);
    expect(snapshot.every((row) => row.core_manifest_sha256 == null)).toBe(true);

    const unfinalized = await request(harness.app)
      .get(`/proofs/${proofId}/shipment-integrity`)
      .set(auth(seller));
    expect(unfinalized.status).toBe(200);
    expect(unfinalized.body.status).toBe("CORE_NOT_FINALIZED");
    expect(unfinalized.body.supplement).toBeNull();
    expect(unfinalized.body.shipmentSupplementSha256).toBeNull();
    expect(unfinalized.body.verification.linkedToFinalizedProof).toBe(false);
    expect(unfinalized.body.verification.valid).toBe(false);

    const finalized = await finalizeWithBuyer(harness, seller, buyer, proofId);
    expect(finalized.status).toBe(200);
    const coreSha = finalized.body.manifest.sha256 as string;
    const coreJson = finalized.body.manifest.canonicalJson as string;
    expect(hashCanonicalManifest(JSON.parse(coreJson)).sha256).toBe(coreSha);

    const linked = await request(harness.app)
      .get(`/proofs/${proofId}/shipment-integrity`)
      .set(auth(seller));
    expect(linked.status).toBe(200);
    expect(linked.body.status).toBe("LINKED");
    expect(linked.body.eventCount).toBe(2);
    expect(linked.body.coreManifestSha256).toBe(coreSha);
    expect(linked.body.firstEventSha256).toBe(snapshot[0].sha256);
    expect(linked.body.latestEventSha256).toBe(snapshot[1].sha256);
    expect(linked.body.verification).toMatchObject({
      coreManifestValid: true,
      eventContentHashesValid: true,
      eventChainValid: true,
      supplementValid: true,
      linkedToFinalizedProof: true,
      valid: true,
    });
    expect(linked.body.supplement.schema).toBe(SHIPMENT_SUPPLEMENT_SCHEMA);
    expect(linked.body.supplement.events).toHaveLength(2);
    expect(linked.body.supplement.coreManifestSha256).toBe(coreSha);
    expect(linked.body.shipmentSupplementSha256).toBe(
      shipmentSupplementSha256(linked.body.supplement),
    );

    const afterLink = await loadEventRows(harness, proofId);
    expect(afterLink.map((row) => row.id)).toEqual(snapshot.map((row) => row.id));
    expect(afterLink.map((row) => row.sha256)).toEqual(snapshot.map((row) => row.sha256));
    expect(afterLink.map((row) => row.content_sha256)).toEqual(snapshot.map((row) => row.content_sha256));
    expect(afterLink.map((row) => row.previous_event_sha256)).toEqual(
      snapshot.map((row) => row.previous_event_sha256),
    );
    expect(afterLink.every((row) => row.core_manifest_sha256 == null)).toBe(true);

    const manifest = await request(harness.app).get(`/proofs/${proofId}/manifest`).set(auth(seller));
    expect(manifest.body.sha256).toBe(coreSha);
    expect(manifest.body.canonicalJson).toBe(coreJson);

    const again = await getShipmentIntegrity(harness.db, proofId);
    expect(again.shipmentSupplementSha256).toBe(linked.body.shipmentSupplementSha256);

    const later = await recordShipmentEvent(harness.db, harness.clock, seller, {
      transactionId,
      eventType: "IN_TRANSIT",
      occurredAt: "2026-09-01T14:40:00.000Z",
      source: "SHIPPING_PROVIDER_API",
      provider: "demo-carrier",
      sourceEventId: "demo-carrier-post-finalize-transit",
      authority: "INTEGRATION",
    });
    expect(later.created).toBe(true);
    const afterLater = await request(harness.app)
      .get(`/proofs/${proofId}/shipment-integrity`)
      .set(auth(seller));
    expect(afterLater.body.eventCount).toBe(3);
    expect(afterLater.body.coreManifestSha256).toBe(coreSha);
    expect(afterLater.body.shipmentSupplementSha256).not.toBe(linked.body.shipmentSupplementSha256);
    expect(afterLater.body.verification.valid).toBe(true);
    const firstTwo = await loadEventRows(harness, proofId);
    expect(firstTwo[0].sha256).toBe(snapshot[0].sha256);
    expect(firstTwo[1].sha256).toBe(snapshot[1].sha256);
    expect(firstTwo[0].core_manifest_sha256).toBeNull();
    expect(firstTwo[1].core_manifest_sha256).toBeNull();
    expect(firstTwo[2].core_manifest_sha256).toBe(coreSha);
    const laterManifest = await request(harness.app).get(`/proofs/${proofId}/manifest`).set(auth(seller));
    expect(laterManifest.body.sha256).toBe(coreSha);
    expect(laterManifest.body.canonicalJson).toBe(coreJson);
  });

  it("orders supplement events by append time, not occurredAt chronology", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "order-seller");
    const buyer = await login(harness.app, "order-buyer");
    const created = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Order camera",
      shipping: {
        carrier: "UPS",
        service: "Ground",
        trackingNumber: "1ZORDER",
        shipmentDate: "2026-08-21",
      },
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, created.transactionId);
    await recordShipmentEvent(harness.db, harness.clock, seller, {
      transactionId: created.transactionId,
      eventType: "LABEL_CREATED",
      occurredAt: "2026-09-02T16:00:00.000Z",
      source: "SHIPPING_PROVIDER_API",
      provider: "demo-carrier",
      sourceEventId: "order-label",
      authority: "INTEGRATION",
    });
    await recordShipmentEvent(harness.db, harness.clock, seller, {
      transactionId: created.transactionId,
      eventType: "CARRIER_ACCEPTED",
      occurredAt: "2026-09-01T08:00:00.000Z",
      source: "SHIPPING_PROVIDER_API",
      provider: "demo-carrier",
      sourceEventId: "order-accepted",
      authority: "INTEGRATION",
    });
    await finalizeWithBuyer(harness, seller, buyer, proof.proofId);
    await recordShipmentEvent(harness.db, harness.clock, seller, {
      transactionId: created.transactionId,
      eventType: "IN_TRANSIT",
      occurredAt: "2026-08-22T09:00:00.000Z",
      source: "SHIPPING_PROVIDER_API",
      provider: "demo-carrier",
      sourceEventId: "order-transit",
      authority: "INTEGRATION",
    });

    const integrity = await request(harness.app)
      .get(`/proofs/${proof.proofId}/shipment-integrity`)
      .set(auth(seller));
    const appendRows = await loadEventRows(harness, proof.proofId);
    expect(integrity.body.supplement.events.map((event: { shipmentEventId: string }) => event.shipmentEventId)).toEqual(
      appendRows.map((row) => row.id),
    );
    expect(appendRows.map((row) => row.event_type)).toEqual([
      "LABEL_CREATED",
      "CARRIER_ACCEPTED",
      "IN_TRANSIT",
    ]);
    const proofView = await request(harness.app).get(`/proofs/${proof.proofId}`).set(auth(seller));
    const shipmentChronology = proofView.body.chronology.filter(
      (entry: { category: string }) => entry.category === "SHIPMENT",
    );
    expect(shipmentChronology[0].eventType).toBe("IN_TRANSIT");
    expect(integrity.body.supplement.events[0].shipmentEventId).not.toBe(shipmentChronology[0].relatedEntityId);
    expect(integrity.body.verification.valid).toBe(true);
  });

  it("supports zero-event supplements, no-shipment state, and unfinalized Proofs", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "zero-seller");
    const buyer = await login(harness.app, "zero-buyer");

    const withShipping = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Zero events",
      shipping: {
        carrier: "UPS",
        service: "Ground",
        trackingNumber: "1ZZERO",
        shipmentDate: "2026-08-21",
      },
    });
    const shippedProof = await createOrGetProof(
      harness.db,
      harness.clock,
      seller,
      withShipping.transactionId,
    );
    await finalizeWithBuyer(harness, seller, buyer, shippedProof.proofId);
    const empty = await request(harness.app)
      .get(`/proofs/${shippedProof.proofId}/shipment-integrity`)
      .set(auth(seller));
    expect(empty.body.status).toBe("LINKED");
    expect(empty.body.eventCount).toBe(0);
    expect(empty.body.firstEventSha256).toBeNull();
    expect(empty.body.latestEventSha256).toBeNull();
    expect(empty.body.supplement.events).toEqual([]);
    expect(empty.body.verification.valid).toBe(true);
    expect(empty.body.shipmentSupplementSha256).toMatch(/^[a-f0-9]{64}$/);

    const noShip = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "No shipping",
    });
    const noShipProof = await createOrGetProof(harness.db, harness.clock, seller, noShip.transactionId);
    const noShipBuyer = await login(harness.app, "zero-buyer-2");
    await finalizeWithBuyer(harness, seller, noShipBuyer, noShipProof.proofId);
    const missing = await request(harness.app)
      .get(`/proofs/${noShipProof.proofId}/shipment-integrity`)
      .set(auth(seller));
    expect(missing.body.status).toBe("NO_SHIPMENT");
    expect(missing.body.supplement).toBeNull();
    expect(missing.body.verification.linkedToFinalizedProof).toBe(false);
    expect(missing.body.verification.valid).toBe(false);

    const openTxn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Open",
      shipping: {
        carrier: "UPS",
        service: null,
        trackingNumber: "1ZOPEN",
        shipmentDate: null,
      },
    });
    const openProof = await createOrGetProof(harness.db, harness.clock, seller, openTxn.transactionId);
    const open = await request(harness.app)
      .get(`/proofs/${openProof.proofId}/shipment-integrity`)
      .set(auth(seller));
    expect(open.body.status).toBe("CORE_NOT_FINALIZED");
    expect(open.body.verification.linkedToFinalizedProof).toBe(false);

    const outsider = await login(harness.app, "zero-outsider");
    const denied = await request(harness.app)
      .get(`/proofs/${shippedProof.proofId}/shipment-integrity`)
      .set(auth(outsider));
    expect(denied.status).toBe(403);

    const missingProof = await request(harness.app)
      .get("/proofs/proof_does_not_exist/shipment-integrity")
      .set(auth(seller));
    expect(missingProof.status).toBe(403);

    const unauthenticated = await request(harness.app).get(
      `/proofs/${shippedProof.proofId}/shipment-integrity`,
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("detects core, event, chain, and association corruption without weakening production immutability", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "tamper-seller");
    const buyer = await login(harness.app, "tamper-buyer");
    const imported = await importNormalizedTransaction(
      harness.db,
      harness.clock,
      seller,
      { ...SAMPLE_IMPORT, externalTransactionId: "DM-INTEG-TAMPER" },
      { adapterKey: "demo-marketplace", createProof: true },
    );
    const proofId = imported.proof!.proofId;
    await importThrough(harness.app, seller, imported.transaction.transactionId, "CARRIER_ACCEPTED");
    await finalizeWithBuyer(harness, seller, buyer, proofId);
    const healthy = await getShipmentIntegrity(harness.db, proofId);
    expect(healthy.verification.valid).toBe(true);
    const events = await loadEventRows(harness, proofId);
    const originalManifest = await harness.db.query<{ canonical_json: string; sha256: string }>(
      `SELECT canonical_json, sha256 FROM final_manifests WHERE proof_id = $1`,
      [proofId],
    );
    const originalJson = originalManifest.rows[0].canonical_json;
    const originalSha = originalManifest.rows[0].sha256;

    await withDisabledTriggers(harness, "final_manifests", async () => {
      await harness.db.query(
        `UPDATE final_manifests SET canonical_json = '{"tampered":true}' WHERE proof_id = $1`,
        [proofId],
      );
    });
    const coreTampered = await getShipmentIntegrity(harness.db, proofId);
    expect(coreTampered.verification.coreManifestValid).toBe(false);
    expect(coreTampered.verification.valid).toBe(false);
    await withDisabledTriggers(harness, "final_manifests", async () => {
      await harness.db.query(
        `UPDATE final_manifests SET canonical_json = $2, sha256 = $3 WHERE proof_id = $1`,
        [proofId, originalJson, originalSha],
      );
    });
    expect((await getShipmentIntegrity(harness.db, proofId)).verification.valid).toBe(true);

    await withDisabledTriggers(harness, "shipment_events", async () => {
      await harness.db.query(`UPDATE shipment_events SET location_text = 'tampered' WHERE id = $1`, [
        events[0].id,
      ]);
    });
    const contentTampered = await getShipmentIntegrity(harness.db, proofId);
    expect(contentTampered.verification.eventContentHashesValid).toBe(false);
    expect(contentTampered.verification.valid).toBe(false);
    await withDisabledTriggers(harness, "shipment_events", async () => {
      await harness.db.query(`UPDATE shipment_events SET location_text = $2 WHERE id = $1`, [
        events[0].id,
        events[0].location_text,
      ]);
    });
    expect((await getShipmentIntegrity(harness.db, proofId)).verification.valid).toBe(true);

    await withDisabledTriggers(harness, "shipment_events", async () => {
      await harness.db.query(
        `UPDATE shipment_events SET previous_event_sha256 = $2 WHERE id = $1`,
        [events[1].id, "aa".repeat(32)],
      );
    });
    const chainTampered = await getShipmentIntegrity(harness.db, proofId);
    expect(chainTampered.verification.eventChainValid).toBe(false);
    expect(chainTampered.verification.valid).toBe(false);
    await withDisabledTriggers(harness, "shipment_events", async () => {
      await harness.db.query(
        `UPDATE shipment_events SET previous_event_sha256 = $2 WHERE id = $1`,
        [events[1].id, events[1].previous_event_sha256],
      );
    });
    expect((await getShipmentIntegrity(harness.db, proofId)).verification.valid).toBe(true);

    await withDisabledTriggers(harness, "shipment_events", async () => {
      await harness.db.query(`UPDATE shipment_events SET sha256 = $2 WHERE id = $1`, [
        events[0].id,
        "bb".repeat(32),
      ]);
    });
    const digestTampered = await getShipmentIntegrity(harness.db, proofId);
    expect(digestTampered.verification.eventChainValid).toBe(false);
    expect(digestTampered.verification.valid).toBe(false);
    await withDisabledTriggers(harness, "shipment_events", async () => {
      await harness.db.query(`UPDATE shipment_events SET sha256 = $2 WHERE id = $1`, [
        events[0].id,
        events[0].sha256,
      ]);
    });
    expect((await getShipmentIntegrity(harness.db, proofId)).verification.valid).toBe(true);

    const other = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Other",
      shipping: {
        carrier: "UPS",
        service: null,
        trackingNumber: "1ZOTHER",
        shipmentDate: null,
      },
    });
    const otherProof = await createOrGetProof(harness.db, harness.clock, seller, other.transactionId);
    await withDisabledTriggers(harness, "shipment_events", async () => {
      await harness.db.query(`UPDATE shipment_events SET proof_id = $2 WHERE id = $1`, [
        events[1].id,
        otherProof.proofId,
      ]);
    });
    const associated = await getShipmentIntegrity(harness.db, proofId);
    expect(associated.verification.supplementValid).toBe(false);
    expect(associated.verification.valid).toBe(false);

    await expect(
      harness.db.query(`UPDATE shipment_events SET location_text = 'nope' WHERE id = $1`, [
        events[0].id,
      ]),
    ).rejects.toSatisfy((error: unknown) => errorCodeFromSql(error) === "SHIPMENT_EVENT_IMMUTABLE");
    await expect(
      harness.db.query(`UPDATE final_manifests SET canonical_json = '{}' WHERE proof_id = $1`, [proofId]),
    ).rejects.toSatisfy((error: unknown) => errorCodeFromSql(error) === "MANIFEST_IMMUTABLE");
  });
});
