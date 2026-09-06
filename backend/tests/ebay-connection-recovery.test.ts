import { describe, expect, it, vi } from "vitest";
import { createHttpEbayClient } from "../src/integrations/ebay/client.js";
import { createEbayConnectedAccountProvider } from "../src/integrations/connected-accounts/providers/ebay.js";
import type { EbayRuntime } from "../src/domain/ebay-marketplace.js";

const tokenInput = { environment: "sandbox" as const, clientId: "unit-client", clientSecret: "unit-secret", ruName: "unit-runame", code: "unit-code" };

describe("eBay connection recovery", () => {
  it.each(["sandbox", "production"] as const)("uses the identity-specific host in %s", async (environment) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ userId: "unit-user", username: "unit-seller" })));
    const client = createHttpEbayClient(fetcher as typeof fetch);
    await expect(client.getUser({ environment, accessToken: "unit-access-token" })).resolves.toMatchObject({ userId: "unit-user" });
    const host = environment === "sandbox" ? "apiz.sandbox.ebay.com" : "apiz.ebay.com";
    expect(fetcher.mock.calls[0][0]).toBe(`https://${host}/commerce/identity/v1/user/`);
  });

  it("keeps token exchange on api.sandbox and preserves the RuName and code", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 7200 })));
    await createHttpEbayClient(fetcher as typeof fetch).exchangeAuthorizationCode(tokenInput);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    const body = new URLSearchParams(fetcher.mock.calls[0][1].body);
    expect(body.get("redirect_uri")).toBe("unit-runame");
    expect(body.get("code")).toBe("unit-code");
  });

  it.each([["invalid_client", "EBAY_APPLICATION_NOT_CONFIGURED"], ["invalid_scope", "EBAY_SCOPE_NOT_AVAILABLE"]])(
    "distinguishes %s from a bad user password", async (error, code) => {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error }), { status: 400 }));
      await expect(createHttpEbayClient(fetcher as typeof fetch).exchangeAuthorizationCode(tokenInput)).rejects.toMatchObject({ code });
    },
  );

  function provider(material: Record<string, string> | null) {
    return createEbayConnectedAccountProvider({
      runtime: { enabled: true, environment: "sandbox", clientId: "unit-client", ruName: "unit-runame", appCredentialReference: "unit-ref", client: {} } as unknown as EbayRuntime,
      credentials: { getCredentials: async () => material ? { adapterKey: "ebay", credentialReference: "unit-ref", material } : null },
    });
  }

  it("rejects missing application credentials before returning an authorization URL", async () => {
    const p = provider(null);
    await expect(p.getAuthorizationUrl({ state: "unit-state" } as Parameters<typeof p.getAuthorizationUrl>[0])).rejects.toMatchObject({ code: "EBAY_APPLICATION_NOT_CONFIGURED" });
  });

  it("returns a correctly scoped sandbox consent URL when application credentials exist", async () => {
    const p = provider({ clientSecret: "unit-secret" });
    const result = await p.getAuthorizationUrl({ state: "unit-state" } as Parameters<typeof p.getAuthorizationUrl>[0]);
    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe("https://auth.sandbox.ebay.com");
    expect(url.searchParams.get("redirect_uri")).toBe("unit-runame");
    expect(url.searchParams.get("state")).toBe("unit-state");
    expect(url.searchParams.get("scope")).toContain("sell.fulfillment.readonly");
  });
});
