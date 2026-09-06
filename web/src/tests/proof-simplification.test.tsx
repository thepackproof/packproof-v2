import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProofScreen } from "../screens/ProofScreen";
import { ProofTimeline } from "../components/ProofTimeline";
import { ShipmentTracking } from "../components/ShipmentTracking";
import { SharedProofRecord } from "../components/SharedProofRecord";
import { canonicalProof } from "./fixtures";

beforeEach(() => { sessionStorage.clear(); window.history.replaceState({}, "", "/proofs/simplified"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps finalization guidance consistent even when the server packing hint is stale", async () => {
  const onFinalize = vi.fn();
  const proof = { ...canonicalProof, status: "EVIDENCE_COMMITTED", nextAction: { type: "CAPTURE", title: "Record packing", hint: "Record the item being packed and the package being sealed." } };
  render(<ProofScreen proof={proof} currentUserId="user_seller" shipmentIntegrity={null} loading={false} busy={false} error={null} onOpenFinalize={onFinalize} />);
  expect(screen.queryByText("Record the item being packed and the package being sealed.")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Finalize Proof" }));
  expect(onFinalize).toHaveBeenCalledOnce();
});

it("keeps access history available without overwhelming the milestone timeline", async () => {
  const base = canonicalProof.chronology![0];
  render(<ProofTimeline entries={[base, { ...base, id: "access", eventType: "PROOF_VIEWED_VIA_ACCESS_LINK", title: "Proof accessed" }]} />);
  expect(screen.queryByText("Proof accessed")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "View access history" }));
  expect(screen.getByText("Proof accessed")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show milestones only" }));
  expect(screen.queryByText("Proof accessed")).not.toBeInTheDocument();
});

it("shows a single tracking empty state and keeps known shipment details", () => {
  render(<ShipmentTracking events={[]} carrier="UPS" trackingNumber="1Z123" />);
  expect(screen.getAllByText("Waiting for the first carrier update.")).toHaveLength(1);
  expect(screen.getByText("UPS")).toBeInTheDocument();
  expect(screen.getByText("1Z123")).toBeInTheDocument();
  expect(screen.queryByTitle(/Map/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Your journey|Ready for the next handoff|No shipment observations/)).not.toBeInTheDocument();
});

it("uses the same record tabs for shared Proofs and shows only recorded activity as completed", async () => {
  const proof = { proofId: "shared", status: "EVIDENCE_COMMITTED", workflowType: "COMMERCE_SALE", workflowStage: "PACKING", scope: "EVIDENCE_VIEW", nextAction: null, join: { eligible: false, requiresAuthentication: true, message: "" }, evidence: [], tracker: { itemTitle: "Camera", headline: "Recorded", milestones: [{ code: "PACKING_RECORDED", label: "Packing recorded", occurredAt: "2026-09-06T12:00:00Z" }, { code: "DELIVERED", label: "Carrier reported delivery", occurredAt: null }] } };
  render(<SharedProofRecord proof={proof} />);
  expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Recording", "Activity", "Tracking"]);
  await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
  const panel = screen.getByRole("tabpanel", { name: "Activity" });
  expect(within(panel).getByText("Packing recorded")).toBeInTheDocument();
  expect(within(panel).queryByText("Carrier reported delivery")).not.toBeInTheDocument();
});
