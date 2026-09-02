import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { BearerUserAdapter } from "../src/auth/adapter.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { DomainError, errorCodeFromSql } from "../src/domain/errors.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { listAuditEvents } from "../src/domain/audit.js";
import { hashCanonicalManifest } from "../src/domain/finalize.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import {
  shipmentEventContentSha256,
  shipmentEventIntegritySha256,
} from "../src/domain/shipment-event-hash.js";
import { recordShipmentEvent } from "../src/domain/shipment-events.js";
import { normalizeShipmentEventType } from "../src/domain/shipment-event-types.js";
import { importNormalizedTransaction } from "../src/domain/transaction-import.js";
import { createTransaction } from "../src/domain/transactions.js";
import { sha256Hex } from "../src/hash.js";
import { IntegrationAdapterRegistry } from "../src/integrations/registry.js";
import type { ShipmentObservationAdapter } from "../src/integrations/shipment-adapter.js";
import { DEMO_CARRIER_TIMELINE_TYPES } from "../src/integrations/demo-carrier.js";
import { auth, commitFulfillmentAndAttest, createHarness, login, type TestHarness } from "./helpers.js";

const SAMPLE_IMPORT = {
  provider: "demo-marketplace",
  externalTransactionId: "DM-SHIP-1001",
  transactionDate: "2026-08-20",
  itemTitle: "Vintage film camera",
  itemDescription: "Fully tested body with original strap",
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
    source: "MARKETPLACE_API",
    sourceRecordId: "demo-order-DM-SHIP-1001",
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
    { contentType: "video/mp4", idempotencyKey: `ship-${proofId}` },
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
  await commitFulfillmentAndAttest(harness, seller, proofId, {
    bytes: Buffer.from(`ship-evidence-${proofId}`),
    idempotencyKey: `ship-${proofId}`,
  });
  return request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));
}

async function importDemo(
  app: TestHarness["app"],
  seller: string,
  body: {
    transactionId?: string;
    externalTransactionId?: string;
    throughEventType?: string;
  },
) {
  return request(app)
    .post("/integrations/shipment-events/import")
    .set(auth(seller))
    .send({
      adapterKey: "demo-carrier",
      mode: "reference",
      ...body,
    });
}

