import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountScreen } from "../screens/AccountScreen";
import { ThemeProvider } from "../theme/ThemeProvider";
import { PackProofApi } from "../api/client";
import { ConnectedAccountsPanel } from "../screens/ConnectedAccountsPanel";
import { ConnectedStoresScreen } from "../screens/ConnectedStoresScreen";
import { AccountDeletionRequestPanel, AccountDeletionScreen } from "../screens/AccountDeletionScreen";
import type { CommerceConnectionView, ConnectedAccountProviderCatalogView, ConnectedAccountView } from "../api/types";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const capabilities = { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: false };
const provider: ConnectedAccountProviderCatalogView = { provider: "etsy", providerDisplay: "Etsy", enabled: true, capabilities, limitations: [], multipleAccounts: false, requiresShop: false };
const account: ConnectedAccountView = { id: "store-1", provider: "etsy", providerDisplay: "Etsy", externalAccountId: "42", externalAccountName: "A real shop", status: "CONNECTED", scopes: [], expiresAt: null, capabilities, limitations: [], createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z", disconnectedAt: null };
const connection: CommerceConnectionView = { connectionId: "store-1", provider: "etsy", providerDisplay: "Etsy", adapterKey: "etsy", externalAccountReference: "42", status: "ACTIVE", autoSyncEnabled: false, lastSyncAt: null, lastErrorCode: null, retryable: null, readyOrderCount: 2 };
const emptyDeletion = { request: null, retentionNotice: "Evidence subject to applicable retention may remain." };
const receivedDeletion = { ...emptyDeletion, request: { requestId: "deletion-1", state: "REQUESTED", requestedAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" } };

function api() { return new PackProofApi({ baseUrl: "https://api.example.test", getToken: () => "test-token" }); }

describe("consolidated sales channels", () => {
  it("places identity, order health and persisted automation in one provider card", async () => {
    const onAutomation = vi.fn();
    const panel = <ConnectedAccountsPanel accounts={[account]} providers={[provider]} notice={null} busy={false} onConnect={vi.fn()} onReauthorize={vi.fn()} onDisconnect={vi.fn()} />;
    render(<ConnectedStoresScreen connectionPanel={panel} connections={[connection]} lastSync={null} loading={false} error={null} busy={false} development={false} ebay={null} onConnectDemo={vi.fn()} onConnectEbay={vi.fn()} onDisconnectEbay={vi.fn()} onImportSales={vi.fn()} onAutomation={onAutomation} onSync={vi.fn()} />);
    expect(screen.getAllByRole("article", { name: "Etsy" })).toHaveLength(1);
    const card = within(screen.getByRole("article", { name: "Etsy" }));
    expect(card.getByText("A real shop")).toBeInTheDocument();
    expect(card.getByText("2 orders ready to pack")).toBeInTheDocument();
    await userEvent.click(card.getByRole("checkbox", { name: "Automatically add orders" }));
    expect(onAutomation).toHaveBeenCalledExactlyOnceWith("store-1", true);
    expect(card.getByRole("checkbox")).not.toBeChecked();
  });

  it("retains an unhealthy existing provider and does not claim a failed sync is an empty account", () => {
    render(<ConnectedAccountsPanel accounts={[{ ...account, status: "NEEDS_REAUTH" }]} providers={[{ ...provider, enabled: false }]} connections={[{ ...connection, lastErrorCode: "UPSTREAM_UNAVAILABLE" }]} notice={null} busy={false} onConnect={vi.fn()} onReauthorize={vi.fn()} onDisconnect={vi.fn()} onAutomation={vi.fn()} onSync={vi.fn()} />);
    expect(screen.getByRole("article", { name: "Etsy" })).toBeInTheDocument();
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/latest order check could not finish/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.queryByText(/UPSTREAM_UNAVAILABLE|No commerce connections/)).not.toBeInTheDocument();
  });
});

describe("account deletion request", () => {
  it("provides a public explanation and sign-in action without anonymous submission", async () => {
    const onSignIn = vi.fn(); render(<AccountDeletionScreen onSignIn={onSignIn} />);
    expect(screen.getByText(/No deletion request is sent until/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in to request deletion" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("requires confirmation and renders only the authoritative request response", async () => {
    const client = api(); vi.spyOn(client, "getAccountDeletionRequest").mockResolvedValue(emptyDeletion);
    const submit = vi.spyOn(client, "requestAccountDeletion").mockResolvedValue(receivedDeletion);
    render(<AccountDeletionRequestPanel api={client} accountKey="user-a" />);
    const button = await screen.findByRole("button", { name: "Request account deletion" });
    expect(button).toBeDisabled(); expect(submit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox")); await userEvent.click(button);
    expect(await screen.findByText("Request received")).toBeInTheDocument();
    expect(submit).toHaveBeenCalledOnce(); expect(screen.queryByText("Account deleted")).not.toBeInTheDocument();
  });

  it("reconciles a lost submit response without repeating the request", async () => {
    const client = api(); vi.spyOn(client, "getAccountDeletionRequest").mockResolvedValueOnce(emptyDeletion).mockResolvedValueOnce(receivedDeletion);
    const submit = vi.spyOn(client, "requestAccountDeletion").mockRejectedValue(new Error("response lost"));
    render(<AccountDeletionRequestPanel api={client} accountKey="user-a" />);
    await screen.findByRole("checkbox"); await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Request account deletion" }));
    expect(await screen.findByText("Request received")).toBeInTheDocument(); expect(submit).toHaveBeenCalledOnce();
  });

  it("blocks another submission while the outcome is unknown until status can be checked", async () => {
    const client = api(); const read = vi.spyOn(client, "getAccountDeletionRequest").mockResolvedValueOnce(emptyDeletion).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(receivedDeletion);
    vi.spyOn(client, "requestAccountDeletion").mockRejectedValue(new Error("offline"));
    render(<AccountDeletionRequestPanel api={client} accountKey="user-a" />);
    await screen.findByRole("checkbox"); await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Request account deletion" }));
    await screen.findByText(/We could not confirm whether/);
    expect(screen.getByRole("button", { name: "Request account deletion" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Check request status" }));
    expect(await screen.findByText("Request received")).toBeInTheDocument(); expect(read).toHaveBeenCalledTimes(3);
  });

  it("uses authenticated endpoint calls and the fixed confirmation contract", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(emptyDeletion), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(receivedDeletion), { status: 200 }));
    const client = api(); await client.getAccountDeletionRequest(); await client.requestAccountDeletion();
    expect(fetch.mock.calls[0][0]).toBe("https://api.example.test/me/account-deletion-request");
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer test-token");
    expect(fetch.mock.calls[1][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ confirmation: "REQUEST_ACCOUNT_DELETION" });
  });

  it("does not show the prior user's request after account identity changes", async () => {
    const client = api(); vi.spyOn(client, "getAccountDeletionRequest").mockResolvedValueOnce(receivedDeletion).mockResolvedValueOnce(emptyDeletion);
    const { rerender } = render(<AccountDeletionRequestPanel api={client} accountKey="user-a" />);
    await screen.findByText("Request received"); rerender(<AccountDeletionRequestPanel api={client} accountKey="user-b" />);
    await waitFor(() => expect(screen.queryByText("Request received")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Request account deletion" })).toBeDisabled();
  });
});


describe("compact Account", () => {
  it("keeps profile controls contextual and offers one sales-channel entry", async () => {
    const props = {
      displayName: "A Seller", username: "seller", subject: "internal-subject-that-should-not-display",
      connections: [connection], connectedAccounts: [account], connectedProviders: [provider],
      connectedNotice: null, error: null, busy: false, displayNameInput: "A Seller", usernameInput: "seller",
      onDisplayNameChange: vi.fn(), onUsernameChange: vi.fn(), onSaveProfile: vi.fn(),
      onOpenStation: vi.fn(), onOpenStores: vi.fn(), onOpenFulfillment: vi.fn(), onOpenPrivacy: vi.fn(),
      onOpenTerms: vi.fn(), onConnectAccount: vi.fn(), onReauthorizeAccount: vi.fn(), onDisconnectAccount: vi.fn(),
      onBack: vi.fn(), onSignOut: vi.fn(),
    };
    const { rerender } = render(<ThemeProvider><AccountScreen {...props} /></ThemeProvider>);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Sales channels/ })).toHaveLength(1);
    expect(screen.queryByText(/internal-subject|Connected marketplaces|Packing Station/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Profile", { selector: "summary" }));
    expect(await screen.findByLabelText("Display name")).toHaveValue("A Seller");
    expect(screen.queryByRole("button", { name: "Save profile" })).not.toBeInTheDocument();
    rerender(<ThemeProvider><AccountScreen {...props} displayNameInput="Updated Seller" /></ThemeProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(props.onSaveProfile).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Sign out" })).not.toHaveClass("btn-danger");
  });
});
