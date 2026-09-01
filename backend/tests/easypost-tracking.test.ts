import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { acceptInvitation, createInvitation } from "../src/domain/invitations.js";
import { getShipmentIntegrity } from "../src/domain/shipment-integrity.js";
import { createTransaction } from "../src/domain/transactions.js";
import { sha256Hex } from "../src/hash.js";
import { createEasyPostTrackerClient, type EasyPostHttp } from "../src/integrations/easypost/client.js";
import { parseEasyPostCredentials } from "../src/integrations/easypost/credentials.js";
import {
  easypostWebhookSignatureHeader,
  verifyEasyPostWebhookSignature,
} from "../src/integrations/easypost/hmac.js";
import { mapEasyPostStatus, normalizeEasyPostTracker } from "../src/integrations/easypost/normalize.js";
import { EASYPOST_TRACKER_ADAPTER_KEY } from "../src/integrations/easypost/adapter.js";
import { secretIdFromReference } from "../src/integrations/secrets-manager-credential-store.js";
import { createDefaultIntegrationRegistry } from "../src/integrations/registry.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";
import {
  DELIVERED,
  FAILURE,
  IN_TRANSIT,
  OUT_FOR_DELIVERY,
  PRE_TRANSIT,
  RETURN_TO_SENDER,
  TRACKERS_BY_CODE,
  UNKNOWN,
  trackingDetail,
  trackerFixture,
} from "./fixtures/easypost.js";

const FIXTURE_KEY = "EZTK_packproof_fixture";
const FIXTURE_WEBHOOK = "easypost-fixture-webhook-secret";
const CREDENTIAL_REFERENCE = "memory:easypost-fixture";

function mockHttp(options: {
  byCode?: Record<string, unknown>;
  byId?: Record<string, unknown>;
  statusForCreate?: number;
  statusForGet?: number;
  createJson?: unknown;
  getJson?: unknown;
  createCalls?: string[];
  getCalls?: string[];
}): EasyPostHttp {
  const createCalls = options.createCalls ?? [];
  const getCalls = options.getCalls ?? [];
  return {
    async request(input) {
      if (input.method === "POST" && input.path === "/trackers") {
        const body = input.body as { tracker?: { tracking_code?: string } };
        const code = body.tracker?.tracking_code ?? "";
        createCalls.push(code);
        if (options.statusForCreate) {
          return { status: options.statusForCreate, json: options.createJson ?? { error: { code: "UNAUTHORIZED" } } };
        }
        const tracker = options.byCode?.[code] ?? TRACKERS_BY_CODE[code];
        if (!tracker) {
          return { status: 404, json: { error: { code: "NOT_FOUND", message: "not found" } } };
        }
        return { status: 201, json: tracker };
      }
      if (input.method === "GET" && input.path.startsWith("/trackers/")) {
        const id = decodeURIComponent(input.path.replace("/trackers/", ""));
        getCalls.push(id);
        if (options.statusForGet) {
          return { status: options.statusForGet, json: options.getJson ?? {} };
        }
        const tracker = options.byId?.[id] ?? Object.values(options.byCode ?? TRACKERS_BY_CODE).find(
          (row) => typeof row === "object" && row != null && (row as { id?: string }).id === id,
        );
        if (!tracker) {
          return { status: 404, json: { error: { code: "NOT_FOUND" } } };
        }
        return { status: 200, json: tracker };
      }
      return { status: 404, json: {} };
    },
  };
}

async function easypostHarness(http: EasyPostHttp = mockHttp({})) {
  const integrations = createDefaultIntegrationRegistry(systemClock, {
    easypostClient: createEasyPostTrackerClient(http),
  });
  return createHarness(systemClock, { integrations });
}

