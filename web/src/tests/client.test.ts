import { describe, expect, it, vi } from "vitest";
import { joinUrl, PackProofApi } from "../api/client";
import { ApiError } from "../api/types";

describe("API client boundary", () => {
  it("joins same-origin and absolute API URLs", () => {
    expect(joinUrl("", "/me/proofs")).toBe("/me/proofs");
    expect(joinUrl("http://127.0.0.1:3000", "/proofs/abc")).toBe(
      "http://127.0.0.1:3000/proofs/abc",
    );
  });

  it("discards invitation tokens from create and accept responses", async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          invitation: {
            invitationId: "inv_1",
            proofId: "proof_1",
            inviteeIdentifier: "buyer-1",
            inviteeUserId: null,
            status: "PENDING",
            token: "should-not-escape",
            createdAt: "2026-08-30T12:00:00.000Z",
            acceptedAt: null,
            expiresAt: null,
          },
          proof: { proofId: "proof_1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    const created = await api.createInvitation("proof_1", { inviteeIdentifier: "buyer-1" });
    expect(created.invitation).not.toHaveProperty("token");
    expect(JSON.stringify(created)).not.toContain("should-not-escape");
    vi.unstubAllGlobals();
  });

  it("requires a bearer token for authenticated reads", async () => {
    const api = new PackProofApi({ baseUrl: "", getToken: () => null });
    await expect(api.getProof("proof_1")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    } satisfies Partial<ApiError>);
  });

  it("imports through the reference adapter contract rather than a client-built transaction", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          created: true,
          identity: {
            adapterKey: "demo-marketplace",
            tenantKey: "marketplace:demo-marketplace",
            externalTransactionId: "DM-1",
            source: "MARKETPLACE_API",
          },
          proof: null,
          transaction: { transactionId: "txn_1", itemTitle: "Vintage film camera" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    const imported = await api.importTransaction({ adapterKey: "demo-marketplace" });
    expect(imported.transaction.itemTitle).toBe("Vintage film camera");
    expect(fetchMock).toHaveBeenCalledWith(
      "/integrations/transactions/import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          adapterKey: "demo-marketplace",
          mode: "reference",
          externalTransactionId: null,
          createProof: false,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("imports demo shipment observations through the reference carrier adapter", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          transactionId: "txn_1",
          proofId: "proof_1",
          createdCount: 1,
          events: [{ id: "sev_1", eventType: "LABEL_CREATED" }],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    const imported = await api.importShipmentEvents({
      transactionId: "txn_1",
      throughEventType: "LABEL_CREATED",
    });
    expect(imported.createdCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/integrations/shipment-events/import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          adapterKey: "demo-carrier",
          mode: "reference",
          transactionId: "txn_1",
          externalTransactionId: null,
          throughEventType: "LABEL_CREATED",
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("loads shipment integrity from the server verification route", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "LINKED",
          proofId: "proof_1",
          shipmentSupplementSha256: "aa".repeat(32),
          verification: { valid: true, linkedToFinalizedProof: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    const integrity = await api.getShipmentIntegrity("proof_1");
    expect(integrity.status).toBe("LINKED");
    expect(fetchMock).toHaveBeenCalledWith(
      "/proofs/proof_1/shipment-integrity",
      expect.objectContaining({ method: "GET" }),
    );
    vi.unstubAllGlobals();
  });

  it("requests trusted shipment sync without client-supplied provenance", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ createdCount: 1, provider: "trusted-demo-carrier" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    await api.syncShipment("txn_1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/transactions/txn_1/shipment-sync",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
    vi.unstubAllGlobals();
  });

  it("searches Proof users on the Proof-scoped route", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ users: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    await api.searchProofUsers("proof_1", "@Buyer");
    expect(fetchMock).toHaveBeenCalledWith(
      "/proofs/proof_1/users/search?q=%40Buyer",
      expect.objectContaining({ method: "GET" }),
    );
    vi.unstubAllGlobals();
  });

  it("updates profile through the authenticated profile endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          userId: "user_1",
          username: "newuser",
          displayName: "New User",
          status: "ACTIVE",
          createdAt: "2026-09-01T12:00:00.000Z",
          updatedAt: "2026-09-01T12:05:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    const updated = await api.updateProfile({ username: "newuser", displayName: "New User" });
    expect(updated.username).toBe("newuser");
    expect(fetchMock).toHaveBeenCalledWith(
      "/me/profile",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ username: "newuser", displayName: "New User" }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("starts eBay OAuth through the backend and never sends a client secret", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          authorizationUrl: "https://auth.sandbox.ebay.com/oauth2/authorize?client_id=public",
          expiresAt: "2026-09-01T17:10:00.000Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    const started = await api.startEbayConnect();
    expect(started.authorizationUrl).toContain("auth.sandbox.ebay.com");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret");
    expect(fetchMock).toHaveBeenCalledWith(
      "/me/marketplaces/ebay/connect",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });

  it("disconnects eBay without sending tokens", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 204, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    await api.disconnectEbay();
    expect(fetchMock).toHaveBeenCalledWith(
      "/me/marketplaces/ebay/disconnect",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret");
    vi.unstubAllGlobals();
  });

  it("lists and disconnects connected accounts without sending tokens", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/me/connected-accounts") && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            accounts: [
              {
                id: "cac_google",
                provider: "google",
                providerDisplay: "Google",
                externalAccountId: "sub-1",
                externalAccountName: "Collin",
                status: "CONNECTED",
                scopes: ["openid"],
                expiresAt: null,
                capabilities: {
                  identity: true,
                  transactions: false,
                  fulfillment: false,
                  shipping: false,
                  webhooks: false,
                },
                limitations: [],
                createdAt: "2026-09-02T12:00:00.000Z",
                updatedAt: "2026-09-02T12:00:00.000Z",
                disconnectedAt: null,
              },
            ],
            providers: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/me/connected-accounts/google/connect") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=public",
            expiresAt: "2026-09-02T15:00:00.000Z",
            provider: "google",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/me/connected-accounts/cac_google") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "token" });
    const listed = await api.listConnectedAccounts();
    expect(listed.accounts[0]?.provider).toBe("google");
    expect(JSON.stringify(listed)).not.toMatch(/access_token|refresh_token/i);
    const started = await api.startConnectedAccountConnect("google");
    expect(started.authorizationUrl).toContain("accounts.google.com");
    await api.disconnectConnectedAccount("cac_google");
    expect(fetchMock).toHaveBeenCalledWith(
      "/me/connected-accounts/cac_google",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret");
    vi.unstubAllGlobals();
  });
});
