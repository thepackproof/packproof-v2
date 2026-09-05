import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { EmailDelivery, EmailMessage } from "../src/integrations/email/delivery.js";
import {
  createProofEmailSubscription,
  dispatchPendingProofEmails,
  reconcileProofNotifications,
  revokeProofEmailSubscription,
  trackerAccessToken,
} from "../src/domain/proof-notifications.js";
import { auth, commitFulfillmentAndAttest, createHarness, login, type TestHarness } from "./helpers.js";

import { setReceiptPreference } from "../src/domain/buyer-receipt.js";

async function optInVerifiedBuyer(harness:TestHarness,proofId:string,email:string) {
  const buyer=await login(harness.app,`verified-${email}`);
  await harness.db.query("INSERT INTO commerce_receivers(proof_id,user_id,invited_by,created_at) SELECT $1,$2,user_id,$3 FROM proof_participants WHERE proof_id=$1 AND role='SELLER'",[proofId,buyer,harness.clock.now().toISOString()]);
  await harness.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,'COGNITO')",[buyer,email,harness.clock.now().toISOString()]);
  await setReceiptPreference(harness.db,harness.clock,buyer,proofId,true);
}

const TRACKER_SECRET = "test-packproof-tracker-secret-with-at-least-32-bytes";

class RecordingEmailDelivery implements EmailDelivery {
  readonly enabled = true;
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }
}

describe("live Proof tracker and email notifications", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("projects a shipping-style tracker through the existing secure public Proof link", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "tracker-seller");
    const transaction = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({
        externalReference: "ORDER-4242",
        itemTitle: "Vintage trading card",
        shipping: { carrier: "UPS", trackingNumber: "1Z4242" },
      });
    expect(transaction.status).toBe(201);
    const proof = await request(harness.app)
      .post(`/transactions/${transaction.body.transactionId}/proof`)
      .set(auth(seller));
    const proofId = proof.body.proofId as string;

    await optInVerifiedBuyer(harness,proofId,"buyer@example.com");
    const subscription = await createProofEmailSubscription(
      harness.db,
      harness.clock,
      seller,
      proofId,
      {
        email: "buyer@example.com",
        preference: "IMPORTANT",
        scope: "SUMMARY",
        publicWebBaseUrl: "https://app.thepackproof.test",
        trackerLinkSecret: TRACKER_SECRET,
      },
    );
    const token = new URL(subscription.viewUrl).pathname.split("/").pop() as string;
    expect(token).toBe(trackerAccessToken(TRACKER_SECRET, subscription.subscriptionId));

    const publicView = await request(harness.app).get(`/public/proofs/${encodeURIComponent(token)}`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.tracker.reference).toBeNull();
    expect(publicView.body.tracker.shipment.trackingNumber).toBeNull();
    expect(publicView.body.tracker.shipment.carrier).toBe("UPS");
    expect(publicView.body.tracker.milestones[0]).toMatchObject({
      code: "PROOF_CREATED",
      state: "COMPLETE",
    });
    expect(publicView.body.tracker.milestones[1]).toMatchObject({
      code: "PACKING_RECORDED",
      state: "CURRENT",
    });
  });

  it("delivers one initial email, meaningful milestones, and no duplicates", async () => {
    harness = await createHarness();
    const delivery = new RecordingEmailDelivery();
    const seller = await login(harness.app, "notification-seller");
    const transaction = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ externalReference: "ORDER-9000", itemTitle: "Collectible" });
    const proof = await request(harness.app)
      .post(`/transactions/${transaction.body.transactionId}/proof`)
      .set(auth(seller));
    const proofId = proof.body.proofId as string;

    await optInVerifiedBuyer(harness,proofId,"recipient@example.com");
    const subscription = await createProofEmailSubscription(
      harness.db,
      harness.clock,
      seller,
      proofId,
      {
        email: "recipient@example.com",
        preference: "IMPORTANT",
        publicWebBaseUrl: "https://app.thepackproof.test",
        trackerLinkSecret: TRACKER_SECRET,
      },
    );

    await dispatchPendingProofEmails(
      harness.db,
      harness.clock,
      delivery,
      "https://app.thepackproof.test",
      TRACKER_SECRET,
      proofId,
    );
    expect(delivery.messages).toHaveLength(1);
    expect(delivery.messages[0].text).toContain(subscription.viewUrl);

    await commitFulfillmentAndAttest(harness, seller, proofId, { idempotencyKey: "tracker-packing" });
    await reconcileProofNotifications(harness.db, harness.clock, proofId);
    await reconcileProofNotifications(harness.db, harness.clock, proofId);
    await dispatchPendingProofEmails(
      harness.db,
      harness.clock,
      delivery,
      "https://app.thepackproof.test",
      TRACKER_SECRET,
      proofId,
    );
    expect(delivery.messages).toHaveLength(2);
    expect(delivery.messages[1].subject).toContain("Packing evidence recorded");

    const finalized = await request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));
    expect(finalized.status).toBe(200);
    await reconcileProofNotifications(harness.db, harness.clock, proofId);
    await dispatchPendingProofEmails(
      harness.db,
      harness.clock,
      delivery,
      "https://app.thepackproof.test",
      TRACKER_SECRET,
      proofId,
    );
    expect(delivery.messages).toHaveLength(3);
    expect(delivery.messages[2].subject).toContain("Evidence record finalized");

    await reconcileProofNotifications(harness.db, harness.clock, proofId);
    await dispatchPendingProofEmails(
      harness.db,
      harness.clock,
      delivery,
      "https://app.thepackproof.test",
      TRACKER_SECRET,
      proofId,
    );
    expect(delivery.messages).toHaveLength(3);

    await revokeProofEmailSubscription(
      harness.db,
      harness.clock,
      seller,
      proofId,
      subscription.subscriptionId,
    );
    const token = new URL(subscription.viewUrl).pathname.split("/").pop() as string;
    const revoked = await request(harness.app).get(`/public/proofs/${encodeURIComponent(token)}`);
    expect(revoked.status).toBe(404);
  });

  it("exposes authenticated subscription management without requiring email delivery to be configured", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "subscription-route-seller");
    const transaction = await request(harness.app).post("/transactions").set(auth(seller)).send({});
    const proof = await request(harness.app)
      .post(`/transactions/${transaction.body.transactionId}/proof`)
      .set(auth(seller));
    const proofId = proof.body.proofId as string;

    await optInVerifiedBuyer(harness,proofId,"observer@example.com");
    const created = await request(harness.app)
      .post(`/proofs/${proofId}/email-subscriptions`)
      .set(auth(seller))
      .send({ email: "observer@example.com", preference: "FINAL_ONLY" });
    expect(created.status).toBe(201);
    expect(created.body.emailDeliveryConfigured).toBe(false);
    expect(created.body.subscription.email).toBe("observer@example.com");

    const listed = await request(harness.app)
      .get(`/proofs/${proofId}/email-subscriptions`)
      .set(auth(seller));
    expect(listed.status).toBe(200);
    expect(listed.body.subscriptions).toHaveLength(1);

    const removed = await request(harness.app)
      .delete(`/proofs/${proofId}/email-subscriptions/${created.body.subscription.subscriptionId}`)
      .set(auth(seller));
    expect(removed.status).toBe(204);
  });
});