async function seedEasyPost(
  harness: TestHarness,
  seller: string,
  trackingNumber: string,
  carrier = "UPS",
) {
  const created = await createTransaction(harness.db, harness.clock, seller, {
    itemTitle: "EasyPost camera",
    shipping: {
      carrier,
      service: "Ground",
      trackingNumber,
      shipmentDate: "2026-08-21",
    },
  });
  await createOrGetProof(harness.db, harness.clock, seller, created.transactionId);
  harness.credentialStore.put({
    adapterKey: EASYPOST_TRACKER_ADAPTER_KEY,
    credentialReference: CREDENTIAL_REFERENCE,
    material: { apiKey: FIXTURE_KEY, webhookSecret: FIXTURE_WEBHOOK, mode: "test" },
  });
  const connected = await request(harness.app)
    .post("/dev/integrations/easypost/connect")
    .set(auth(seller))
    .send({ transactionId: created.transactionId, credentialReference: CREDENTIAL_REFERENCE });
  expect(connected.status).toBe(201);
  return created.transactionId;
}

async function finalizeProof(harness: TestHarness, seller: string, buyer: string, proofId: string) {
  const invite = await createInvitation(harness.db, harness.clock, seller, proofId, {
    inviteeIdentifier: "buyer@example.com",
  });
  await acceptInvitation(harness.db, harness.clock, buyer, invite.invitation.token);
  const upload = await initializeEvidenceUpload(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    { contentType: "video/mp4", idempotencyKey: `ep-${proofId}` },
  );
  const bytes = Buffer.from(`easypost-evidence-${proofId}`);
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
  return request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));
}

describe("EasyPost tracker normalization", () => {
  it("maps official statuses and scan details without treating EasyPost as the carrier", () => {
    expect(mapEasyPostStatus("pre_transit")).toBe("LABEL_CREATED");
    expect(mapEasyPostStatus("in_transit")).toBe("IN_TRANSIT");
    expect(mapEasyPostStatus("out_for_delivery")).toBe("OUT_FOR_DELIVERY");
    expect(mapEasyPostStatus("delivered")).toBe("DELIVERED");
    expect(mapEasyPostStatus("return_to_sender")).toBe("RETURN_TO_SENDER");
    expect(mapEasyPostStatus("failure")).toBe("DELIVERY_EXCEPTION");
    expect(mapEasyPostStatus("unknown")).toBe("CARRIER_EVENT");
    expect(mapEasyPostStatus("in_transit", "arrived_at_facility")).toBe("ARRIVED_AT_FACILITY");

    const pre = normalizeEasyPostTracker(PRE_TRANSIT);
    expect(pre.provider).toBe("easypost");
    expect(pre.carrier).toBe("UPS");
    expect(pre.observations[0]?.eventType).toBe("LABEL_CREATED");
    expect(pre.observations[0]?.eventData?.scanSource).toBe("UPS");
    expect(pre.observations[0]?.location).toBeNull();

    const transit = normalizeEasyPostTracker(IN_TRANSIT);
    expect(transit.observations.length).toBe(4);
    expect(transit.observations.map((row) => row.eventType)).toEqual([
      "LABEL_CREATED",
      "DEPARTED_FACILITY",
      "ARRIVED_AT_FACILITY",
      "IN_TRANSIT",
    ]);
    expect(transit.observations[2]?.location).toContain("INDIANAPOLIS");

    const delivered = normalizeEasyPostTracker(DELIVERED);
    expect(delivered.observations.some((row) => row.eventType === "DELIVERED")).toBe(true);
    const weight = delivered.observations.find((row) => row.eventType === "WEIGHT_RECORDED");
    expect(weight?.eventData).toMatchObject({ value: 12.5, unit: "oz", reportedBy: "carrier", via: "easypost" });

    expect(normalizeEasyPostTracker(OUT_FOR_DELIVERY).observations.at(-1)?.eventType).toBe(
      "OUT_FOR_DELIVERY",
    );
    expect(normalizeEasyPostTracker(RETURN_TO_SENDER).observations[0]?.eventType).toBe("RETURN_TO_SENDER");
    expect(normalizeEasyPostTracker(FAILURE).observations[0]?.eventType).toBe("DELIVERY_EXCEPTION");
    expect(normalizeEasyPostTracker(UNKNOWN).observations[0]?.eventType).toBe("CARRIER_EVENT");

    const missingOptional = trackerFixture({
      trackingCode: "EZ2000000002",
      status: "in_transit",
      carrier: "",
      carrierDetail: false,
      details: [
        trackingDetail({
          status: "in_transit",
          datetime: "2026-08-22T16:40:00Z",
          message: "In Transit",
          city: null,
          state: null,
          zip: null,
          country: null,
        }),
      ],
    });
    const sparse = normalizeEasyPostTracker(missingOptional);
    expect(sparse.carrier).toBeNull();
    expect(sparse.observations[0]?.location).toBeNull();
  });

  it("verifies EasyPost HMAC-SHA256 including the official integer-weight body correction", () => {
    const body = Buffer.from('{"id":"evt_weight","weight":12}');
    const header = easypostWebhookSignatureHeader("fixture-secret", body);
    expect(header.startsWith("hmac-sha256-hex=")).toBe(true);
    expect(() =>
      verifyEasyPostWebhookSignature({
        headers: { "X-Hmac-Signature": header },
        rawBody: body,
        webhookSecret: "fixture-secret",
      }),
    ).not.toThrow();
    expect(() =>
      verifyEasyPostWebhookSignature({
        headers: {},
        rawBody: body,
        webhookSecret: "fixture-secret",
      }),
    ).toThrowError(/signature verification failed/);
  });

  it("dedupes identical scans and keeps late older scans as distinct observations", () => {
    const duplicate = trackerFixture({
      trackingCode: "EZ2000000002",
      status: "in_transit",
      details: [
        trackingDetail({ status: "in_transit", datetime: "2026-08-22T16:40:00Z", message: "In Transit" }),
        trackingDetail({ status: "in_transit", datetime: "2026-08-22T16:40:00Z", message: "In Transit" }),
        trackingDetail({
          status: "pre_transit",
          datetime: "2026-08-21T01:00:00Z",
          message: "Late older scan",
          city: null,
          state: null,
          zip: null,
          country: null,
        }),
      ],
    });
    const snapshot = normalizeEasyPostTracker(duplicate);
    expect(snapshot.observations).toHaveLength(2);
    expect(snapshot.observations[1]?.occurredAt).toBe("2026-08-21T01:00:00.000Z");
  });

  it("rejects production EasyPost keys while the connection is in test mode", () => {
    expect(() =>
      parseEasyPostCredentials({
        adapterKey: EASYPOST_TRACKER_ADAPTER_KEY,
        credentialReference: CREDENTIAL_REFERENCE,
        material: { apiKey: "EZAK_not_a_real_key", mode: "test" },
      }),
    ).toThrowError(/rejected the integration credentials/);
  });
});