describe("append-only shipment observations", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("records shipment events before and after core finalization without changing the manifest", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "ship-seller");
    const buyer = await login(harness.app, "ship-buyer");
    const imported = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE_IMPORT, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    const proofId = imported.proof!.proofId;
    const transactionId = imported.transaction.transactionId;

    const before = await importDemo(harness.app, seller, {
      transactionId,
      throughEventType: "CARRIER_ACCEPTED",
    });
    expect(before.status).toBe(201);
    expect(before.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "LABEL_CREATED",
      "CARRIER_ACCEPTED",
    ]);
    expect(before.body.events[0].source).toBe("SHIPPING_PROVIDER_API");
    expect(before.body.events[0].provider).toBe("demo-carrier");
    expect(before.body.events[0].proofId).toBe(proofId);

    const finalized = await finalizeWithBuyer(harness, seller, buyer, proofId);
    expect(finalized.status).toBe(200);
    const coreSha = finalized.body.manifest.sha256 as string;
    const coreJson = finalized.body.manifest.canonicalJson as string;
    expect(coreSha).toBe(hashCanonicalManifest(JSON.parse(coreJson)).sha256);
    expect(JSON.parse(coreJson).shipping.trackingNumber).toBe("1Z999AA10123456784");

    const after = await importDemo(harness.app, seller, {
      transactionId,
      throughEventType: "DELIVERED",
    });
    expect(after.status).toBe(201);
    expect(after.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      ...DEMO_CARRIER_TIMELINE_TYPES,
    ]);
    const delivered = after.body.events[after.body.events.length - 1];
    expect(delivered.eventType).toBe("DELIVERED");
    expect(delivered.coreManifestSha256).toBe(coreSha);
    expect(delivered.previousEventSha256).toBe(after.body.events[4].sha256);

    const manifest = await request(harness.app).get(`/proofs/${proofId}/manifest`).set(auth(seller));
    expect(manifest.status).toBe(200);
    expect(manifest.body.sha256).toBe(coreSha);

    const blockedShipping = await request(harness.app)
      .patch(`/transactions/${transactionId}/shipping`)
      .set(auth(seller))
      .send({ trackingNumber: "nope" });
    expect(blockedShipping.status).toBe(409);
    expect(blockedShipping.body.error.code).toBe("PROOF_ALREADY_FINALIZED");

    const blockedTxn = await request(harness.app)
      .patch(`/transactions/${transactionId}`)
      .set(auth(seller))
      .send({ itemTitle: "nope" });
    expect(blockedTxn.status).toBe(409);

    const proof = await request(harness.app).get(`/proofs/${proofId}`).set(auth(seller));
    expect(proof.body.status).toBe("FINALIZED");
    expect(proof.body.integrity.manifestSha256).toBe(coreSha);
    expect(proof.body.shipmentObservations.events).toHaveLength(6);
    expect(proof.body.chronology.some((entry: { eventType: string }) => entry.eventType === "PROOF_FINALIZED")).toBe(
      true,
    );
    expect(
      proof.body.chronology.some(
        (entry: { title: string }) => entry.title === "Core PackProof finalized",
      ),
    ).toBe(true);
    expect(proof.body.chronology.some((entry: { eventType: string }) => entry.eventType === "DELIVERED")).toBe(
      true,
    );

    const listed = await request(harness.app)
      .get(`/transactions/${transactionId}/shipment-events`)
      .set(auth(seller));
    expect(listed.body.events).toHaveLength(6);
    const chronology = await request(harness.app)
      .get(`/proofs/${proofId}/chronology`)
      .set(auth(seller));
    expect(chronology.body.chronology).toEqual(proof.body.chronology);
  });

  it("is idempotent for provider event ids and deterministic fingerprints", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "idem-seller");
    const imported = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE_IMPORT, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    const transactionId = imported.transaction.transactionId;
    const proofId = imported.proof!.proofId;

    const first = await importDemo(harness.app, seller, {
      transactionId,
      throughEventType: "LABEL_CREATED",
    });
    expect(first.status).toBe(201);
    const retry = await importDemo(harness.app, seller, {
      transactionId,
      throughEventType: "LABEL_CREATED",
    });
    expect(retry.status).toBe(200);
    expect(retry.body.events).toHaveLength(1);
    expect(retry.body.events[0].id).toBe(first.body.events[0].id);
    expect(retry.body.createdCount).toBe(0);

    const audits = await listAuditEvents(harness.db, proofId);
    expect(audits.filter((event) => event.eventType === "SHIPMENT_EVENT_RECORDED")).toHaveLength(1);

    const participant = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-events`)
      .set(auth(seller))
      .send({
        eventType: "DELIVERY_EXCEPTION",
        occurredAt: "2026-09-03T12:00:00.000Z",
        locationText: "Depot",
        eventData: { note: "weather delay" },
      });
    expect(participant.status).toBe(201);
    expect(participant.body.event.source).toBe("PARTICIPANT_SUPPLIED");
    expect(participant.body.event.provider).toBe("participant");
    const participantRetry = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-events`)
      .set(auth(seller))
      .send({
        eventType: "DELIVERY_EXCEPTION",
        occurredAt: "2026-09-03T12:00:00.000Z",
        locationText: "Depot",
        eventData: { note: "weather delay" },
      });
    expect(participantRetry.status).toBe(200);
    expect(participantRetry.body.event.id).toBe(participant.body.event.id);
    const auditsAfter = await listAuditEvents(harness.db, proofId);
    expect(
      auditsAfter.filter((event) => event.eventType === "SHIPMENT_EVENT_RECORDED"),
    ).toHaveLength(2);
  });

  it("fails closed on conflicting provider event identity and preserves immutability", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "conflict-seller");
    const other = await login(harness.app, "conflict-other");
    const first = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE_IMPORT, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    const second = await importNormalizedTransaction(
      harness.db,
      harness.clock,
      other,
      { ...SAMPLE_IMPORT, externalTransactionId: "DM-SHIP-1002" },
      { adapterKey: "demo-marketplace", createProof: true },
    );

    await recordShipmentEvent(harness.db, harness.clock, seller, {
      transactionId: first.transaction.transactionId,
      eventType: "IN_TRANSIT",
      occurredAt: "2026-09-01T10:00:00.000Z",
      source: "SHIPPING_PROVIDER_API",
      provider: "demo-carrier",
      sourceEventId: "shared-provider-id",
      authority: "INTEGRATION",
    });

    await expect(
      recordShipmentEvent(harness.db, harness.clock, other, {
        transactionId: second.transaction.transactionId,
        eventType: "IN_TRANSIT",
        occurredAt: "2026-09-01T10:00:00.000Z",
        source: "SHIPPING_PROVIDER_API",
        provider: "demo-carrier",
        sourceEventId: "shared-provider-id",
        authority: "INTEGRATION",
      }),
    ).rejects.toMatchObject({ code: "SHIPMENT_EVENT_CONFLICT" } satisfies Partial<DomainError>);

    await expect(
      recordShipmentEvent(harness.db, harness.clock, seller, {
        transactionId: first.transaction.transactionId,
        eventType: "DELIVERED",
        occurredAt: "2026-09-02T10:00:00.000Z",
        source: "SHIPPING_PROVIDER_API",
        provider: "demo-carrier",
        sourceEventId: "shared-provider-id",
        authority: "INTEGRATION",
      }),
    ).rejects.toMatchObject({ code: "SHIPMENT_EVENT_CONFLICT" } satisfies Partial<DomainError>);

    const listed = await request(harness.app)
      .get(`/proofs/${first.proof!.proofId}/shipment-events`)
      .set(auth(seller));
    const eventId = listed.body.events[0].id as string;
    const update = harness.db.query(`UPDATE shipment_events SET location_text = 'x' WHERE id = $1`, [
      eventId,
    ]);
    await expect(update).rejects.toSatisfy(
      (error: unknown) => errorCodeFromSql(error) === "SHIPMENT_EVENT_IMMUTABLE",
    );
    const remove = harness.db.query(`DELETE FROM shipment_events WHERE id = $1`, [eventId]);
    await expect(remove).rejects.toSatisfy(
      (error: unknown) => errorCodeFromSql(error) === "SHIPMENT_EVENT_IMMUTABLE",
    );
  });

  it("normalizes unknown carrier statuses, hashes deterministically, and keeps adapter events ordered", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "norm-seller");
    expect(normalizeShipmentEventType("ofd").eventType).toBe("OUT_FOR_DELIVERY");
    expect(normalizeShipmentEventType("UPS_ON_VEHICLE")).toEqual({
      eventType: "CARRIER_EVENT",
      carrierStatus: "UPS_ON_VEHICLE",
    });

    const created = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Manual camera",
      shipping: {
        carrier: "UPS",
        service: "Ground",
        trackingNumber: "1ZMANUAL",
        shipmentDate: "2026-08-21",
      },
    });
    expect(created.itemTitle).toBe("Manual camera");
    const proof = await createOrGetProof(harness.db, harness.clock, seller, created.transactionId);
    const unknown = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-events`)
      .set(auth(seller))
      .send({
        eventType: "UPS_ON_VEHICLE",
        occurredAt: "2026-09-01T11:00:00.000Z",
        locationText: "Hub",
      });
    expect(unknown.status).toBe(201);
    expect(unknown.body.event.eventType).toBe("CARRIER_EVENT");
    expect(unknown.body.event.eventData.carrierStatus).toBe("UPS_ON_VEHICLE");

    const content = {
      proofId: proof.proofId,
      transactionId: created.transactionId,
      shippingId: unknown.body.event.shippingId as string,
      eventType: "CARRIER_EVENT",
      occurredAt: unknown.body.event.occurredAt as string,
      carrier: null,
      locationText: "Hub",
      source: "PARTICIPANT_SUPPLIED",
      provider: "participant",
      sourceEventId: null,
      eventData: { carrierStatus: "UPS_ON_VEHICLE" },
      payloadSha256: null,
    };
    expect(shipmentEventContentSha256(content)).toBe(shipmentEventContentSha256(content));
    expect(unknown.body.event.contentSha256).toBe(shipmentEventContentSha256(content));
    expect(unknown.body.event.sha256).toBe(
      shipmentEventIntegritySha256({
        contentSha256: unknown.body.event.contentSha256,
        previousEventSha256: null,
        coreManifestSha256: null,
        proofId: proof.proofId,
      }),
    );

    const imported = await importNormalizedTransaction(
      harness.db,
      harness.clock,
      seller,
      { ...SAMPLE_IMPORT, externalTransactionId: "DM-SHIP-ADAPTER" },
      { adapterKey: "demo-marketplace", createProof: true },
    );
    const timeline = await importDemo(harness.app, seller, {
      transactionId: imported.transaction.transactionId,
    });
    expect(timeline.status).toBe(201);
    expect(timeline.body.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      ...DEMO_CARRIER_TIMELINE_TYPES,
    ]);
    expect(timeline.body.events[2].eventData.weightLb).toBe(3.8);
    expect(timeline.body.events[3].location).toBe("Columbus, OH");
    for (let index = 1; index < timeline.body.events.length; index += 1) {
      expect(timeline.body.events[index].previousEventSha256).toBe(timeline.body.events[index - 1].sha256);
    }

    const stillImported = await importNormalizedTransaction(
      harness.db,
      harness.clock,
      seller,
      { ...SAMPLE_IMPORT, externalTransactionId: "DM-SHIP-ADAPTER" },
      { adapterKey: "demo-marketplace" },
    );
    expect(stillImported.created).toBe(false);
    expect(stillImported.transaction.transactionId).toBe(imported.transaction.transactionId);
  });

  it("rejects carrier impersonation on the reference import route", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "trust-seller");
    const imported = await importNormalizedTransaction(harness.db, harness.clock, seller, SAMPLE_IMPORT, {
      adapterKey: "demo-marketplace",
      createProof: true,
    });
    const facts = await request(harness.app)
      .post("/integrations/shipment-events/import")
      .set(auth(seller))
      .send({
        adapterKey: "demo-carrier",
        mode: "reference",
        transactionId: imported.transaction.transactionId,
        trackingNumber: "1Z999AA10123456784",
        eventType: "DELIVERED",
      });
    expect(facts.status).toBe(400);
    expect(facts.body.error.code).toBe("INTEGRATION_INPUT_NOT_ALLOWED");

    const liveMode = await request(harness.app)
      .post("/integrations/shipment-events/import")
      .set(auth(seller))
      .send({
        adapterKey: "demo-carrier",
        mode: "live",
        transactionId: imported.transaction.transactionId,
      });
    expect(liveMode.status).toBe(403);
    expect(liveMode.body.error.code).toBe("INTEGRATION_TRUST_BOUNDARY");

    const trusted: ShipmentObservationAdapter = {
      adapterKey: "ups",
      kind: "trusted",
      fetchShipmentEvents: async () => {
        throw new Error("trusted adapter must not be invoked on the reference route");
      },
    };
    const app = createApp({
      db: harness.db,
      objectStore: harness.objectStore,
      clock: harness.clock,
      auth: new BearerUserAdapter(harness.db),
      publicBaseUrl: "http://127.0.0.1",
      devAuth: true,
      integrations: new IntegrationAdapterRegistry(new Map(), new Map([["ups", trusted]])),
    });
    const rejected = await request(app)
      .post("/integrations/shipment-events/import")
      .set(auth(seller))
      .send({
        adapterKey: "ups",
        mode: "reference",
        transactionId: imported.transaction.transactionId,
      });
    expect(rejected.status).toBe(403);
    expect(rejected.body.error.code).toBe("INTEGRATION_TRUST_BOUNDARY");

    const missingProof = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "No proof yet",
    });
    const tooEarly = await importDemo(harness.app, seller, {
      transactionId: missingProof.transactionId,
      throughEventType: "LABEL_CREATED",
    });
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.error.code).toBe("SHIPMENT_EVENT_PROOF_REQUIRED");
  });
});
