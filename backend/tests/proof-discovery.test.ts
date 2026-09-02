import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { CognitoJwtAdapter } from "../src/auth/cognito-adapter.js";
import { createApp } from "../src/app.js";
import { sha256Hex } from "../src/hash.js";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { PackProofV2Client } from "../../mobile/src/v2-api.ts";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function createOpenProof(
  harness: TestHarness,
  seller: string,
  body: Record<string, unknown> = {},
) {
  const txn = await request(harness.app).post("/transactions").set(auth(seller)).send(body);
  expect(txn.status).toBe(201);
  const proof = await request(harness.app)
    .post(`/transactions/${txn.body.transactionId}/proof`)
    .set(auth(seller));
  expect(proof.status).toBe(200);
  return { txn: txn.body, proof: proof.body };
}

async function inviteAndAccept(harness: TestHarness, seller: string, buyer: string, proofId: string) {
  const invited = await request(harness.app)
    .post(`/proofs/${proofId}/invitations`)
    .set(auth(seller))
    .send({ inviteeUserId: buyer });
  expect(invited.status).toBe(201);
  const inbox = await request(harness.app).get("/invitations").set(auth(buyer));
  const invitationId = inbox.body.invitations[0].invitationId as string;
  const accepted = await request(harness.app)
    .post(`/invitations/${invitationId}/accept`)
    .set(auth(buyer));
  expect(accepted.status).toBe(200);
  return accepted.body;
}

async function commitAndFinalize(harness: TestHarness, seller: string, proofId: string, bytes: Buffer) {
  const upload = await request(harness.app)
    .post(`/proofs/${proofId}/evidence/uploads`)
    .set(auth(seller))
    .set("Idempotency-Key", `discovery-${proofId}`)
    .send({ contentType: "video/mp4", evidenceType: "FULFILLMENT_CAPTURE" });
  expect(upload.status).toBe(201);
  await request(harness.app)
    .put(new URL(upload.body.upload.url as string).pathname)
    .set("Content-Type", "video/mp4")
    .send(bytes);
  const expected = sha256Hex(bytes);
  await request(harness.app)
    .post(`/proofs/${proofId}/evidence/${upload.body.evidenceId}/commit`)
    .set(auth(seller))
    .send({ sha256: expected });
  await request(harness.app)
    .post(`/proofs/${proofId}/attestations`)
    .set(auth(seller))
    .send({ statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: upload.body.evidenceId });
  const finalized = await request(harness.app).post(`/proofs/${proofId}/finalize`).set(auth(seller));
  expect(finalized.status).toBe(200);
  return { expected, finalized: finalized.body };
}