describe("EasyPost trusted runtime", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("imports EasyPost test-mode history with trusted provenance and keeps secrets out of responses", async () => {
    const createCalls: string[] = [];
    const getCalls: string[] = [];
    harness = await easypostHarness(mockHttp({ createCalls, getCalls }));
    const seller = await login(harness.app, "ep-seller");
    const transactionId = await seedEasyPost(harness, seller, "EZ2000000002");

    const clientKey = await request(harness.app)
      .post("/dev/integrations/easypost/connect")
      .set(auth(seller))
      .send({
        transactionId,
        credentialReference: CREDENTIAL_REFERENCE,
        apiKey: FIXTURE_KEY,
      });
    expect(clientKey.status).toBe(403);

    const reference = await request(harness.app)
      .post("/integrations/shipment-events/import")
      .set(auth(seller))
      .send({ adapterKey: EASYPOST_TRACKER_ADAPTER_KEY, mode: "reference", transactionId });
    expect(reference.status).toBe(403);

    const forged = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-events`)
      .set(auth(seller))
      .send({
        eventType: "DELIVERED",
        occurredAt: "2026-08-23T16:16:00.000Z",
        source: "SHIPPING_PROVIDER_API",
        provider: "easypost",
      });
    expect(forged.status).toBe(201);
    expect(forged.body.event.provider).toBe("participant");
    expect(forged.body.event.source).toBe("PARTICIPANT_SUPPLIED");

    const synced = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(synced.status).toBe(201);
    expect(synced.body.provider).toBe("easypost");
    expect(synced.body.events.every((event: { source: string }) => event.source === "SHIPPING_PROVIDER_API")).toBe(
      true,
    );
    expect(synced.body.events.every((event: { provider: string }) => event.provider === "easypost")).toBe(true);
    expect(synced.body.events.some((event: { carrier: string }) => event.carrier === "UPS")).toBe(true);
    expect(JSON.stringify(synced.body)).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify(synced.body)).not.toContain(FIXTURE_WEBHOOK);
    expect(JSON.stringify(synced.body)).not.toContain("credential_reference");
    expect(createCalls).toEqual(["EZ2000000002"]);

    const again = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.createdCount).toBe(0);
    expect(getCalls[0]).toMatch(/^trk_/);

    const proof = await request(harness.app)
      .get(`/proofs/${synced.body.proofId}`)
      .set(auth(seller));
    expect(proof.body.shipmentSync.adapterKey).toBe(EASYPOST_TRACKER_ADAPTER_KEY);
    expect(JSON.stringify(proof.body)).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify(proof.body)).not.toContain(FIXTURE_WEBHOOK);
    expect(JSON.stringify(proof.body)).not.toContain("credentialReference");
    expect(JSON.stringify(proof.body)).not.toContain(CREDENTIAL_REFERENCE);
    expect(proof.body.chronology.some((entry: { provider?: string }) => entry.provider === "easypost")).toBe(true);
  });

  it("appends EasyPost delivery after finalization without changing the core manifest", async () => {
    harness = await easypostHarness(
      mockHttp({
        byCode: { EZ4000000004: DELIVERED },
      }),
    );
    const seller = await login(harness.app, "ep-final-seller");
    const buyer = await login(harness.app, "ep-final-buyer");
    const created = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Final camera",
      shipping: { carrier: "UPS", service: null, trackingNumber: "EZ4000000004", shipmentDate: null },
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, created.transactionId);
    harness.credentialStore.put({
      adapterKey: EASYPOST_TRACKER_ADAPTER_KEY,
      credentialReference: CREDENTIAL_REFERENCE,
      material: { apiKey: FIXTURE_KEY, webhookSecret: FIXTURE_WEBHOOK, mode: "test" },
    });
    await request(harness.app)
      .post("/dev/integrations/easypost/connect")
      .set(auth(seller))
      .send({ transactionId: created.transactionId, credentialReference: CREDENTIAL_REFERENCE });

    const before = await request(harness.app)
      .post(`/transactions/${created.transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(before.status).toBe(201);
    const beforeIntegrity = await getShipmentIntegrity(harness.db, proof.proofId);
    expect(beforeIntegrity.verification.valid).toBe(false);

    const finalized = await finalizeProof(harness, seller, buyer, proof.proofId);
    const coreSha = finalized.body.manifest.sha256 as string;
    const afterFinalize = await getShipmentIntegrity(harness.db, proof.proofId);
    expect(afterFinalize.verification.valid).toBe(true);
    const supplementBefore = afterFinalize.shipmentSupplementSha256;

    const webhookBody = {
      id: "evt_easypost_delivered",
      object: "Event",
      description: "tracker.updated",
      mode: "test",
      result: DELIVERED,
    };
    const raw = JSON.stringify(webhookBody);
    const ingested = await request(harness.app)
      .post(`/integrations/webhooks/${EASYPOST_TRACKER_ADAPTER_KEY}`)
      .set("X-Hmac-Signature", easypostWebhookSignatureHeader(FIXTURE_WEBHOOK, Buffer.from(raw)))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(ingested.status).toBe(200);
    expect(ingested.body.createdCount).toBe(0);

    const replay = await request(harness.app)
      .post(`/integrations/webhooks/${EASYPOST_TRACKER_ADAPTER_KEY}`)
      .set("X-Hmac-Signature", easypostWebhookSignatureHeader(FIXTURE_WEBHOOK, Buffer.from(raw)))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.createdCount).toBe(0);

    const extra = {
      ...DELIVERED,
      tracking_details: [
        ...(DELIVERED.tracking_details ?? []),
        trackingDetail({
          status: "delivered",
          datetime: "2026-08-23T18:00:00Z",
          message: "Left at door",
        }),
      ],
    };
    const extraRaw = JSON.stringify({
      id: "evt_easypost_extra",
      object: "Event",
      mode: "test",
      result: extra,
    });
    const extraIngest = await request(harness.app)
      .post(`/integrations/webhooks/${EASYPOST_TRACKER_ADAPTER_KEY}`)
      .set("X-Hmac-Signature", easypostWebhookSignatureHeader(FIXTURE_WEBHOOK, Buffer.from(extraRaw)))
      .set("Content-Type", "application/json")
      .send(extraRaw);
    expect(extraIngest.status).toBe(201);
    expect(extraIngest.body.createdCount).toBeGreaterThan(0);
    expect(extraIngest.body.events.some((event: { eventType: string; source: string }) => event.eventType === "DELIVERED" && event.source === "SHIPPING_PROVIDER_API")).toBe(
      true,
    );

    const manifest = await request(harness.app).get(`/proofs/${proof.proofId}/manifest`).set(auth(seller));
    expect(manifest.body.sha256).toBe(coreSha);
    const integrity = await getShipmentIntegrity(harness.db, proof.proofId);
    expect(integrity.verification.valid).toBe(true);
    expect(integrity.coreManifestSha256).toBe(coreSha);
    expect(integrity.shipmentSupplementSha256).not.toBe(supplementBefore);
    expect(JSON.stringify(integrity)).not.toContain(FIXTURE_KEY);
  });

  it("rejects invalid, unsigned, and cross-connection EasyPost webhooks", async () => {
    harness = await easypostHarness();
    const seller = await login(harness.app, "ep-wh-seller");
    await seedEasyPost(harness, seller, "EZ4000000004");
    const raw = JSON.stringify({
      id: "evt_bad",
      mode: "test",
      result: DELIVERED,
    });
    const invalid = await request(harness.app)
      .post(`/integrations/webhooks/${EASYPOST_TRACKER_ADAPTER_KEY}`)
      .set("X-Hmac-Signature", easypostWebhookSignatureHeader("wrong-secret", Buffer.from(raw)))
      .set("Content-Type", "application/json")
      .send(raw);
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(JSON.stringify(invalid.body)).not.toContain("wrong-secret");

    const unsigned = await request(harness.app)
      .post(`/integrations/webhooks/${EASYPOST_TRACKER_ADAPTER_KEY}`)
      .set("Content-Type", "application/json")
      .send(raw);
    expect(unsigned.status).toBe(401);

    const unbound = JSON.stringify({
      id: "evt_unbound",
      mode: "test",
      result: { ...DELIVERED, tracking_code: "NOT-BOUND" },
    });
    const closed = await request(harness.app)
      .post(`/integrations/webhooks/${EASYPOST_TRACKER_ADAPTER_KEY}`)
      .set("X-Hmac-Signature", easypostWebhookSignatureHeader(FIXTURE_WEBHOOK, Buffer.from(unbound)))
      .set("Content-Type", "application/json")
      .send(unbound);
    expect(closed.status).toBe(404);

    const ignoredRaw = JSON.stringify({
      id: "evt_batch_ignored",
      object: "Event",
      mode: "test",
      result: { object: "Batch", id: "batch_1" },
    });
    const ignored = await request(harness.app)
      .post(`/integrations/webhooks/${EASYPOST_TRACKER_ADAPTER_KEY}`)
      .set("X-Hmac-Signature", easypostWebhookSignatureHeader(FIXTURE_WEBHOOK, Buffer.from(ignoredRaw)))
      .set("Content-Type", "application/json")
      .send(ignoredRaw);
    expect(ignored.status).toBe(200);
    expect(ignored.body.createdCount).toBe(0);
  });

  it("maps EasyPost transport failures without leaking bodies", async () => {
    harness = await easypostHarness(mockHttp({ statusForCreate: 401 }));
    const seller = await login(harness.app, "ep-err-seller");
    const transactionId = await seedEasyPost(harness, seller, "EZ2000000002");
    const authFailed = await request(harness.app)
      .post(`/transactions/${transactionId}/shipment-sync`)
      .set(auth(seller))
      .send({});
    expect(authFailed.status).toBe(502);
    expect(authFailed.body.error.code).toBe("PROVIDER_AUTH_FAILED");
    expect(authFailed.body.error.retryable).toBe(false);
    expect(JSON.stringify(authFailed.body)).not.toContain(FIXTURE_KEY);

    await harness.close();
    harness = await easypostHarness(mockHttp({ statusForCreate: 429 }));
    const seller2 = await login(harness.app, "ep-err-seller2");
    const txn2 = await seedEasyPost(harness, seller2, "EZ2000000002");
    const limited = await request(harness.app).post(`/transactions/${txn2}/shipment-sync`).set(auth(seller2)).send({});
    expect(limited.body.error.code).toBe("PROVIDER_RATE_LIMITED");
    expect(limited.body.error.retryable).toBe(true);

    await harness.close();
    harness = await easypostHarness(mockHttp({ statusForCreate: 503 }));
    const seller3 = await login(harness.app, "ep-err-seller3");
    const txn3 = await seedEasyPost(harness, seller3, "EZ2000000002");
    const down = await request(harness.app).post(`/transactions/${txn3}/shipment-sync`).set(auth(seller3)).send({});
    expect(down.body.error.code).toBe("PROVIDER_TEMPORARILY_UNAVAILABLE");
    expect(down.body.error.retryable).toBe(true);

    await harness.close();
    harness = await easypostHarness(mockHttp({ statusForCreate: 200, createJson: { nope: true } }));
    const seller4 = await login(harness.app, "ep-err-seller4");
    const txn4 = await seedEasyPost(harness, seller4, "EZ2000000002");
    const invalid = await request(harness.app).post(`/transactions/${txn4}/shipment-sync`).set(auth(seller4)).send({});
    expect(invalid.body.error.code).toBe("PROVIDER_RESPONSE_INVALID");

    await harness.close();
    harness = await easypostHarness(mockHttp({}));
    const seller5 = await login(harness.app, "ep-err-seller5");
    const txn5 = await seedEasyPost(harness, seller5, "UNKNOWN-TRACK");
    const missing = await request(harness.app).post(`/transactions/${txn5}/shipment-sync`).set(auth(seller5)).send({});
    expect(missing.body.error.code).toBe("TRACKING_NOT_FOUND");

    await harness.close();
    harness = await easypostHarness(
      mockHttp({
        byCode: { EZ2000000002: { ...IN_TRANSIT, mode: "production" } },
      }),
    );
    const seller6 = await login(harness.app, "ep-err-seller6");
    const txn6 = await seedEasyPost(harness, seller6, "EZ2000000002");
    const prod = await request(harness.app).post(`/transactions/${txn6}/shipment-sync`).set(auth(seller6)).send({});
    expect(prod.body.error.code).toBe("PROVIDER_RESPONSE_INVALID");
  });
});

