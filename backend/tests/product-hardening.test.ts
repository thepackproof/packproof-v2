import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createProofEmailSubscription, dispatchPendingProofEmails } from "../src/domain/proof-notifications.js";
import { verifyProofPackage } from "../src/domain/proof-package.js";
import { auth, commitFulfillmentAndAttest, commitProofEvidence, createHarness, login, type TestHarness } from "./helpers.js";

const secret = "test-notification-delivery-secret-at-least-32-bytes";
const origin = "https://app.thepackproof.test";

describe("product reliability and public boundaries", () => {
  let h: TestHarness;
  afterEach(async () => { await h?.close(); });

  async function setup() {
    h = await createHarness(undefined, { corsOrigins: [origin] });
    const seller = await login(h.app, "hardening-seller");
    const transaction = await request(h.app).post("/transactions").set(auth(seller)).send({
      itemTitle: "Private collectible", externalReference: "PRIVATE-ORDER",
      shipping: { carrier: "UPS", trackingNumber: "PRIVATE-TRACKING" },
    });
    const proof = await request(h.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller));
    return { seller, proofId: proof.body.proofId as string };
  }

  it("applies CORS and no-store to intercepted routes, failures and preflights", async () => {
    const { seller, proofId } = await setup();
    const path = `/proofs/${proofId}/email-subscriptions`;
    for (const response of [
      await request(h.app).options(path).set("Origin", origin).set("Access-Control-Request-Method", "POST"),
      await request(h.app).get(path).set(auth(seller)).set("Origin", origin),
      await request(h.app).get(path).set("Origin", origin),
      await request(h.app).post(path).set(auth(seller)).set("Origin", origin).send({ email: "invalid" }),
    ]) {
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    }
    const denied = await request(h.app).get(path).set(auth(seller)).set("Origin", "https://untrusted.test");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    for (const target of [path, "/transactions"]) {
      const invalid = await request(h.app).post(target).set(auth(seller)).set("Content-Type", "application/json").send('{"secret":');
      expect(invalid.status).toBe(400);
      expect(invalid.body).toEqual({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } });
    }
  });

  it("keeps status-only links redacted and does not label arbitrary evidence as packing", async () => {
    const { seller, proofId } = await setup();
    await commitProofEvidence(h, seller, proofId, { evidenceType: "SELLER_EVIDENCE" });
    const link = await request(h.app).post(`/proofs/${proofId}/access-links`).set(auth(seller)).send({ scope: "STATUS_ONLY" });
    const view = await request(h.app).get(`/public/proofs/${link.body.token}`);
    expect(view.status).toBe(200);
    expect(view.body.tracker).toMatchObject({ reference: null, itemTitle: null, shipment: null });
    expect(JSON.stringify(view.body)).not.toContain("PRIVATE-");
    expect(view.body.tracker.milestones.find((m: { code: string }) => m.code === "PACKING_RECORDED").state).toBe("CURRENT");
  });

  it("exports only authorized finalized records and independently verifies their hash", async () => {
    const { seller, proofId } = await setup();
    const stranger = await login(h.app, "hardening-stranger");
    const path = `/proofs/${proofId}/package`;
    expect((await request(h.app).get(path).set(auth(stranger))).status).toBe(403);
    expect((await request(h.app).get(path).set(auth(seller))).status).toBe(404);
    await commitFulfillmentAndAttest(h, seller, proofId);
    await request(h.app).post(`/proofs/${proofId}/finalize`).set(auth(seller)).expect(200);
    const exported = await request(h.app).get(path).set(auth(seller)).expect(200);
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(verifyProofPackage({ package: exported.body })).toMatchObject({ schemaValid: true, canonicalJsonValid: true, digestValid: true });
    expect(exported.body.signature).toBeNull();
    const retry = await request(h.app).get(path).set(auth(seller));
    expect(retry.body).toEqual(exported.body);
  });

  it("serializes subscription creation and claims concurrent delivery exactly once per active lease", async () => {
    const { seller, proofId } = await setup();
    const input = { email: "buyer@example.com", publicWebBaseUrl: origin, trackerLinkSecret: secret };
    const subscriptions = await Promise.all([
      createProofEmailSubscription(h.db, h.clock, seller, proofId, input),
      createProofEmailSubscription(h.db, h.clock, seller, proofId, input),
    ]);
    expect(subscriptions[0].subscriptionId).toBe(subscriptions[1].subscriptionId);
    let started!: () => void;
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let count = 0;
    const delivery = { enabled: true, send: async () => { count++; started(); await blocked; } };
    const first = dispatchPendingProofEmails(h.db, h.clock, delivery, origin, secret, proofId);
    await sending;
    try {
      expect(await dispatchPendingProofEmails(h.db, h.clock, delivery, origin, secret, proofId)).toEqual({ sent: 0, failed: 0 });
      expect(count).toBe(1);
    } finally { release(); }
    expect(await first).toEqual({ sent: 1, failed: 0 });
  });

  it("does not deliver email through a separately revoked access link", async () => {
    const { seller, proofId } = await setup();
    await createProofEmailSubscription(h.db, h.clock, seller, proofId, {
      email: "buyer@example.com", publicWebBaseUrl: origin, trackerLinkSecret: secret,
    });
    const links = await request(h.app).get(`/proofs/${proofId}/access-links`).set(auth(seller));
    const linkId = links.body.accessLinks[0].accessLinkId;
    await request(h.app).delete(`/proofs/${proofId}/access-links/${linkId}`).set(auth(seller)).expect(204);
    let sent = 0;
    await dispatchPendingProofEmails(h.db, h.clock, { enabled: true, send: async () => { sent++; } }, origin, secret, proofId);
    expect(sent).toBe(0);
  });

  it("recovers an expired delivery claim and backs off a failed attempt without storing provider details", async () => {
    const { seller, proofId } = await setup();
    await createProofEmailSubscription(h.db, h.clock, seller, proofId, {
      email: "buyer@example.com", publicWebBaseUrl: origin, trackerLinkSecret: secret,
    });
    await h.db.query(`UPDATE proof_notification_outbox SET delivery_token = 'abandoned', delivery_lease_until = '2000-01-01' WHERE proof_id = $1`, [proofId]);
    const failed = await dispatchPendingProofEmails(h.db, h.clock, {
      enabled: true, send: async () => { throw new Error("private provider payload"); },
    }, origin, secret, proofId);
    expect(failed).toEqual({ sent: 0, failed: 1 });
    const row = (await h.db.query(`SELECT attempt_count, last_error, delivery_token FROM proof_notification_outbox WHERE proof_id = $1`, [proofId])).rows[0];
    expect(row).toEqual({ attempt_count: 1, last_error: "Email delivery failed", delivery_token: null });
    let sent = 0;
    const delivery = { enabled: true, send: async () => { sent++; } };
    expect(await dispatchPendingProofEmails(h.db, h.clock, delivery, origin, secret, proofId)).toEqual({ sent: 0, failed: 0 });
    await h.db.query(`UPDATE proof_notification_outbox SET next_attempt_at = '2000-01-01' WHERE proof_id = $1`, [proofId]);
    expect(await dispatchPendingProofEmails(h.db, h.clock, delivery, origin, secret, proofId)).toEqual({ sent: 1, failed: 0 });
    expect(sent).toBe(1);
  });
});
