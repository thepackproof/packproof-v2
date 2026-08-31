import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, PackProofV2Client } from "../../mobile/src/v2-api.ts";
import { createHarness, type TestHarness } from "./helpers.js";

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

interface ClientContext {
  baseUrl: string;
  harness: TestHarness;
  seller: PackProofV2Client;
  buyer: PackProofV2Client;
  sellerToken: { value: string };
  buyerToken: { value: string };
  close: () => Promise<void>;
}

async function startClientServer(): Promise<ClientContext> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const harness = await createHarness(undefined, { publicBaseUrl: baseUrl });
  const server = harness.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const sellerToken = { value: "" };
  const buyerToken = { value: "" };
  return {
    baseUrl,
    harness,
    seller: new PackProofV2Client({ baseUrl, getToken: () => sellerToken.value }),
    buyer: new PackProofV2Client({ baseUrl, getToken: () => buyerToken.value }),
    sellerToken,
    buyerToken,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await harness.close();
    },
  };
}

function resume(baseUrl: string, token: string): PackProofV2Client {
  return new PackProofV2Client({
    baseUrl,
    getToken: () => token,
  });
}

describe("Phase 10 mobile V2 API client", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  it("completes the two-user vertical slice and required recovery/retry cases", async () => {
    const ctx = await startClientServer();
    close = ctx.close;

    const sellerLogin = await ctx.seller.login("seller-1");
    ctx.sellerToken.value = sellerLogin.token;
    const buyerLogin = await ctx.buyer.login("buyer-1");
    ctx.buyerToken.value = buyerLogin.token;

    const txn = await ctx.seller.createTransaction({
      externalReference: "v2:seller-1",
      metadata: { source: "phase10" },
    });
    const proof1 = await ctx.seller.createOrGetProof(txn.transactionId);
    const proof2 = await ctx.seller.createOrGetProof(txn.transactionId);
    expect(proof2.proofId).toBe(proof1.proofId);

    const sellerAfterRestart = resume(ctx.baseUrl, ctx.sellerToken.value);
    const proofAfterRestart = await sellerAfterRestart.getProof(proof1.proofId);
    expect(proofAfterRestart.proofId).toBe(proof1.proofId);
    expect(proofAfterRestart.status).toBe("OPEN");

    const leftAndReturned = await sellerAfterRestart.getProof(proof1.proofId);
    expect(leftAndReturned.proofId).toBe(proof1.proofId);

    const invite1 = await ctx.seller.createInvitation(proof1.proofId, "buyer@example.com");
    const invite2 = await ctx.seller.createInvitation(proof1.proofId, "buyer@example.com");
    expect(invite2.invitation.invitationId).toBe(invite1.invitation.invitationId);

    await expect(ctx.seller.finalizeProof(proof1.proofId)).rejects.toMatchObject({
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
    } satisfies Partial<ApiError>);

    const accept1 = await ctx.buyer.acceptInvitation(invite1.invitation.token);
    const accept2 = await ctx.buyer.acceptInvitation(invite1.invitation.token);
    expect(accept2.proof.proofId).toBe(proof1.proofId);
    expect(accept1.proof.participants.filter((p) => p.role === "BUYER")).toHaveLength(1);
    expect(accept2.proof.participants.filter((p) => p.role === "BUYER")).toHaveLength(1);

    const buyerAfterRestart = resume(ctx.baseUrl, ctx.buyerToken.value);
    const buyerProof = await buyerAfterRestart.getProof(proof1.proofId);
    expect(buyerProof.participants.find((p) => p.role === "BUYER")?.userId).toBe(buyerLogin.userId);

    const bytes = new Uint8Array(Buffer.from("phase10-seller-evidence"));
    const idempotencyKey = "seller-capture-1";
    const afterUpload1 = await ctx.seller.submitEvidence({
      proofId: proof1.proofId,
      bytes,
      contentType: "image/jpeg",
      idempotencyKey,
    });
    const afterUpload2 = await ctx.seller.submitEvidence({
      proofId: proof1.proofId,
      bytes,
      contentType: "image/jpeg",
      idempotencyKey,
    });
    expect(afterUpload2.evidence).toHaveLength(1);
    expect(afterUpload1.evidence[0]?.evidenceId).toBe(afterUpload2.evidence[0]?.evidenceId);
    expect(afterUpload2.status).toBe("EVIDENCE_COMMITTED");

    const finalized1 = await ctx.seller.finalizeProof(proof1.proofId);
    const finalized2 = await ctx.seller.finalizeProof(proof1.proofId);
    expect(finalized2.manifest.sha256).toBe(finalized1.manifest.sha256);
    expect(finalized2.manifest.canonicalJson).toBe(finalized1.manifest.canonicalJson);
    expect(finalized1.proof.status).toBe("FINALIZED");

    await expect(
      ctx.seller.createInvitation(proof1.proofId, "other@example.com"),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });
    await expect(
      ctx.seller.submitEvidence({
        proofId: proof1.proofId,
        bytes,
        contentType: "image/jpeg",
        idempotencyKey: "after-final",
      }),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });

    const sellerManifest = await ctx.seller.getManifest(proof1.proofId);
    const buyerManifest = await buyerAfterRestart.getManifest(proof1.proofId);
    expect(buyerManifest.sha256).toBe(sellerManifest.sha256);
    expect(buyerManifest.canonicalJson).toBe(sellerManifest.canonicalJson);

    const sellerFinal = await sellerAfterRestart.getProof(proof1.proofId);
    const buyerFinal = await buyerAfterRestart.getProof(proof1.proofId);
    expect(sellerFinal.proofId).toBe(buyerFinal.proofId);
    expect(sellerFinal.status).toBe("FINALIZED");
    expect(buyerFinal.status).toBe("FINALIZED");
  });

  it("reads and updates the same transaction and shipping context from seller and buyer clients", async () => {
    const ctx = await startClientServer();
    close = ctx.close;

    const sellerLogin = await ctx.seller.login("seller-ctx");
    ctx.sellerToken.value = sellerLogin.token;
    const buyerLogin = await ctx.buyer.login("buyer-ctx");
    ctx.buyerToken.value = buyerLogin.token;

    const txn = await ctx.seller.createTransaction({
      externalReference: "ORD-CLIENT-1",
      transactionDate: "2026-08-20",
      itemTitle: "Watch",
      itemDescription: "Steel case",
      quantity: 1,
      transactionValue: 120,
      currency: "usd",
      shipping: {
        carrier: "FedEx",
        service: "2Day",
        trackingNumber: "FX123",
        shipmentDate: "2026-08-21",
      },
    });
    expect(txn.currency).toBe("USD");
    const proof = await ctx.seller.createOrGetProof(txn.transactionId);
    const invite = await ctx.seller.createInvitation(proof.proofId, "buyer@example.com");
    await ctx.buyer.acceptInvitation(invite.invitation.token);

    const sellerTxn = await ctx.seller.getTransaction(txn.transactionId);
    const buyerTxn = await ctx.buyer.getTransaction(txn.transactionId);
    expect(buyerTxn.itemTitle).toBe(sellerTxn.itemTitle);
    expect(buyerTxn.shipping).toEqual(sellerTxn.shipping);

    const updatedTxn = await ctx.seller.updateTransaction(txn.transactionId, {
      itemTitle: "Watch updated",
    });
    expect(updatedTxn.itemTitle).toBe("Watch updated");
    const updatedShip = await ctx.seller.updateShipping(txn.transactionId, {
      trackingNumber: "FX999",
    });
    expect(updatedShip.shipping?.trackingNumber).toBe("FX999");
    expect((await ctx.buyer.getTransaction(txn.transactionId)).itemTitle).toBe("Watch updated");
    expect((await ctx.buyer.getTransaction(txn.transactionId)).shipping?.trackingNumber).toBe(
      "FX999",
    );

    const bytes = new Uint8Array(Buffer.from("ctx-client-evidence"));
    await ctx.seller.submitEvidence({
      proofId: proof.proofId,
      bytes,
      contentType: "image/jpeg",
      idempotencyKey: "ctx-capture",
    });
    const finalized = await ctx.seller.finalizeProof(proof.proofId);
    const manifest = finalized.manifest.manifest as {
      transaction: { itemTitle: string | null };
      shipping: { trackingNumber: string | null };
    };
    expect(manifest.transaction.itemTitle).toBe("Watch updated");
    expect(manifest.shipping.trackingNumber).toBe("FX999");
    const buyerManifest = await ctx.buyer.getManifest(proof.proofId);
    expect(buyerManifest.sha256).toBe(finalized.manifest.sha256);

    await expect(
      ctx.seller.updateTransaction(txn.transactionId, { itemTitle: "nope" }),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });
    await expect(
      ctx.seller.updateShipping(txn.transactionId, { trackingNumber: "nope" }),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });
  });

  it("imports a reference purchase through the mobile client and reuses the canonical transaction", async () => {
    const ctx = await startClientServer();
    close = ctx.close;
    const sellerLogin = await ctx.seller.login("import-client-seller");
    ctx.sellerToken.value = sellerLogin.token;

    const first = await ctx.seller.importTransaction({
      adapterKey: "demo-marketplace",
      externalTransactionId: "DM-MOBILE-1",
      createProof: true,
    });
    expect(first.transaction.itemTitle).toBe("Vintage film camera");
    expect(first.transaction.shipping?.trackingNumber).toBe("1Z999AA10123456784");
    expect(first.transaction.provenance?.source).toBe("MARKETPLACE_API");
    expect(first.proof?.proofId).toBe(first.transaction.proofId);

    const second = await ctx.seller.importTransaction({
      adapterKey: "demo-marketplace",
      externalTransactionId: "DM-MOBILE-1",
      createProof: true,
    });
    expect(second.transaction.transactionId).toBe(first.transaction.transactionId);
    expect(second.proof?.proofId).toBe(first.proof?.proofId);

    const fromServer = await ctx.seller.getTransaction(first.transaction.transactionId);
    expect(fromServer.itemTitle).toBe(first.transaction.itemTitle);
    expect(fromServer.provenance?.provider).toBe("demo-marketplace");
  });
});
