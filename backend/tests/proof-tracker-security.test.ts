import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

describe("Proof tracker subscription authorization", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("does not let an authenticated nonparticipant subscribe to another Proof", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "tracker-security-seller");
    const stranger = await login(harness.app, "tracker-security-stranger");

    const transaction = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ externalReference: "PRIVATE-TRACKER" });
    const proof = await request(harness.app)
      .post(`/transactions/${transaction.body.transactionId}/proof`)
      .set(auth(seller));

    const attempt = await request(harness.app)
      .post(`/proofs/${proof.body.proofId}/email-subscriptions`)
      .set(auth(stranger))
      .send({ email: "stranger@example.com" });

    expect(attempt.status).toBe(403);
    expect(attempt.body.error.code).toBe("PARTICIPANT_NOT_AUTHORIZED");

    const subscriptions = await harness.db.query(
      `SELECT id FROM proof_notification_subscriptions WHERE proof_id = $1`,
      [proof.body.proofId],
    );
    expect(subscriptions.rows).toHaveLength(0);
  });
});
