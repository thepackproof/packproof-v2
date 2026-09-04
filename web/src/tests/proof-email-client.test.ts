import { afterEach, describe, expect, it, vi } from "vitest";
import { PackProofApi } from "../api/client";

describe("live Proof email API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a secure tracker subscription using important updates by default", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          subscription: {
            subscriptionId: "pns_1",
            proofId: "proof_1",
            email: "buyer@example.com",
            preference: "IMPORTANT",
            scope: "SUMMARY",
            createdAt: "2026-09-04T14:00:00.000Z",
            revokedAt: null,
            viewUrl: "https://app.example/p/token",
          },
          emailDeliveryConfigured: true,
          delivery: { sent: 1, failed: 0 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "bearer" });

    const result = await api.createProofEmailSubscription("proof_1", {
      email: "buyer@example.com",
    });

    expect(result.subscription.viewUrl).toContain("/p/");
    expect(fetchMock).toHaveBeenCalledWith(
      "/proofs/proof_1/email-subscriptions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "buyer@example.com",
          preference: "IMPORTANT",
          scope: "SUMMARY",
        }),
      }),
    );
  });
});
