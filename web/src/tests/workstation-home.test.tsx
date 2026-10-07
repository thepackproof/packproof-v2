import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeScreen } from "../screens/HomeScreen";
import { summary } from "./fixtures";

afterEach(cleanup);

const props = () => ({
  proofs: [summary], queue: [], connections: [], loading: false, error: null,
  onRetry: vi.fn(), onGo: vi.fn(), onOpenProof: vi.fn(), onOpenInvitation: vi.fn(), onOpenReceiver: vi.fn(),
});

it("uses canonical completion facts and leaves an unavailable upload count unknown", () => {
  render(<HomeScreen {...props()} proofs={[
    { ...summary, proofId: "unfinished", status: "FINALIZED", finalizedAt: null },
    { ...summary, proofId: "completed", status: "FINALIZED", finalizedAt: "2026-10-01T12:00:00Z" },
  ]} />);
  const metrics = screen.getByRole("region", { name: "Workspace summary" });
  expect(within(metrics).getByRole("button", { name: /Completed Proofs/ })).toHaveTextContent("Completed Proofs1");
  expect(within(metrics).getByRole("button", { name: /Pending uploads/ })).toHaveTextContent("Pending uploads—");
  expect(screen.getByRole("button", { name: "Review uploads" })).toBeInTheDocument();
  expect(screen.queryByText("Protected")).not.toBeInTheDocument();
});

it("keeps a failed workspace load distinct from empty collections and retries", async () => {
  const callbacks = props();
  render(<HomeScreen {...callbacks} proofs={[]} error="Network unavailable" />);
  expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable");
  expect(screen.queryByText("No Proofs yet")).not.toBeInTheDocument();
  expect(screen.queryByText("No orders in this view")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(callbacks.onRetry).toHaveBeenCalledOnce();
});

it("routes receiver records and workstation actions to their existing flows", async () => {
  const callbacks = props();
  render(<HomeScreen {...callbacks} pendingUploadCount={2} proofs={[
    { ...summary, accessKind: "RECEIVER", invitationId: "receipt:proof" },
  ]} />);
  await userEvent.click(screen.getByRole("button", { name: /Vintage camera. Invitation received/ }));
  expect(callbacks.onOpenReceiver).toHaveBeenCalledWith(summary.proofId);
  expect(callbacks.onOpenInvitation).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Open Packing Station" }));
  expect(callbacks.onGo).toHaveBeenLastCalledWith("/station");
  await userEvent.click(screen.getByRole("button", { name: /Ready to fulfill/ }));
  expect(callbacks.onGo).toHaveBeenLastCalledWith("/fulfillment");
  await userEvent.click(screen.getByRole("button", { name: "2 pending" }));
  expect(callbacks.onGo).toHaveBeenLastCalledWith("/uploads");
});
