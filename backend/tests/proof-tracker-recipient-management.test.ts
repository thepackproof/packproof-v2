import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createProofEmailSubscription } from "../src/domain/proof-notifications.js";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

import { setReceiptPreference } from "../src/domain/buyer-receipt.js";
async function optInBuyer(h:TestHarness,proofId:string,email:string) {
  const buyer=await login(h.app,`buyer-${email}`);
  await h.db.query("INSERT INTO commerce_receivers(proof_id,user_id,invited_by,created_at) SELECT $1,$2,user_id,$3 FROM proof_participants WHERE proof_id=$1 AND role='SELLER'",[proofId,buyer,h.clock.now().toISOString()]);
  await h.db.query("INSERT INTO user_verified_contacts(user_id,email_normalized,verified_at,source) VALUES($1,$2,$3,'COGNITO')",[buyer,email,h.clock.now().toISOString()]);
  await setReceiptPreference(h.db,h.clock,buyer,proofId,true);
}
const TRACKER_SECRET = "test-packproof-tracker-secret-with-at-least-32-bytes";

describe("recipient Proof tracker email controls", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("lets the secure-link recipient change preferences and unsubscribe without revoking Proof viewing", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "recipient-controls-seller");
    const transaction = await request(harness.app).post("/transactions").set(auth(seller)).send({});
    const proof = await request(harness.app)
      .post(`/transactions/${transaction.body.transactionId}/proof`)
      .set(auth(seller));
    const proofId = proof.body.proofId as string;

    await optInBuyer(harness,proofId,"recipient.controls@example.com");
    const subscription = await createProofEmailSubscription(
      harness.db,
      harness.clock,
      seller,
      proofId,
      {
        email: "recipient.controls@example.com",
        preference: "IMPORTANT",
        scope: "SUMMARY",
        publicWebBaseUrl: "https://app.thepackproof.test",
        trackerLinkSecret: TRACKER_SECRET,
      },
    );
    const token = new URL(subscription.viewUrl).pathname.split("/").pop() as string;

    const initial = await request(harness.app)
      .get(`/public/proofs/${encodeURIComponent(token)}/email-subscription`);
    expect(initial.status).toBe(200);
    expect(initial.body.subscription.email).toBe("re•••@example.com");
    expect(initial.body.subscription.preference).toBe("IMPORTANT");

    const changed = await request(harness.app)
      .patch(`/public/proofs/${encodeURIComponent(token)}/email-subscription`)
      .send({ preference: "FINAL_ONLY" });
    expect(changed.status).toBe(200);
    expect(changed.body.subscription.preference).toBe("FINAL_ONLY");

    const unsubscribed = await request(harness.app)
      .delete(`/public/proofs/${encodeURIComponent(token)}/email-subscription`);
    expect(unsubscribed.status).toBe(204);

    const managementAfter = await request(harness.app)
      .get(`/public/proofs/${encodeURIComponent(token)}/email-subscription`);
    expect(managementAfter.status).toBe(404);

    const proofStillViewable = await request(harness.app)
      .get(`/public/proofs/${encodeURIComponent(token)}`);
    expect(proofStillViewable.status).toBe(200);
    expect(proofStillViewable.body.proofId).toBe(proofId);
  });

  it("rejects unsupported notification preferences", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "recipient-controls-invalid");
    const transaction = await request(harness.app).post("/transactions").set(auth(seller)).send({});
    const proof = await request(harness.app)
      .post(`/transactions/${transaction.body.transactionId}/proof`)
      .set(auth(seller));
    await optInBuyer(harness,proof.body.proofId as string,"recipient@example.com");
    const subscription = await createProofEmailSubscription(
      harness.db,
      harness.clock,
      seller,
      proof.body.proofId as string,
      {
        email: "recipient@example.com",
        preference: "IMPORTANT",
        publicWebBaseUrl: "https://app.thepackproof.test",
        trackerLinkSecret: TRACKER_SECRET,
      },
    );
    const token = new URL(subscription.viewUrl).pathname.split("/").pop() as string;
    const response = await request(harness.app)
      .patch(`/public/proofs/${encodeURIComponent(token)}/email-subscription`)
      .send({ preference: "EVERY_SECOND" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_NOTIFICATION_PREFERENCE");
  });
});
