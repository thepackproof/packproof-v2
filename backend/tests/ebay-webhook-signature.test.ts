import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyEbayDeletionNotificationSignature,
} from "../src/integrations/ebay/account-deletion.js";

function signedFixture(kid: string, payload: unknown) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const signer = createSign("sha1");
  signer.update(JSON.stringify(payload), "utf8");
  signer.end();
  const signature = signer.sign(privateKey, "base64");
  const header = Buffer.from(JSON.stringify({ kid, signature }), "utf8").toString("base64");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { header, publicKeyPem };
}

function ebayVerificationFetch(publicKeyPem: string, calls: string[]): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/identity/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "application-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/commerce/notification/v1/public_key/")) {
      return new Response(JSON.stringify({ key: publicKeyPem }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

describe("eBay account-deletion webhook signatures", () => {
  it("accepts an authentic signed notification using the eBay public-key flow", async () => {
    const payload = {
      metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
      notification: {
        notificationId: "note-signed-1",
        data: { username: "seller", userId: "ebay-user-1" },
      },
    };
    const fixture = signedFixture("packproof-test-key-1", payload);
    const calls: string[] = [];

    await expect(
      verifyEbayDeletionNotificationSignature({
        payload,
        signatureHeader: fixture.header,
        environment: "sandbox",
        clientId: "client-id",
        clientSecret: "client-secret",
        fetchImpl: ebayVerificationFetch(fixture.publicKeyPem, calls),
      }),
    ).resolves.toBeUndefined();

    expect(calls.some((url) => url.includes("/identity/v1/oauth2/token"))).toBe(true);
    expect(calls.some((url) => url.includes("/public_key/packproof-test-key-1"))).toBe(true);
  });

  it("rejects a payload changed after it was signed", async () => {
    const signedPayload = {
      metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
      notification: { notificationId: "note-signed-2", data: { userId: "user-a" } },
    };
    const fixture = signedFixture("packproof-test-key-2", signedPayload);
    const changedPayload = {
      ...signedPayload,
      notification: { notificationId: "note-signed-2", data: { userId: "user-b" } },
    };

    await expect(
      verifyEbayDeletionNotificationSignature({
        payload: changedPayload,
        signatureHeader: fixture.header,
        environment: "sandbox",
        clientId: "client-id",
        clientSecret: "client-secret",
        fetchImpl: ebayVerificationFetch(fixture.publicKeyPem, []),
      }),
    ).rejects.toMatchObject({ code: "INVALID_WEBHOOK_SIGNATURE", httpStatus: 412 });
  });

  it("rejects missing or malformed signature headers before provider lookup", async () => {
    await expect(
      verifyEbayDeletionNotificationSignature({
        payload: {},
        signatureHeader: undefined,
        environment: "sandbox",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).rejects.toMatchObject({ code: "INVALID_WEBHOOK_SIGNATURE", httpStatus: 412 });

    await expect(
      verifyEbayDeletionNotificationSignature({
        payload: {},
        signatureHeader: "not-base64-json",
        environment: "sandbox",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).rejects.toMatchObject({ code: "INVALID_WEBHOOK_SIGNATURE", httpStatus: 412 });
  });
});
