import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sha256Hex } from "../src/hash.js";
import { createInvitation } from "../src/domain/invitations.js";
import { createOrGetProof } from "../src/domain/create-proof.js";
import { createTransaction } from "../src/domain/transactions.js";
import { auth, createHarness, createUser, login, type TestHarness } from "./helpers.js";

async function completeProfile(
  harness: TestHarness,
  userId: string,
  username: string,
  displayName: string,
) {
  const response = await request(harness.app)
    .patch("/me/profile")
    .set(auth(userId))
    .send({ username, displayName });
  expect(response.status).toBe(200);
  return response.body;
}

describe("PackProof profiles and user search", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("retrieves and updates the authenticated profile", async () => {
    harness = await createHarness();
    const userId = await login(harness.app, "seller-profile");

    const before = await request(harness.app).get("/me").set(auth(userId));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      userId,
      username: null,
      displayName: null,
      status: "ACTIVE",
    });
    expect(before.body).not.toHaveProperty("email");
    expect(JSON.stringify(before.body)).not.toMatch(/cognito|password|sub/i);

    const updated = await request(harness.app)
      .patch("/me/profile")
      .set(auth(userId))
      .send({ username: "SellerOne", displayName: "Seller One" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      userId,
      username: "SellerOne",
      displayName: "Seller One",
    });

    const renamed = await request(harness.app)
      .patch("/me/profile")
      .set(auth(userId))
      .send({ displayName: "Seller One Updated" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.displayName).toBe("Seller One Updated");
    expect(renamed.body.username).toBe("SellerOne");
  });

  it("rejects duplicate usernames case-insensitively", async () => {
    harness = await createHarness();
    const first = await login(harness.app, "user-a");
    const second = await login(harness.app, "user-b");
    await completeProfile(harness, first, "UniqueHandle", "First");

    const taken = await request(harness.app)
      .patch("/me/profile")
      .set(auth(second))
      .send({ username: "uniquehandle", displayName: "Second" });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("USERNAME_TAKEN");
  });

  it("rejects unauthenticated search and returns only safe profile fields", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "search-seller");
    const buyer = await login(harness.app, "search-buyer");
    await completeProfile(harness, seller, "pack_seller", "Pack Seller");
    await completeProfile(harness, buyer, "pack_buyer", "Pack Buyer");

    const denied = await request(harness.app).get("/users/search").query({ q: "pack" });
    expect(denied.status).toBe(401);

    const found = await request(harness.app)
      .get("/users/search")
      .query({ q: "pack_b" })
      .set(auth(seller));
    expect(found.status).toBe(200);
    expect(found.body.users).toHaveLength(1);
    expect(found.body.users[0]).toEqual({
      userId: buyer,
      username: "pack_buyer",
      displayName: "Pack Buyer",
    });
    expect(found.body.users[0]).not.toHaveProperty("email");
    expect(JSON.stringify(found.body)).not.toMatch(/@|cognito|password|provider_subject|token/i);

    const emailQuery = await request(harness.app)
      .get("/users/search")
      .query({ q: "buyer@example.com" })
      .set(auth(seller));
    expect(emailQuery.status).toBe(200);
    expect(emailQuery.body.users).toEqual([]);
  });
});