describe("authenticated Proof discovery", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("lets a seller discover an active Proof they created and rejects unauthenticated access", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "discovery-seller");
    const created = await createOpenProof(harness, seller, {
      itemTitle: "Active camera",
      externalReference: "ORD-ACTIVE-1",
      shipping: { carrier: "UPS", trackingNumber: "1ZACTIVE" },
    });

    const denied = await request(harness.app).get("/me/proofs");
    expect(denied.status).toBe(401);

    const listed = await request(harness.app).get("/me/proofs").set(auth(seller));
    expect(listed.status).toBe(200);
    expect(listed.body.proofs).toHaveLength(1);
    expect(listed.body.proofs[0]).toMatchObject({
      proofId: created.proof.proofId,
      transactionId: created.txn.transactionId,
      role: "SELLER",
      status: "READY_FOR_EVIDENCE",
      transaction: {
        externalReference: "ORD-ACTIVE-1",
        itemTitle: "Active camera",
        carrier: "UPS",
        trackingNumber: "1ZACTIVE",
      },
    });
    expect(listed.body.proofs[0].finalizedAt).toBeNull();
    expect(listed.body.proofs[0]).not.toHaveProperty("email");
    expect(JSON.stringify(listed.body)).not.toMatch(
      /cognito|password|provider_subject|accessToken|objectKey|upload/i,
    );

    const again = await request(harness.app)
      .post(`/transactions/${created.txn.transactionId}/proof`)
      .set(auth(seller));
    expect(again.body.proofId).toBe(created.proof.proofId);
    const stillOne = await request(harness.app).get("/me/proofs").set(auth(seller));
    expect(stillOne.body.proofs).toHaveLength(1);
  });

  it("shows the same Proof to buyer only after acceptance and never to an unrelated user", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "discovery-invite-seller");
    const buyer = await login(harness.app, "discovery-invite-buyer");
    const stranger = await login(harness.app, "discovery-stranger");
    const created = await createOpenProof(harness, seller, { itemTitle: "Invite item" });

    await request(harness.app)
      .post(`/proofs/${created.proof.proofId}/invitations`)
      .set(auth(seller))
      .send({ inviteeUserId: buyer });

    const beforeAccept = await request(harness.app).get("/me/proofs").set(auth(buyer));
    expect(beforeAccept.status).toBe(200);
    expect(beforeAccept.body.proofs).toEqual([]);

    const inbox = await request(harness.app).get("/invitations").set(auth(buyer));
    expect(inbox.body.invitations).toHaveLength(1);
    expect(inbox.body.invitations[0].proofId).toBe(created.proof.proofId);

    await request(harness.app)
      .post(`/invitations/${inbox.body.invitations[0].invitationId}/accept`)
      .set(auth(buyer));
    const secondAccept = await request(harness.app)
      .post(`/invitations/${inbox.body.invitations[0].invitationId}/accept`)
      .set(auth(buyer));
    expect(secondAccept.status).toBe(200);

    const sellerList = await request(harness.app).get("/me/proofs").set(auth(seller));
    const buyerList = await request(harness.app).get("/me/proofs").set(auth(buyer));
    expect(sellerList.body.proofs).toHaveLength(1);
    expect(buyerList.body.proofs).toHaveLength(1);
    expect(buyerList.body.proofs[0].proofId).toBe(created.proof.proofId);
    expect(sellerList.body.proofs[0].proofId).toBe(created.proof.proofId);
    expect(sellerList.body.proofs[0].role).toBe("SELLER");
    expect(buyerList.body.proofs[0].role).toBe("BUYER");

    const strangerList = await request(harness.app).get("/me/proofs").set(auth(stranger));
    expect(strangerList.body.proofs).toEqual([]);
    const stolen = await request(harness.app)
      .get(`/proofs/${created.proof.proofId}`)
      .set(auth(stranger));
    expect(stolen.status).toBe(403);
  });

  it("reconstructs finalized history after discarding client Proof identifiers", async () => {
    harness = await createHarness();
    const seller = await login(harness.app, "history-seller");
    const buyer = await login(harness.app, "history-buyer");
    const created = await createOpenProof(harness, seller, {
      itemTitle: "History item",
      externalReference: "ORD-HIST-1",
      shipping: { carrier: "USPS", trackingNumber: "9400HIST" },
    });
    await inviteAndAccept(harness, seller, buyer, created.proof.proofId);
    const bytes = Buffer.from("discovery-history-evidence");
    const beforeTxn = await request(harness.app)
      .get(`/transactions/${created.txn.transactionId}`)
      .set(auth(seller));
    const { expected, finalized } = await commitAndFinalize(
      harness,
      seller,
      created.proof.proofId,
      bytes,
    );
    const evidenceSha = finalized.proof.evidence[0].sha256 as string;
    expect(evidenceSha).toBe(expected);

    const auditsBefore = await harness.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events WHERE proof_id = $1`,
      [created.proof.proofId],
    );

    const discardedSeller = await login(harness.app, "history-seller");
    expect(discardedSeller).toBe(seller);
    const listed = await request(harness.app).get("/me/proofs").set(auth(discardedSeller));
    expect(listed.body.proofs).toHaveLength(1);
    expect(listed.body.proofs[0]).toMatchObject({
      proofId: created.proof.proofId,
      role: "SELLER",
      status: "FINALIZED",
    });
    expect(listed.body.proofs[0].finalizedAt).toBeTruthy();

    const auditsAfter = await harness.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events WHERE proof_id = $1`,
      [created.proof.proofId],
    );
    expect(auditsAfter.rows[0].count).toBe(auditsBefore.rows[0].count);

    const recovered = await request(harness.app)
      .get(`/proofs/${listed.body.proofs[0].proofId}`)
      .set(auth(discardedSeller));
    const manifest = await request(harness.app)
      .get(`/proofs/${created.proof.proofId}/manifest`)
      .set(auth(discardedSeller));
    const buyerManifest = await request(harness.app)
      .get(`/proofs/${created.proof.proofId}/manifest`)
      .set(auth(buyer));
    const afterTxn = await request(harness.app)
      .get(`/transactions/${created.txn.transactionId}`)
      .set(auth(seller));

    expect(recovered.body.proofId).toBe(created.proof.proofId);
    expect(recovered.body.transactionId).toBe(created.txn.transactionId);
    expect(recovered.body.status).toBe("FINALIZED");
    expect(recovered.body.evidence).toHaveLength(1);
    expect(recovered.body.evidence[0].sha256).toBe(evidenceSha);
    expect(manifest.body.sha256).toBe(finalized.manifest.sha256);
    expect(buyerManifest.body.sha256).toBe(finalized.manifest.sha256);
    expect(afterTxn.body.itemTitle).toBe(beforeTxn.body.itemTitle);
    expect(afterTxn.body.shipping).toEqual(beforeTxn.body.shipping);
    expect(afterTxn.body.proofId).toBe(created.proof.proofId);
  });

  it("reconstructs history from a new client instance with no local Proof identifiers", async () => {
    harness = await createHarness();
    const sellerId = await login(harness.app, "fresh-client-seller");
    const buyerId = await login(harness.app, "fresh-client-buyer");
    const created = await createOpenProof(harness, sellerId, { itemTitle: "Fresh client item" });
    await inviteAndAccept(harness, sellerId, buyerId, created.proof.proofId);
    const bytes = Buffer.from("fresh-client-evidence");
    const { expected, finalized } = await commitAndFinalize(
      harness,
      sellerId,
      created.proof.proofId,
      bytes,
    );

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = harness.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    try {
      const fresh = new PackProofV2Client({
        baseUrl,
        getToken: () => sellerId,
      });
      const collection = await fresh.listMyProofs();
      expect(collection.proofs).toHaveLength(1);
      expect(collection.proofs[0].proofId).toBe(created.proof.proofId);
      const proof = await fresh.getProof(collection.proofs[0].proofId);
      const manifest = await fresh.getManifest(collection.proofs[0].proofId);
      expect(proof.proofId).toBe(created.proof.proofId);
      expect(proof.evidence[0].sha256).toBe(expected);
      expect(manifest.sha256).toBe(finalized.manifest.sha256);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("serves discovery through Cognito-mapped identity without duplicating Proofs", async () => {
    harness = await createHarness();
    const app = createApp({
      db: harness.db,
      objectStore: harness.objectStore,
      clock: harness.clock,
      auth: new CognitoJwtAdapter(harness.db, harness.clock, {
        async verify(token) {
          if (token !== "seller-access") {
            throw new Error("unverified");
          }
          return {
            sub: "cognito-sub-discovery-seller",
            token_use: "access",
            client_id: "mobile-client",
            iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
            exp: Math.floor(Date.now() / 1000) + 3600,
          };
        },
      }),
      publicBaseUrl: "http://127.0.0.1",
      devAuth: false,
    });

    const header = { Authorization: "Bearer seller-access" };
    const firstMe = await request(app).get("/me").set(header);
    expect(firstMe.status).toBe(200);
    const txn = await request(app).post("/transactions").set(header).send({ itemTitle: "Cognito item" });
    const proof = await request(app).post(`/transactions/${txn.body.transactionId}/proof`).set(header);
    const listed = await request(app).get("/me/proofs").set(header);
    const listedAgain = await request(app).get("/me/proofs").set(header);
    expect(listed.body.proofs).toHaveLength(1);
    expect(listedAgain.body.proofs).toHaveLength(1);
    expect(listed.body.proofs[0].proofId).toBe(proof.body.proofId);
    expect(listed.body.proofs[0].role).toBe("SELLER");

    const spoof = await request(app)
      .get("/me/proofs")
      .set({ ...header, "x-user-id": "user_SPOOFED" });
    expect(spoof.body.proofs[0].proofId).toBe(proof.body.proofId);

    const deniedDev = await request(app).post("/auth/dev/login").send({ subject: "nope" });
    expect(deniedDev.status).toBe(404);
  });
});

describe("dev-auth discovery login", () => {
  let harness: TestHarness;

  afterEach(async () => {
    await harness?.close();
  });

  it("resolves the same collection after a second development login", async () => {
    harness = await createHarness();
    const first = await login(harness.app, "dev-discovery");
    const created = await createOpenProof(harness, first, { itemTitle: "Dev mode item" });
    const second = await login(harness.app, "dev-discovery");
    expect(second).toBe(first);
    const listed = await request(harness.app).get("/me/proofs").set(auth(second));
    expect(listed.body.proofs.map((item: { proofId: string }) => item.proofId)).toEqual([
      created.proof.proofId,
    ]);
  });
});
