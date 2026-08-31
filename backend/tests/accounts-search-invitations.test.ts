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

  it("ranks exact username, prefix, and display-name matches and strips a leading @", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "rank-seller");
    const exact = await login(harness.app, "rank-exact");
    const prefix = await login(harness.app, "rank-prefix");
    const displayPrefix = await login(harness.app, "rank-display");
    const substring = await login(harness.app, "rank-substr");
    await completeProfile(harness, seller, "rank_seller", "Rank Seller");
    await completeProfile(harness, exact, "janesmith", "Other Name");
    await completeProfile(harness, prefix, "janesmithx", "Zee");
    await completeProfile(harness, displayPrefix, "alexr", "Jane Rivera");
    await completeProfile(harness, substring, "bobsmith", "XJaneY");

    const exactSearch = await request(harness.app)
      .get("/users/search")
      .query({ q: "@JaneSmith" })
      .set(auth(seller));
    expect(exactSearch.status).toBe(200);
    expect(exactSearch.body.users.map((user: { username: string }) => user.username)).toEqual([
      "janesmith",
      "janesmithx",
    ]);

    const prefixSearch = await request(harness.app)
      .get("/users/search")
      .query({ q: "JANE" })
      .set(auth(seller));
    expect(prefixSearch.body.users.map((user: { userId: string }) => user.userId)).toEqual([
      exact,
      prefix,
      displayPrefix,
      substring,
    ]);

    const displaySearch = await request(harness.app)
      .get("/users/search")
      .query({ q: "jane riv" })
      .set(auth(seller));
    expect(displaySearch.body.users).toEqual([
      { userId: displayPrefix, username: "alexr", displayName: "Jane Rivera" },
    ]);
  });

  it("rejects empty, short, and oversized queries instead of enumerating accounts", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "enum-seller");
    await completeProfile(harness, seller, "enum_seller", "Enum Seller");
    await completeProfile(harness, await login(harness.app, "enum-other"), "enum_other", "Other");

    const missing = await request(harness.app).get("/users/search").set(auth(seller));
    const empty = await request(harness.app).get("/users/search").query({ q: "" }).set(auth(seller));
    const short = await request(harness.app).get("/users/search").query({ q: "e" }).set(auth(seller));
    const atOnly = await request(harness.app).get("/users/search").query({ q: "@" }).set(auth(seller));
    const oversized = await request(harness.app)
      .get("/users/search")
      .query({ q: "e".repeat(65) })
      .set(auth(seller));
    expect(missing.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(short.status).toBe(400);
    expect(atOnly.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(missing.body.error.code).toBe("INVALID_SEARCH");
    expect(empty.body.users).toBeUndefined();
  });

  it("bounds result count and escapes wildcard characters", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "bound-seller");
    await completeProfile(harness, seller, "bound_seller", "Bound Seller");
    for (let index = 0; index < 21; index += 1) {
      const userId = await login(harness.app, `bound-user-${index}`);
      await completeProfile(
        harness,
        userId,
        `bound${String(index).padStart(2, "0")}`,
        `Bound User ${index}`,
      );
    }

    const found = await request(harness.app)
      .get("/users/search")
      .query({ q: "bound" })
      .set(auth(seller));
    expect(found.status).toBe(200);
    expect(found.body.users).toHaveLength(20);

    const wildcard = await request(harness.app)
      .get("/users/search")
      .query({ q: "bo%" })
      .set(auth(seller));
    expect(wildcard.status).toBe(200);
    expect(wildcard.body.users).toEqual([]);
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

    const beforeAccept = await request(harness.app).get("/me/proofs").set(auth(buyer));
    expect(beforeAccept.body.proofs).toEqual([]);

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

    const afterAccept = await request(harness.app).get("/me/proofs").set(auth(buyer));
    expect(afterAccept.body.proofs).toHaveLength(1);
    expect(afterAccept.body.proofs[0].proofId).toBe(proofId);

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

  it("annotates Proof-scoped search and rejects self, duplicate, unauthorized, and finalized invites", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "rel-seller");
    const buyer = await login(harness.app, "rel-buyer");
    const stranger = await login(harness.app, "rel-stranger");
    await completeProfile(harness, seller, "rel_seller", "Rel Seller");
    await completeProfile(harness, buyer, "rel_buyer", "Rel Buyer");
    await completeProfile(harness, stranger, "rel_stranger", "Rel Stranger");

    const txn = await request(harness.app)
      .post("/transactions")
      .set(auth(seller))
      .send({ itemTitle: "Relationship carton" });
    const proof = await request(harness.app)
      .post(`/transactions/${txn.body.transactionId}/proof`)
      .set(auth(seller));
    const proofId = proof.body.proofId as string;

    const selfInvite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ userId: seller });
    expect(selfInvite.status).toBe(400);
    expect(selfInvite.body.error.code).toBe("CANNOT_INVITE_SELF");

    const buyerInvite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(buyer))
      .send({ inviteeUserId: stranger });
    const strangerInvite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(stranger))
      .send({ inviteeUserId: buyer });
    expect(buyerInvite.status).toBe(403);
    expect(strangerInvite.status).toBe(403);

    const openSearch = await request(harness.app)
      .get(`/proofs/${proofId}/users/search`)
      .query({ q: "rel_" })
      .set(auth(seller));
    expect(openSearch.status).toBe(200);
    expect(openSearch.body.users).toEqual(
      expect.arrayContaining([
        {
          userId: seller,
          username: "rel_seller",
          displayName: "Rel Seller",
          invitationState: "SELF",
        },
        {
          userId: buyer,
          username: "rel_buyer",
          displayName: "Rel Buyer",
          invitationState: "NONE",
        },
      ]),
    );
    expect(JSON.stringify(openSearch.body)).not.toMatch(/email|cognito|password|provider_subject/i);

    const buyerSearch = await request(harness.app)
      .get(`/proofs/${proofId}/users/search`)
      .query({ q: "rel_" })
      .set(auth(buyer));
    const strangerSearch = await request(harness.app)
      .get(`/proofs/${proofId}/users/search`)
      .query({ q: "rel_" })
      .set(auth(stranger));
    expect(buyerSearch.status).toBe(403);
    expect(strangerSearch.status).toBe(403);

    const invited = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ userId: buyer });
    expect(invited.status).toBe(201);
    expect(invited.body.invitation.inviteeUserId).toBe(buyer);

    const pendingSearch = await request(harness.app)
      .get(`/proofs/${proofId}/users/search`)
      .query({ q: "rel_buyer" })
      .set(auth(seller));
    expect(pendingSearch.body.users[0]).toMatchObject({
      userId: buyer,
      invitationState: "INVITED",
    });

    await request(harness.app)
      .post(`/invitations/${invited.body.invitation.invitationId}/accept`)
      .set(auth(buyer));

    const joinedSearch = await request(harness.app)
      .get(`/proofs/${proofId}/users/search`)
      .query({ q: "rel_buyer" })
      .set(auth(seller));
    expect(joinedSearch.body.users[0].invitationState).toBe("PARTICIPANT");

    const reinvite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeUserId: buyer });
    expect(reinvite.status).toBe(409);
    expect(reinvite.body.error.code).toBe("ALREADY_PARTICIPANT");

    const upload = await request(harness.app)
      .post(`/proofs/${proofId}/evidence/uploads`)
      .set(auth(seller))
      .set("Idempotency-Key", "rel-evidence")
      .send({ contentType: "video/mp4" });
    const bytes = Buffer.from("relationship-evidence");
    await request(harness.app)
      .put(new URL(upload.body.upload.url as string).pathname)
      .set("Content-Type", "video/mp4")
      .send(bytes);
    await request(harness.app)
      .post(`/proofs/${proofId}/evidence/${upload.body.evidenceId}/commit`)
      .set(auth(seller))
      .send({ sha256: sha256Hex(bytes) });
    await request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));

    const finalizedSearch = await request(harness.app)
      .get(`/proofs/${proofId}/users/search`)
      .query({ q: "rel_" })
      .set(auth(seller));
    const finalizedInvite = await request(harness.app)
      .post(`/proofs/${proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeUserId: stranger });
    expect(finalizedSearch.status).toBe(409);
    expect(finalizedSearch.body.error.code).toBe("PROOF_ALREADY_FINALIZED");
    expect(finalizedInvite.status).toBe(409);
    expect(finalizedInvite.body.error.code).toBe("PROOF_ALREADY_FINALIZED");
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
