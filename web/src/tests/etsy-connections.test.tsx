import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectedAccountsPanel } from "../screens/ConnectedAccountsPanel";
import { ConnectedStoresScreen } from "../screens/ConnectedStoresScreen";
import type { CommerceConnectionView, ConnectedAccountProviderCatalogView, ConnectedAccountView } from "../api/types";
import { automaticIntakeStatus } from "@packproof/copy/commerce";

afterEach(cleanup);

const provider: ConnectedAccountProviderCatalogView = {
  provider: "etsy", providerDisplay: "Etsy", enabled: true,
  capabilities: { identity: true, transactions: true, fulfillment: true, shipping: false, webhooks: false },
  limitations: [], multipleAccounts: false, requiresShop: false,
};
const connection: CommerceConnectionView = {
  connectionId: "etsy_shop", adapterKey: "etsy", provider: "etsy", providerDisplay: "Etsy",
  externalAccountReference: "BennettVHS", status: "ACTIVE", lastSyncAt: null,
  lastErrorCode: null, retryable: null, readyOrderCount: 0, autoSyncEnabled: false,
};
function accountProps(accounts: ConnectedAccountView[] = []) {
  return { accounts, providers: [provider], notice: null, busy: false,
    onConnect: vi.fn(), onReauthorize: vi.fn(), onDisconnect: vi.fn() };
}
function storeProps(row = connection) {
  return { connections: [row], lastSync: null, loading: false, error: null,
    busy: false, development: false, ebay: null,
    onConnectEbay: vi.fn(), onDisconnectEbay: vi.fn(), onImportSales: vi.fn(),
    onAutomation: vi.fn(), onSync: vi.fn() };
}

describe("Etsy selling account and automatic intake", () => {
  it("connects the selling account without enabling automation implicitly", async () => {
    const props = accountProps();
    render(<ConnectedAccountsPanel {...props} />);
    expect(screen.getByText(/separate from PackProof sign-in/)).toBeInTheDocument();
    expect(props.onConnect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Connect Etsy" }));
    expect(props.onConnect).toHaveBeenCalledExactlyOnceWith("etsy", undefined);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("omits a never-connected unavailable provider without offering a broken connect action", () => {
    render(<ConnectedAccountsPanel {...accountProps()} providers={[{ ...provider, enabled: false }]} />);
    expect(screen.queryByText(/connection setup is pending|not enabled in this environment/)).not.toBeInTheDocument();
    expect(screen.getByText(/No sales channels are available/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Etsy" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Connected$/)).not.toBeInTheDocument();
  });

  it("reconnects or disconnects the existing Etsy identity", async () => {
    const props = accountProps([{
      id: "account_etsy", provider: "etsy", providerDisplay: "Etsy", externalAccountId: "shop_1",
      externalAccountName: "BennettVHS", status: "NEEDS_REAUTH", scopes: [], expiresAt: null,
      capabilities: provider.capabilities, limitations: [], createdAt: "2026-09-07T00:00:00Z",
      updatedAt: "2026-09-07T00:00:00Z", disconnectedAt: null,
    }]);
    render(<ConnectedAccountsPanel {...props} />);
    expect(screen.getByText("Reconnect required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Etsy" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(props.onReauthorize).toHaveBeenCalledExactlyOnceWith("account_etsy");
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(props.onDisconnect).toHaveBeenCalledExactlyOnceWith("account_etsy");
  });

  it("requires an explicit opt-in, explains the initial backlog and leaves completion to the seller", async () => {
    const props = storeProps();
    const { rerender } = render(<ConnectedStoresScreen {...props} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(props.onAutomation).not.toHaveBeenCalled();
    expect(screen.getByText(/existing paid, unshipped physical orders first/)).toHaveTextContent(/partially shipped orders are excluded/);
    expect(screen.getByText(/submit your attestation yourself/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(props.onAutomation).toHaveBeenCalledExactlyOnceWith("etsy_shop", true);
    // The control follows only the returned server state, not an optimistic local switch.
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    rerender(<ConnectedStoresScreen {...props} connections={[{ ...connection, autoSyncEnabled: true }]} />);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("Initial order check pending or in progress")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check for orders now" }));
    expect(props.onSync).toHaveBeenCalledExactlyOnceWith("etsy_shop");
  });

  it("blocks sync and enabling on an expired authorization but still permits pausing an existing opt-in", async () => {
    const props = storeProps({ ...connection, status: "NEEDS_REAUTH", autoSyncEnabled: true });
    const { rerender } = render(<ConnectedStoresScreen {...props} />);
    expect(screen.getByRole("button", { name: "Check for orders now" })).toBeDisabled();
    expect(screen.getByText(/Automatic orders are paused/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(props.onAutomation).toHaveBeenCalledExactlyOnceWith("etsy_shop", false);
    rerender(<ConnectedStoresScreen {...props} connections={[{ ...connection, status: "NEEDS_REAUTH" }]} />);
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it("does not label failed or retrying sync as successfully enabled", () => {
    expect(automaticIntakeStatus({ ...connection, autoSyncEnabled: true, sync: { runStatus: "FAILED", initialSyncCompletedAt: "2026-09-07T00:00:00Z" } })).toContain("needs attention");
    expect(automaticIntakeStatus({ ...connection, autoSyncEnabled: true, sync: { runStatus: "RETRYING" } })).toContain("will retry");
  });

  it("keeps complex-order review counts visible in Connections without offering a fabricated Proof action", () => {
    render(<ConnectedStoresScreen {...storeProps({ ...connection, reviewOrderCount: 3, reviewReasons: [{ code: "etsy_partial_shipment", count: 2 }, { code: "etsy_mixed_physical_and_digital_order", count: 1 }] })} />);
    expect(screen.getByText(/3 orders need review and are excluded from automatic Proof creation/)).toBeInTheDocument();
    expect(screen.getByText(/Partially shipped: 2/)).toHaveTextContent("Mixed physical and digital items: 1");
    expect(screen.queryByRole("button", { name: "Record packing" })).not.toBeInTheDocument();
    expect(screen.queryByText(/No orders are waiting/)).not.toBeInTheDocument();
  });
});