describe("direct account invitations", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("lets a seller invite a searched buyer who then joins the existing Proof", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "invite-seller");
    const buyer = await login(harness.app, "invite-buyer");
    const stranger = await login(harness.app, "invite-stranger");
    await completeProfile(harness, seller, "invite_seller", "Invite Seller");
    await completeProfile(harness, buyer, "invite_buyer", "Invite Buyer");

    const txn = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ itemTitle: "Sealed carton", externalReference: "INV-1" });
    const proof1 = await request(harness.app)
      .post(`/transactions/${txn.body.transactionId}/proof`)
      .set(auth(seller));
    const proof2 = await request(harness.app)
      .post(`/transactions/${txn.body.transactionId}/proof`)
      .set(auth(seller));
    expect(proof2.body.proofId).toBe(proof1.body.proofId);
    const proofId = proof1.body.proofId as string;

    const search = await request(harness.app)
      .get("/users/search")
      .query({ q: "invite_b" })
      .set(auth(seller));
    expect(search.body.users[0].userId).toBe(buyer);

    const invite1 = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeUserId: search.body.users[0].userId });
    const invite2 = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeUserId: buyer });
    expect(invite1.status).toBe(201);
    expect(invite2.body.invitation.invitationId).toBe(invite1.body.invitation.invitationId);
    expect(invite1.body.invitation.inviteeUserId).toBe(buyer);
    expect(invite1.body.proof.proofId).toBe(proofId);

    const inbox = await request(harness.app).get("/invitations").set(auth(buyer));
    expect(inbox.status).toBe(200);
    expect(inbox.body.invitations).toHaveLength(1);
    expect(inbox.body.invitations[0]).toMatchObject({
      invitationId: invite1.body.invitation.invitationId,
      proofId,
      status: "PENDING",
      inviter: { userId: seller, username: "invite_seller", displayName: "Invite Seller" },
      transaction: {
        transactionId: txn.body.transactionId,
        itemTitle: "Sealed carton",
        externalReference: "INV-1",
      },
    });
    expect(inbox.body.invitations[0]).not.toHaveProperty("token");
    expect(JSON.stringify(inbox.body)).not.toMatch(/email|cognito|password/i);

    const strangerInbox = await request(harness.app).get("/invitations").set(auth(stranger));
    expect(strangerInbox.body.invitations).toEqual([]);

    const stolen = await request(harness.app)
      .post(`/invitations/${invite1.body.invitation.invitationId}/accept`)
      .set(auth(stranger));
    expect(stolen.status).toBe(403);
    expect(stolen.body.error.code).toBe("INVITATION_NOT_ADDRESSED");

    const stolenToken = await request(harness.app)
      .post(`/invitations/${invite1.body.invitation.token}/accept`)
      .set(auth(stranger));
    expect(stolenToken.status).toBe(403);

    const accept1 = await request(harness.app)
      .post(`/invitations/${invite1.body.invitation.invitationId}/accept`)
      .set(auth(buyer));
    const accept2 = await request(harness.app)
      .post(`/invitations/${invite1.body.invitation.invitationId}/accept`)
      .set(auth(buyer));
    expect(accept1.status).toBe(200);
    expect(accept2.body.proof.proofId).toBe(proofId);
    expect(accept2.body.proof.participants.filter((p: { role: string }) => p.role === "BUYER")).toHaveLength(
      1,
    );
    expect(accept2.body.proof.participants.find((p: { role: string }) => p.role === "BUYER").userId).toBe(
      buyer,
    );

    const stillOne = await request(harness.app)
      .post(`/transactions/${txn.body.transactionId}/proof`)
      .set(auth(seller));
    expect(stillOne.body.proofId).toBe(proofId);

    const afterLogout = await request(harness.app).get(`/proofs/${proofId}`).set(auth(seller));
    const afterRelogin = await request(harness.app)
      .get(`/proofs/${proofId}`)
      .set(auth(await login(harness.app, "invite-seller")));
    expect(afterLogout.body.proofId).toBe(proofId);
    expect(afterRelogin.body.proofId).toBe(proofId);
    expect(afterRelogin.body.participants).toHaveLength(2);
  });

  it("keeps token invitations working and does not change Proof identity after re-auth", async () => {
    harness = await createHarness();
    const seller = await createUser(harness);
    const buyer = await createUser(harness);
    const txn = await createTransaction(harness.db, harness.clock, seller, {
      itemTitle: "Legacy token invite",
    });
    const proof = await createOrGetProof(harness.db, harness.clock, seller, txn.transactionId);
    const invite = await createInvitation(
      harness.db,
      harness.clock,
      seller,
      proof.proofId,
      "buyer@example.com",
    );
    expect(invite.invitation.inviteeUserId).toBeNull();

    const accepted = await request(harness.app)
      .post(`/invitations/${invite.invitation.token}/accept`)
      .set(auth(buyer));
    expect(accepted.status).toBe(200);
    expect(accepted.body.proof.proofId).toBe(proof.proofId);
  });
});

describe("account-phase evidence and manifest regression", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("finalizes with the same SHA-256 after account-bound invitation", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "hash-seller");
    const buyer = await login(harness.app, "hash-buyer");
    await completeProfile(harness, seller, "hash_seller", "Hash Seller");
    await completeProfile(harness, buyer, "hash_buyer", "Hash Buyer");

    const txn = await request(harness.app).post("/transactions").set(auth(seller)).send({});
    const proof = await request(harness.app)
      .post(`/transactions/${txn.body.transactionId}/proof`)
      .set(auth(seller));
    await request(harness.app)
      .post(`/proofs/${proof.body.proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeUserId: buyer });
    await request(harness.app)
      .post(`/invitations/${(await request(harness.app).get("/invitations").set(auth(buyer))).body.invitations[0].invitationId}/accept`)
      .set(auth(buyer));

    const upload = await request(harness.app)
      .post(`/proofs/${proof.body.proofId}/evidence/uploads`)
      .set(auth(seller))
      .set("Idempotency-Key", "account-phase-evidence")
      .send({ contentType: "video/mp4" });
    const bytes = Buffer.from("account-phase-evidence-bytes");
    await request(harness.app)
      .put(new URL(upload.body.upload.url as string).pathname)
      .set("Content-Type", "video/mp4")
      .send(bytes);
    const expected = sha256Hex(bytes);
    await request(harness.app)
      .post(`/proofs/${proof.body.proofId}/evidence/${upload.body.evidenceId}/commit`)
      .set(auth(seller))
      .send({ sha256: expected });
    const finalized = await request(harness.app)
      .post(`/proofs/${proof.body.proofId}/finalize`)
      .set(auth(seller));
    const sellerManifest = await request(harness.app)
      .get(`/proofs/${proof.body.proofId}/manifest`)
      .set(auth(seller));
    const buyerManifest = await request(harness.app)
      .get(`/proofs/${proof.body.proofId}/manifest`)
      .set(auth(buyer));
    expect(finalized.body.manifest.sha256).toBe(sellerManifest.body.sha256);
    expect(buyerManifest.body.sha256).toBe(sellerManifest.body.sha256);
    expect(sellerManifest.body.manifest.evidence[0].sha256).toBe(expected);
  });
});
