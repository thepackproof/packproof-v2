import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OrdersScreen, type OrdersScreenProps } from "../screens/OrdersScreen";
import { NotificationsScreen } from "../screens/NotificationsScreen";
import { UploadsScreen } from "../screens/UploadsScreen";
import type { FulfillmentQueueItem } from "../api/types";
import type { LocalRecordingSummary } from "../capture-queue";
import { fulfillmentItem, invitation } from "./fixtures";

afterEach(cleanup);

function orderProps(orders: FulfillmentQueueItem[]): OrdersScreenProps {
  return { orders, loading: false, error: null, onSync: vi.fn(), onRetry: vi.fn(), onOpenProof: vi.fn(), onOpenStation: vi.fn(), onOpenIntegrations: vi.fn(), onCreate: vi.fn() };
}

it("separates fulfillment, started and completed orders and routes packing to its existing Proof", () => {
  const started = { ...fulfillmentItem, proofId: "proof_started", externalReference: "STARTED", evidenceCount: 1, workflowState: "IN_PROGRESS" };
  const completed = { ...fulfillmentItem, proofId: "proof_done", externalReference: "DONE", proofStatus: "FINALIZED", workflowState: "COMPLETED" };
  const removed = { ...fulfillmentItem, proofId: "proof_removed", externalReference: "REMOVED", workflowState: "REMOVED_FROM_FULFILLMENT" };
  const props = orderProps([fulfillmentItem, started, completed, removed]);
  render(<OrdersScreen {...props} />);
  expect(screen.queryByRole("button", { name: "DONE" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "REMOVED" })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Record packing" })[0]);
  expect(props.onOpenStation).toHaveBeenCalledWith(fulfillmentItem.proofId);
  fireEvent.click(screen.getByRole("button", { name: "Proof started" }));
  expect(screen.getByRole("button", { name: "STARTED" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "DS-1001" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Completed" }));
  fireEvent.click(screen.getByRole("button", { name: "View Proof" }));
  expect(props.onOpenProof).toHaveBeenCalledWith("proof_done");
  fireEvent.click(screen.getByRole("button", { name: "All orders" }));
  expect(screen.getByRole("button", { name: "REMOVED" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Record packing" })).toHaveLength(2);
});

it("combines item search, marketplace and inclusive local dates without treating an unknown date as a match", () => {
  const orders = [
    { ...fulfillmentItem, proofId: "a", externalReference: "DAY-START", provider: "shopify", providerDisplay: "Shopify", itemSummary: "Vintage camera", orderedAt: "2026-10-07T00:00:00" },
    { ...fulfillmentItem, proofId: "b", externalReference: "DAY-END", provider: "shopify", providerDisplay: "Shopify", itemSummary: "Vintage camera", orderedAt: "2026-10-07T23:59:59" },
    { ...fulfillmentItem, proofId: "c", externalReference: "NEXT-DAY", provider: "shopify", providerDisplay: "Shopify", itemSummary: "Vintage camera", orderedAt: "2026-10-08T00:00:00" },
    { ...fulfillmentItem, proofId: "d", externalReference: "NO-DATE", provider: "shopify", providerDisplay: "Shopify", itemSummary: "Vintage camera", orderedAt: null },
    { ...fulfillmentItem, proofId: "e", externalReference: "OTHER-STORE", itemSummary: "Vintage camera", orderedAt: "2026-10-07T12:00:00" },
  ];
  render(<OrdersScreen {...orderProps(orders)} />);
  fireEvent.change(screen.getByLabelText("Search orders"), { target: { value: "CAMERA" } });
  fireEvent.change(screen.getByLabelText("Marketplace filter"), { target: { value: "shopify" } });
  fireEvent.change(screen.getByLabelText("Orders from date"), { target: { value: "2026-10-07" } });
  fireEvent.change(screen.getByLabelText("Orders through date"), { target: { value: "2026-10-07" } });
  expect(screen.getByRole("button", { name: "DAY-START" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "DAY-END" })).toBeInTheDocument();
  for (const name of ["NEXT-DAY", "NO-DATE", "OTHER-STORE"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search orders"), { target: { value: "missing item" } });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("button", { name: "NO-DATE" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "OTHER-STORE" })).toBeInTheDocument();
});

it("disables synchronization without an eligible connection and distinguishes a failed load from an empty order list", () => {
  const props = orderProps([]);
  const { rerender } = render(<OrdersScreen {...props} syncAvailable={false} />);
  expect(screen.getByRole("button", { name: "Sync" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Manage integrations" }));
  expect(props.onOpenIntegrations).toHaveBeenCalledOnce();
  rerender(<OrdersScreen {...props} error="The server is unavailable." />);
  expect(screen.queryByText("No orders in this view")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("The server is unavailable.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(props.onRetry).toHaveBeenCalledOnce();
});

it("opens the actual invitation without accepting it from the notification list", () => {
  const onOpenInvitation = vi.fn();
  render(<NotificationsScreen invitations={[invitation]} loading={false} error={null} onRetry={vi.fn()} onOpenInvitation={onOpenInvitation} />);
  expect(screen.getByText("Vintage camera")).toBeInTheDocument();
  expect(screen.getByText(/Seller invited you/)).toBeInTheDocument();
  expect(onOpenInvitation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review invitation" }));
  expect(onOpenInvitation).toHaveBeenCalledWith(invitation.invitationId);
});

it("counts recordings pending until both preservation and finalization are confirmed", () => {
  const item: LocalRecordingSummary = { key: "recording", kind: "ordinary", file: new Blob(["local recording"]), proofId: "proof", preserved: false, finalized: false, accepted: true, committed: true };
  render(<UploadsScreen recordings={[item, { ...item, key: "submitted", submitted: true }, { ...item, key: "complete", preserved: true, finalized: true }]} recoveryPanel={<button>Existing recovery action</button>} onRefresh={vi.fn()} onOpenStation={vi.fn()} />);
  expect(screen.getByText("2 recordings pending")).toBeInTheDocument();
  expect(screen.getByText("3 saved originals")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Existing recovery action" })).toBeInTheDocument();
});

it("does not claim an empty recording queue when local storage could not be read", () => {
  render(<UploadsScreen recordings={[]} error="Browser storage is unavailable." onRefresh={vi.fn()} onOpenStation={vi.fn()} />);
  expect(screen.queryByText("0 recordings pending")).not.toBeInTheDocument();
  expect(screen.queryByText("No saved recordings in this browser")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Browser storage is unavailable.");
});
