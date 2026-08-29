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

async function startClientServer(): Promise<{
  seller: PackProofV2Client;
  buyer: PackProofV2Client;
  close: () => Promise<void>;
}> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const harness: TestHarness = await createHarness(undefined, { publicBaseUrl: baseUrl });
  const server = harness.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const sellerToken = { value: "" };
  const buyerToken = { value: "" };
  const seller = new PackProofV2Client({ baseUrl, getToken: () => sellerToken.value });
  const buyer = new PackProofV2Client({ baseUrl, getToken: () => buyerToken.value });
  const sellerLogin = await seller.login("seller-capture");
  sellerToken.value = sellerLogin.token;
  const buyerLogin = await buyer.login("buyer-capture");
  buyerToken.value = buyerLogin.token;
  return {
    seller,
    buyer,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await harness.close();
    },
  };
}

describe("evidence capture API boundary", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  it("keeps Proof unchanged until commit and does not invent a second Proof", async () => {
    const ctx = await startClientServer();
    close = ctx.close;

    const txn = await ctx.seller.createTransaction({
      externalReference: "ORD-CAPTURE-1",
      itemTitle: "Lens",
      shipping: { carrier: "UPS", trackingNumber: "1ZCAP" },
    });
    const proof = await ctx.seller.createOrGetProof(txn.transactionId);
    expect(proof.proofId).toBe((await ctx.seller.createOrGetProof(txn.transactionId)).proofId);
    const invite = await ctx.seller.createInvitation(proof.proofId, "buyer@example.com");
    await ctx.buyer.acceptInvitation(invite.invitation.token);

    await expect(ctx.seller.finalizeProof(proof.proofId)).rejects.toMatchObject({
      code: "PROOF_NOT_READY_FOR_FINALIZATION",
    } satisfies Partial<ApiError>);

    const before = await ctx.seller.getProof(proof.proofId);
    expect(before.status).toBe("READY_FOR_EVIDENCE");
    expect(before.evidence.filter((item) => item.validationStatus === "COMMITTED")).toHaveLength(0);

    const initialized = await ctx.seller.initializeEvidenceUpload(proof.proofId, {
      contentType: "video/mp4",
      idempotencyKey: "local-only-1",
    });
    const retryInit = await ctx.seller.initializeEvidenceUpload(proof.proofId, {
      contentType: "video/mp4",
      idempotencyKey: "local-only-1",
    });
    expect(retryInit.evidenceId).toBe(initialized.evidenceId);

    const afterInit = await ctx.seller.getProof(proof.proofId);
    expect(afterInit.status).toBe("READY_FOR_EVIDENCE");
    expect(afterInit.transaction.itemTitle).toBe("Lens");
    expect(afterInit.transaction.shipping?.trackingNumber).toBe("1ZCAP");
    expect(afterInit.evidence.some((item) => item.validationStatus === "COMMITTED")).toBe(false);

    const firstBytes = new Uint8Array(Buffer.from("discarded-local-capture"));
    const submittedBytes = new Uint8Array(Buffer.from("submitted-packing-video"));
    await ctx.seller.uploadObject(initialized.upload, firstBytes, "video/mp4");
    await ctx.seller.uploadObject(retryInit.upload, submittedBytes, "video/mp4");

    await expect(
      ctx.seller.commitEvidence(proof.proofId, initialized.evidenceId, "deadbeef"),
    ).rejects.toMatchObject({ code: "EVIDENCE_HASH_MISMATCH" });

    const stillReady = await ctx.seller.getProof(proof.proofId);
    expect(stillReady.status).toBe("READY_FOR_EVIDENCE");

    const committed = await ctx.seller.commitEvidence(proof.proofId, initialized.evidenceId);
    const committedAgain = await ctx.seller.commitEvidence(proof.proofId, initialized.evidenceId);
    expect(committedAgain.evidenceId).toBe(committed.evidenceId);
    expect(committedAgain.sha256).toBe(committed.sha256);
    expect(committed.proof.status).toBe("EVIDENCE_COMMITTED");
    expect(committed.proof.evidence.filter((item) => item.validationStatus === "COMMITTED")).toHaveLength(
      1,
    );
    expect(committed.proof.transaction.itemTitle).toBe("Lens");
    expect(committed.proof.transaction.shipping?.carrier).toBe("UPS");

    const afterCommit = await ctx.seller.getProof(proof.proofId);
    expect(afterCommit.status).toBe("EVIDENCE_COMMITTED");
    expect(afterCommit.evidence).toHaveLength(1);

    const finalized = await ctx.seller.finalizeProof(proof.proofId);
    expect(finalized.proof.status).toBe("FINALIZED");
    const buyerManifest = await ctx.buyer.getManifest(proof.proofId);
    expect(buyerManifest.sha256).toBe(finalized.manifest.sha256);
    expect(
      (buyerManifest.manifest as { transaction: { itemTitle: string }; shipping: { trackingNumber: string } })
        .transaction.itemTitle,
    ).toBe("Lens");
    expect(
      (buyerManifest.manifest as { shipping: { trackingNumber: string } }).shipping.trackingNumber,
    ).toBe("1ZCAP");

    await expect(
      ctx.seller.initializeEvidenceUpload(proof.proofId, {
        contentType: "video/mp4",
        idempotencyKey: "after-final",
      }),
    ).rejects.toMatchObject({ code: "PROOF_ALREADY_FINALIZED" });
    await expect(ctx.seller.createOrGetProof(txn.transactionId)).resolves.toMatchObject({
      proofId: proof.proofId,
    });
  });
});