describe("staging IAM and EasyPost secrets", () => {
  it("grants GetSecretValue to the API task role, not the execution role, on the staging namespace", async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const staging = await readFile(path.join(root, "infra/staging.yaml"), "utf8");
    const api = await readFile(path.join(root, "infra/api-service.yaml"), "utf8");
    const deploy = await readFile(path.join(root, "infra/deploy.ps1"), "utf8");
    const dockerfile = await readFile(path.join(root, "backend/Dockerfile"), "utf8");

    const taskRole = staging.split("TaskRole:")[1]?.split("InfrastructureRole:")[0] ?? "";
    const executionRole = staging.split("TaskExecutionRole:")[1]?.split("TaskRole:")[0] ?? "";
    expect(taskRole).toMatch(/secretsmanager:GetSecretValue/);
    expect(taskRole).toMatch(/secretsmanager:CreateSecret/);
    expect(taskRole).toMatch(/secretsmanager:PutSecretValue/);
    expect(taskRole).toMatch(/secretsmanager:DeleteSecret/);
    expect(taskRole).toMatch(/packproof\/staging\/integrations\/\*/);
    expect(taskRole).not.toMatch(/packproof\/production/);
    expect(taskRole).not.toMatch(/Resource: "\*"/);
    expect(executionRole).toMatch(/Database\.MasterUserSecret\.SecretArn/);
    expect(executionRole).not.toMatch(/packproof\/staging\/integrations/);
    expect(executionRole).not.toMatch(/secretsmanager:CreateSecret/);

    expect(api).toMatch(/TaskRoleArn: !Ref TaskRoleArn/);
    expect(api).toMatch(/ExecutionRoleArn: !Ref TaskExecutionRoleArn/);
    expect(api).toMatch(/PACKPROOF_CREDENTIAL_STORE/);
    expect(api).toMatch(/secrets-manager/);
    expect(api).toMatch(/PACKPROOF_RELEASE_SHA/);
    expect(api).toMatch(/PACKPROOF_ENVIRONMENT/);
    expect(deploy).toMatch(/PACKPROOF_CREDENTIAL_STORE/);
    expect(deploy).toMatch(/secrets-manager/);
    expect(deploy).toMatch(/PACKPROOF_RELEASE_SHA/);
    expect(deploy).toMatch(/PACKPROOF_ENVIRONMENT/);
    expect(deploy).toMatch(/force-new-deployment/);
    expect(deploy).toMatch(/runningNewImage/);
    expect(deploy).toMatch(/ecs describe-tasks --cluster \$Outputs\.ClusterName --tasks \$arns/);
    expect(deploy).toMatch(/--task-role-arn/);
    expect(deploy).toMatch(/\[switch\]\$EnableEbay/);
    expect(deploy).toMatch(/PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE/);
    expect(deploy).not.toMatch(/PACKPROOF_EBAY_CLIENT_SECRET/);
    expect(dockerfile).toMatch(/public\.ecr\.aws\/docker\/library\/node:22-alpine/);
    expect(dockerfile).not.toMatch(/^FROM node:/m);
    expect(deploy).not.toMatch(/EZTK/);
    expect(deploy).not.toMatch(/EZAK/);
    expect(deploy).not.toMatch(/webhookSecret/);
    expect(api).not.toMatch(/EZTK/);
    expect(api).not.toMatch(/EZAK/);
    expect(api).not.toMatch(/webhookSecret/);
    expect(api).not.toMatch(/apiKey:/);
    expect(staging).not.toMatch(/EZTK/);
    expect(staging).not.toMatch(/EZAK/);
    expect(secretIdFromReference("packproof/staging/integrations/easypost")).toBe(
      "packproof/staging/integrations/easypost",
    );

    const webClient = await readFile(path.join(root, "web/src/api/client.ts"), "utf8");
    const mobileApi = await readFile(path.join(root, "mobile/src/v2-api.ts"), "utf8");
    expect(webClient).not.toMatch(/api\.easypost\.com/);
    expect(mobileApi).not.toMatch(/api\.easypost\.com/);
    const backendPkg = JSON.parse(await readFile(path.join(root, "backend/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(backendPkg.dependencies?.["@easypost/api"]).toBeUndefined();
  });
});

const liveEasyPost =
  process.env.PACKPROOF_EASYPOST_INTEGRATION === "1" && Boolean(process.env.PACKPROOF_EASYPOST_TEST_API_KEY);

describe.skipIf(!liveEasyPost)("EasyPost live TEST MODE (opt-in)", () => {
  it("creates a Tracker for an official test tracking code", async () => {
    const client = createEasyPostTrackerClient();
    const tracker = await client.createTracker({
      trackingCode: "EZ2000000002",
      carrier: "UPS",
      apiKey: process.env.PACKPROOF_EASYPOST_TEST_API_KEY ?? "",
    });
    expect(tracker.mode).toBe("test");
    expect(tracker.tracking_code).toBe("EZ2000000002");
    expect(tracker.object).toBe("Tracker");
  });
});
