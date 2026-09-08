import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { BearerUserAdapter } from "../src/auth/adapter.js";
import { CognitoJwtAdapter } from "../src/auth/cognito-adapter.js";
import { ensureIdentityUser } from "../src/domain/users.js";
import { authorizeProofAccess } from "../src/domain/proof-access.js";
import { acceptCommerceReceiver, requireCommerceAccess } from "../src/domain/commerce-lifecycle.js";
import { auth, commitProofEvidence, createHarness, login, type TestHarness } from "./helpers.js";

describe("current account disable authorization", () => {
  let h: TestHarness;
  afterEach(async () => { await h?.close(); });
  const denied = { code: "UNAUTHENTICATED", httpStatus: 401 };

  it("rejects an already issued development bearer and both existing identity mappings without creating a replacement account", async () => {
    h = await createHarness();
    const userId = await ensureIdentityUser(h.db, h.clock, "dev", "disabled-dev");
    const adapter = new BearerUserAdapter(h.db);
    expect(await adapter.authenticate({ authorization: `Bearer ${userId}` })).toEqual({ userId });
    await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1", [userId]);
    await expect(adapter.authenticate({ authorization: `Bearer ${userId}` })).rejects.toMatchObject(denied);
    await expect(ensureIdentityUser(h.db, h.clock, "dev", "disabled-dev")).rejects.toMatchObject(denied);
    expect((await request(h.app).post("/auth/dev/login").send({ subject: "disabled-dev" })).status).toBe(401);
    expect((await h.db.query("SELECT id,status FROM users")).rows).toEqual([{ id: userId, status: "DISABLED" }]);
    expect((await h.db.query("SELECT user_id FROM auth_identities")).rows).toEqual([{ user_id: userId }]);
  });

  it("rejects a still-valid Cognito token after disabling its mapped user without refreshing contact claims", async () => {
    h = await createHarness(); let email = "before@example.com";
    const adapter = new CognitoJwtAdapter(h.db, h.clock, { verify: async () => ({ sub: "disabled-cognito", token_use: "id", iss: "https://cognito-idp.us-east-1.amazonaws.com/test", exp: Math.floor(h.clock.now().getTime() / 1000) + 3600, email, email_verified: true }) });
    const { userId } = await adapter.authenticate({ authorization: "Bearer valid-provider-token" });
    await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1", [userId]); email = "after@example.com";
    await expect(adapter.authenticate({ authorization: "Bearer valid-provider-token" })).rejects.toMatchObject(denied);
    await expect(ensureIdentityUser(h.db, h.clock, "cognito", "disabled-cognito")).rejects.toMatchObject(denied);
    expect((await h.db.query("SELECT email_normalized FROM user_verified_contacts WHERE user_id=$1", [userId])).rows).toEqual([{ email_normalized: "before@example.com" }]);
    expect((await h.db.query("SELECT id FROM users")).rows).toEqual([{ id: userId }]);
  });

  async function proof() {
    h = await createHarness(); const seller = await login(h.app, "active-seller");
    const transaction = await request(h.app).post("/transactions").set(auth(seller)).send({ itemTitle: "Retained original" });
    const created = await request(h.app).post(`/transactions/${transaction.body.transactionId}/proof`).set(auth(seller));
    expect(created.status).toBe(200); return { seller, proofId: created.body.proofId as string };
  }

  it("rechecks participant access after authentication and keeps historical records when account status changes", async () => {
    const { seller, proofId } = await proof();
    const original = await commitProofEvidence(h, seller, proofId, { contentType: "image/jpeg", bytes: Buffer.from("acknowledged original retained") });
    const signedIn = await new BearerUserAdapter(h.db).authenticate({ authorization: `Bearer ${seller}` });
    expect((await authorizeProofAccess(h.db, proofId, signedIn.userId)).role).toBe("SELLER");
    await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1", [seller]);
    await expect(authorizeProofAccess(h.db, proofId, signedIn.userId)).rejects.toMatchObject(denied);
    expect((await request(h.app).get(`/proofs/${proofId}`).set(auth(seller))).status).toBe(401);
    expect((await h.db.query("SELECT id,validation_status FROM evidence WHERE id=$1", [original.evidenceId])).rows).toEqual([{ id: original.evidenceId, validation_status: "COMMITTED" }]);
    expect((await h.db.query("SELECT user_id FROM proof_participants WHERE proof_id=$1", [proofId])).rows).toEqual([{ user_id: seller }]);
    await h.db.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [seller]);
    expect((await authorizeProofAccess(h.db, proofId, seller)).role).toBe("SELLER");
  });

  it("blocks disabled receiver acceptance and rechecks previously accepted receiver access", async () => {
    const { seller, proofId } = await proof(); const buyer = await login(h.app, "receiver");
    await h.db.query("INSERT INTO commerce_receivers(proof_id,user_id,invited_by,created_at) VALUES($1,$2,$3,$4)", [proofId, buyer, seller, h.clock.now().toISOString()]);
    await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1", [buyer]);
    await expect(acceptCommerceReceiver(h.db, h.clock, buyer, proofId)).rejects.toMatchObject(denied);
    expect((await h.db.query("SELECT accepted_at FROM commerce_receivers WHERE proof_id=$1", [proofId])).rows).toEqual([{ accepted_at: null }]);
    await h.db.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [buyer]);
    await acceptCommerceReceiver(h.db, h.clock, buyer, proofId);
    // Isolate access evaluation with a finalized synthetic fixture; this test
    // does not claim a preservation receipt or bypass production finalization.
    await h.db.query("UPDATE proofs SET status='FINALIZED',finalized_at=$2 WHERE id=$1", [proofId, h.clock.now().toISOString()]);
    expect(await requireCommerceAccess(h.db, proofId, buyer)).toBe("BUYER");
    await h.db.query("UPDATE users SET status='DISABLED' WHERE id=$1", [buyer]);
    await expect(requireCommerceAccess(h.db, proofId, buyer)).rejects.toMatchObject(denied);
    await expect(acceptCommerceReceiver(h.db, h.clock, buyer, proofId)).rejects.toMatchObject(denied);
    expect(await requireCommerceAccess(h.db, proofId, seller)).toBe("SELLER");
    expect((await h.db.query("SELECT accepted_at FROM commerce_receivers WHERE proof_id=$1", [proofId])).rows[0].accepted_at).not.toBeNull();
  });
});
