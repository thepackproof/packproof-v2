import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SHOPIFY_AUTOMATIC_PROOFS_LABEL } from "@packproof/copy/commerce";
import { PackProofApi } from "../api/client";
import type { CommerceConnectionView, ConnectedAccountProviderCatalogView, ConnectedAccountView } from "../api/types";
import { ConnectedAccountsPanel } from "../screens/ConnectedAccountsPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const provider: ConnectedAccountProviderCatalogView = {
  provider: "shopify", providerDisplay: "Shopify", enabled: true,
  capabilities: { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: true },
  limitations: [], multipleAccounts: true, requiresShop: true,
};
const account: ConnectedAccountView = {
  id: "shopify_account", provider: "shopify", providerDisplay: "Shopify", externalAccountId: "collectibles.myshopify.com",
  externalAccountName: "Collectibles", status: "CONNECTED", scopes: [], expiresAt: null,
  capabilities: provider.capabilities, limitations: [], createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z", disconnectedAt: null,
};
const connection: CommerceConnectionView = {
  connectionId: account.id, adapterKey: "shopify", provider: "shopify", providerDisplay: "Shopify",
  externalAccountReference: account.externalAccountId, status: "ACTIVE", lastSyncAt: null,
  lastErrorCode: null, retryable: null, readyOrderCount: 0, autoSyncEnabled: false,
};
function props() {
  return { accounts: [] as ConnectedAccountView[], providers: [provider], notice: null, busy: false,
    onConnect: vi.fn(), onReauthorize: vi.fn(), onDisconnect: vi.fn(), onAutomation: vi.fn(), onSync: vi.fn() };
}

describe("Shopify automatic Proof setup", () => {
  it("shows an enabled option and its scope before sending the seller's connection choice", async () => {
    const input = props();
    render(<ConnectedAccountsPanel {...input} />);
    expect(screen.getByRole("checkbox", { name: SHOPIFY_AUTOMATIC_PROOFS_LABEL })).toBeChecked();
    expect(screen.getByText(/Checks existing orders first/)).toHaveTextContent(/one Proof per order/);
    expect(screen.getByText(/normally the last 60 days/)).toHaveTextContent(/record the packing and submit your attestation/);
    expect(input.onConnect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect Shopify" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Shopify shop" }), "collectibles.myshopify.com");
    await userEvent.click(screen.getByRole("button", { name: "Connect Shopify" }));
    expect(input.onConnect).toHaveBeenCalledExactlyOnceWith("shopify", { shop: "collectibles.myshopify.com", autoSyncEnabled: true });
  });

  it("keeps an explicit opt-out when connecting", async () => {
    const input = props();
    render(<ConnectedAccountsPanel {...input} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Shopify shop" }), "collectibles.myshopify.com");
    await userEvent.click(screen.getByRole("checkbox", { name: SHOPIFY_AUTOMATIC_PROOFS_LABEL }));
    await userEvent.click(screen.getByRole("button", { name: "Connect Shopify" }));
    expect(input.onConnect).toHaveBeenCalledExactlyOnceWith("shopify", { shop: "collectibles.myshopify.com", autoSyncEnabled: false });
  });

  it("preserves an existing store's saved automation setting and supports pause and resume", async () => {
    const input = props();
    // A single-account catalog hides the separate new-store option in this case.
    const existing = { ...input, accounts: [account], providers: [{ ...provider, multipleAccounts: false }], connections: [connection] };
    const { rerender } = render(<ConnectedAccountsPanel {...existing} />);
    expect(screen.getByRole("checkbox", { name: SHOPIFY_AUTOMATIC_PROOFS_LABEL })).not.toBeChecked();
    expect(input.onAutomation).not.toHaveBeenCalled();
    expect(input.onConnect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox", { name: SHOPIFY_AUTOMATIC_PROOFS_LABEL }));
    expect(input.onAutomation).toHaveBeenLastCalledWith(account.id, true);
    // Saved server state, not the new-store default, controls this checkbox.
    expect(screen.getByRole("checkbox", { name: SHOPIFY_AUTOMATIC_PROOFS_LABEL })).not.toBeChecked();
    rerender(<ConnectedAccountsPanel {...existing} connections={[{ ...connection, autoSyncEnabled: true }]} />);
    expect(screen.getByRole("checkbox", { name: SHOPIFY_AUTOMATIC_PROOFS_LABEL })).toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: SHOPIFY_AUTOMATIC_PROOFS_LABEL }));
    expect(input.onAutomation).toHaveBeenLastCalledWith(account.id, false);
  });

  it.each([true, false])("serializes the explicit automation choice %s through the authenticated API", async autoSyncEnabled => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authorizationUrl: "https://collectibles.myshopify.com/admin/oauth/authorize", provider: "shopify" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new PackProofApi({ baseUrl: "", getToken: () => "fixture-session" });
    await api.startConnectedAccountConnect("shopify", { shop: "collectibles.myshopify.com", autoSyncEnabled });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/me/connected-accounts/shopify/connect", expect.objectContaining({
      method: "POST", body: JSON.stringify({ shop: "collectibles.myshopify.com", autoSyncEnabled }),
    }));
  });
});
