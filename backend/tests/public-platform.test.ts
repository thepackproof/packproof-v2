import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHarness, createUser, auth, type TestHarness } from "./helpers.js";
import { createServerApp } from "../src/server-app.js";
import { BearerUserAdapter } from "../src/auth/adapter.js";
import { API_SCOPES, consumeApiRate, createTenant, issueApiKey } from "../src/platform/tenants.js";
import {
  createWebhook,
  dispatchWebhooks,
  publicAddress,
  signWebhook,
  verifyWebhook,
  type WebhookConfig,
} from "../src/platform/webhooks.js";
import { sha256Hex } from "../src/hash.js";
import { previewOrderIntake } from "../src/intake/order-intake.js";
import { readFile } from "node:fs/promises";

describe("public partner platform", () => {
  let h: TestHarness;
  let app: ReturnType<typeof createServerApp>;
  const config: WebhookConfig = {
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    allowedHosts: ["hooks.example.com"],
  };
  let tick = new Date("2026-09-05T12:00:00Z");
  const clock = { now: () => new Date(tick) };
  beforeAll(async () => {
    h = await createHarness(clock);
    app = createServerApp({
      ...h,
      auth: new BearerUserAdapter(h.db),
      publicBaseUrl: "http://127.0.0.1",
      devAuth: true,
      webhookConfig: config,
    });
  });
  afterAll(async () => h.close());
  async function tenant(user?: string) {
    const owner = user ?? (await createUser(h));
    const t = (await createTenant(h.db, clock, owner, {
      name: `tenant-${Math.random()}`,
      environment: "sandbox",
    })) as { id: string };
    const key = await issueApiKey(h.db, clock, owner, t.id, {
      name: "test",
      scopes: API_SCOPES,
    });
    return { owner, id: t.id, key: key.token, keyId: key.id };
  }
  const order = {
    externalId: "ORDER-123",
    transaction: {
      itemTitle: "Trading card",
      quantity: 1,
      transactionValue: 3000,
      currency: "USD",
    },
  };
  async function create(key: string, idempotency = "create-1") {
    return request(app)
      .post("/v1/proofs")
      .set(auth(key))
      .set("Idempotency-Key", idempotency)
      .send(order);
  }
  it("isolates tenant orders, enforces scopes, and preserves first-party authorization", async () => {
    const a = await tenant(),
      b = await tenant(a.owner);
    const first = await create(a.key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await create(b.key);
    expect(second.status).toBe(201);
    expect(first.body.proof.proofId).not.toBe(second.body.proof.proofId);
    const id = first.body.proof.proofId;
    expect((await request(app).get(`/v1/proofs/${id}`).set(auth(b.key))).status).toBe(404);
    expect((await request(app).get(`/v1/proofs/${id}`).set(auth(a.owner))).status).toBe(401);
    expect((await request(app).get(`/proofs/${id}`).set(auth(a.key))).status).toBe(401);
    expect((await request(app).get(`/proofs/${id}`).set(auth(a.owner))).status).toBe(200);
    const readonly = await issueApiKey(h.db, clock, a.owner, a.id, {
      name: "reader",
      scopes: ["proofs:read"],
    });
    expect((await create(readonly.token)).status).toBe(403);
    const leak = await h.db.query("SELECT * FROM api_keys WHERE id=$1", [a.keyId]);
    expect(JSON.stringify(leak.rows)).not.toContain(a.key);
  });
  it("makes concurrent retries atomic and rejects changed payloads or reused order identities", async () => {
    const t = await tenant();
    const [a, b] = await Promise.all([create(t.key), create(t.key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body).toEqual(b.body);
    expect((await create(t.key, "different-key")).body).toEqual(a.body);
    const changed = await request(app)
      .post("/v1/proofs")
      .set(auth(t.key))
      .set("Idempotency-Key", "create-1")
      .send({ ...order, transaction: { itemTitle: "Different" } });
    expect(changed.status).toBe(409);
    const rebound = await request(app)
      .post("/v1/proofs")
      .set(auth(t.key))
      .set("Idempotency-Key", "other")
      .send({ ...order, transaction: { itemTitle: "Different" } });
    expect(rebound.body.error.code).toBe("EXTERNAL_ID_CONFLICT");
    const noKey = await request(app).post("/v1/proofs").set(auth(t.key)).send(order);
    expect(noKey.status).toBe(400);
  });
  it("runs capture, independent hash verification, attestation, finalization, events and signed delivery over one Proof", async () => {
    const t = await tenant();
    const hook = await createWebhook(
      h.db,
      clock,
      t.id,
      {
        url: "https://hooks.example.com/packproof",
        eventTypes: ["proof.finalized"],
      },
      config,
    );
    const created = await create(t.key);
    const id = created.body.proof.proofId;
    const mutate = (path: string, key: string, body: unknown = {}) =>
      request(app)
        .post(`/v1/proofs/${id}/${path}`)
        .set(auth(t.key))
        .set("Idempotency-Key", key)
        .send(body);
    expect((await mutate("finalize", "premature")).status).toBe(422);
    const init = await mutate("evidence", "video", {
      contentType: "video/mp4",
      evidenceType: "FULFILLMENT_CAPTURE",
    });
    expect(init.status, JSON.stringify(init.body)).toBe(201);
    const bytes = Buffer.from("packing-video-fixture");
    const partPath = `/v1/proofs/${id}/evidence/${init.body.evidenceId}/parts`;
    expect((await request(app).get(partPath).set(auth(t.key))).body.parts).toEqual([]);
    const part = await request(app)
      .put(`${partPath}/1`)
      .set(auth(t.key))
      .set("Content-Type", "application/octet-stream")
      .send(bytes);
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect(
      (
        await request(app)
          .put(`${partPath}/1`)
          .set(auth(t.key))
          .set("Content-Type", "application/octet-stream")
          .send(bytes)
      ).body.replayed,
    ).toBe(true);
    expect(
      (
        await mutate(`evidence/${init.body.evidenceId}/parts/complete`, "complete", {
          totalBytes: bytes.length,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mutate(`evidence/${init.body.evidenceId}/commit`, "wrong-hash", {
          sha256: "0".repeat(64),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await mutate(`evidence/${init.body.evidenceId}/commit`, "commit", {
          sha256: sha256Hex(bytes),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mutate("attestations", "attest", {
          statement: "PACKED_DESCRIBED_ITEM",
        })
      ).status,
    ).toBe(201);
    const final = await mutate("finalize", "finalize");
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    expect((await mutate("finalize", "finalize")).body).toEqual(final.body);
    const eventResponse = await request(app).get(`/v1/proofs/${id}/events`).set(auth(t.key));
    expect(eventResponse.status).toBe(200);
    const types = eventResponse.body.events.map((e: { type: string }) => e.type);
    for (const type of [
      "proof.created",
      "participant.joined",
      "evidence.uploaded",
      "evidence.committed",
      "capture.completed",
      "proof.finalized",
    ])
      expect(types).toContain(type);
    expect((await request(app).get(`/v1/proofs/${id}/manifest`).set(auth(t.key))).body).toEqual(
      final.body.manifest,
    );
    let received = 0;
    const delivery = await dispatchWebhooks(h.db, clock, config, async (_url, body, headers) => {
      expect(
        verifyWebhook(
          hook.secret,
          headers["PackProof-Signature"],
          body,
          Math.floor(clock.now().getTime() / 1000),
        ),
      ).toBe(true);
      expect(JSON.parse(body).data.proofId).toBe(id);
      received++;
      return 204;
    });
    expect(delivery.delivered).toBe(1);
    await dispatchWebhooks(h.db, clock, config, async () => {
      received++;
      return 200;
    });
    expect(received).toBe(1);
    expect((await mutate("evidence", "late", { contentType: "video/mp4" })).status).toBe(409);
    const link = await mutate("access-links", "viewer");
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect(link.body.expiresAt).toBe("2026-09-05T13:00:00.000Z");
    expect(
      (await request(app).get(new URL(link.body.url).pathname.replace("/p/", "/public/proofs/")))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get(`/public/proofs/${link.body.token}/evidence/${init.body.evidenceId}`))
        .status,
    ).toBe(403);
    const mediaLink = await mutate("access-links", "media-viewer", {
      scope: "EVIDENCE_VIEW",
    });
    const publicView = await request(app).get(`/public/proofs/${mediaLink.body.token}`);
    expect(publicView.body.evidence[0].evidenceId).toBe(init.body.evidenceId);
    expect(JSON.stringify(publicView.body)).not.toContain("objectKey");
    const publicBytes = await request(app).get(
      `/public/proofs/${mediaLink.body.token}/evidence/${init.body.evidenceId}`,
    );
    expect(publicBytes.status).toBe(200);
    expect(publicBytes.body).toEqual(bytes);
    await request(app)
      .delete(`/proofs/${id}/access-links/${mediaLink.body.accessLinkId}`)
      .set(auth(t.owner));
    expect(
      (
        await request(app).get(
          `/public/proofs/${mediaLink.body.token}/evidence/${init.body.evidenceId}`,
        )
      ).status,
    ).toBe(404);
    const receiver = await createUser(h);
    const invited = await mutate("lifecycle/receiver", "receiver", {
      userId: receiver,
    });
    expect(invited.status).toBe(201);
    const invitedAgain = await mutate("lifecycle/receiver", "receiver", {
      userId: receiver,
    });
    expect(invitedAgain.headers["idempotency-replayed"]).toBe("true");
    expect((await mutate("lifecycle/receiver", "receiver", { userId: t.owner })).status).toBe(409);
    const rotated = await request(app)
      .post(`/v1/webhooks/${hook.id}/rotate-secret`)
      .set(auth(t.key))
      .set("Idempotency-Key", "rotate-hook")
      .send({});
    expect(rotated.status).toBe(201);
    expect(rotated.body.secret).not.toBe(hook.secret);
    const audit = await h.db.query("SELECT operation FROM api_request_audit WHERE tenant_id=$1", [
      t.id,
    ]);
    expect(audit.rows.map((a) => a.operation)).toContain("POST /proofs/:id/lifecycle/receiver");
  });
  it("publishes a contract covering every JSON route and binary transport route", async () => {
    const spec = await request(app).get("/v1/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe("3.1.0");
    const router = await readFile(new URL("../src/platform/router.ts", import.meta.url), "utf8");
    for (const match of router.matchAll(
      /endpoint\(\s*"(get|post|delete)",\s*"([^"]+)",\s*"([^"]+)"/g,
    )) {
      const path = match[2].replace(/:(\w+)/g, "{$1}");
      expect(spec.body.paths[path]?.[match[1]]?.["x-packproof-scope"]).toBe(match[3]);
    }
    expect(
      spec.body.paths["/proofs/{id}/evidence/{evidenceId}/parts/{partNumber}"].put,
    ).toBeTruthy();
  });
  it("rotates keys atomically and hides keys from non-owners", async () => {
    const t = await tenant(),
      stranger = await createUser(h);
    const path = `/me/tenants/${t.id}/keys/${t.keyId}/rotate`;
    expect((await request(app).post(path).set(auth(stranger)).send({})).status).toBe(404);
    const rotated = await request(app).post(path).set(auth(t.owner)).send({});
    expect(rotated.status).toBe(201);
    expect((await create(t.key)).status).toBe(401);
    expect((await create(rotated.body.token)).status).toBe(201);
    expect(
      (await request(app).get(`/me/tenants/${t.id}/keys`).set(auth(t.owner))).text,
    ).not.toContain(rotated.body.token);
  });
  it("protects webhook secrets even in idempotency storage, rejects unsafe targets and retries failures", async () => {
    const t = await tenant();
    const body = {
      url: "https://hooks.example.com/proof",
      eventTypes: ["proof.created"],
    };
    const hook = await request(app)
      .post("/v1/webhooks")
      .set(auth(t.key))
      .set("Idempotency-Key", "hook")
      .send(body);
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    expect(
      (
        await request(app)
          .post("/v1/webhooks")
          .set(auth(t.key))
          .set("Idempotency-Key", "hook")
          .send(body)
      ).body,
    ).toEqual(hook.body);
    const stored = await h.db.query("SELECT response FROM api_idempotency WHERE tenant_id=$1", [
      t.id,
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(hook.body.secret);
    const unsafe = await request(app)
      .post("/v1/webhooks")
      .set(auth(t.key))
      .set("Idempotency-Key", "bad")
      .send({ ...body, url: "http://169.254.169.254/latest/meta-data" });
    expect(unsafe.status).toBe(400);
    await create(t.key);
    expect((await dispatchWebhooks(h.db, clock, config, async () => 500)).failed).toBe(1);
    tick = new Date(tick.getTime() + 120000);
    expect((await dispatchWebhooks(h.db, clock, config, async () => 204)).delivered).toBe(1);
  });
  it("counts limits across keys in the same tenant", async () => {
    const t = await tenant();
    await consumeApiRate(h.db, clock, t.id, 1);
    await expect(consumeApiRate(h.db, clock, t.id, 1)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
  it("rejects cross-user transaction reference lookup without exposing existing details", async () => {
    const a = await createUser(h),
      b = await createUser(h);
    await request(app)
      .post("/transactions")
      .set(auth(a))
      .send({ externalReference: "private-order", itemTitle: "Sensitive" });
    const result = await request(app)
      .post("/transactions")
      .set(auth(b))
      .send({ externalReference: "private-order" });
    expect(result.status).toBe(409);
    expect(result.text).not.toContain("Sensitive");
  });
});
describe("bounded intake and webhook validation", () => {
  it("extracts labeled order facts and requires confirmation without guessing currency or identity", () => {
    const result = previewOrderIntake({
      text: "Order # ABC-123\nItem: First edition card\nQty: 2\nTotal: $3,000.00\nBuyer: Alex\nTracking: 1Z123\nCarrier: UPS",
    });
    expect(result.draft.itemTitle).toBe("First edition card");
    expect(result.draft.quantity).toBe(2);
    expect(result.draft.transactionValue).toBe(3000);
    expect(result.draft.currency).toBeNull();
    expect(result.requiresConfirmation).toBe(true);
    expect(result.draft.metadata.intake.confirmed).toBe(false);
    expect(result.draft.externalReference).toBe("ABC-123");
    const ambiguous = previewOrderIntake({
      text: "Order: A\nOrder: B\nItem: Card",
      source: "email",
    });
    expect(ambiguous.draft.externalReference).toBeNull();
    expect(ambiguous.warnings.length).toBeGreaterThan(1);
    expect(() => previewOrderIntake({ text: "x".repeat(20001) })).toThrow();
  });
  it("rejects tampered, stale, and malformed signatures and private DNS answers", () => {
    const signature = signWebhook("secret", 1000, "{}");
    expect(verifyWebhook("secret", signature, "{}", 1000)).toBe(true);
    expect(verifyWebhook("secret", signature, "{ }", 1000)).toBe(false);
    expect(verifyWebhook("secret", signature, "{}", 1400)).toBe(false);
    expect(verifyWebhook("secret", "invalid", "{}", 1000)).toBe(false);
    for (const ip of [
      "127.0.0.1",
      "10.1.1.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "2001:db8::1",
    ])
      expect(publicAddress(ip), ip).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
  });
});
