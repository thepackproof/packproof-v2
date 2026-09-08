import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { groupRecordActivity, trackingAvailabilityMessage } from "../presentation/proof-record";
import { ShipmentTracking } from "../components/ShipmentTracking";
import { SharedProofRecord } from "../components/SharedProofRecord";
import { canonicalProof } from "./fixtures";

afterEach(() => { cleanup(); sessionStorage.clear(); });

it("keeps different actors, links and UTC windows separate and preserves every source ID", () => {
  const base = canonicalProof.chronology![0];
  const entries = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) => ({ ...base, id, occurredAt: index === 4 ? "2026-09-08T12:31:00Z" : "2026-09-08T12:02:00Z", eventType: "PROOF_VIEWED_VIA_ACCESS_LINK" }));
  const audit = entries.slice(0, 5).map(entry => ({ eventId: entry.id, at: entry.occurredAt, eventType: entry.eventType, actorUserId: entry.id === "c" ? "other-person" : "same-person", data: { accessLinkId: entry.id === "d" ? "other-link" : "same-link" } }));
  const groups = groupRecordActivity([...entries].reverse(), audit);
  expect(groups.map(group => group.entries.map(entry => entry.id))).toEqual([["a", "b"], ["c"], ["d"], ["f"], ["g"], ["e"]]);
  expect(groups.flatMap(group => group.entries.map(entry => entry.id)).sort()).toEqual(entries.map(entry => entry.id));
  expect(entries[0].id).toBe("a");
});

it("distinguishes absent labels, no carrier scan, delayed lookup, unsupported tracking and service failure", () => {
  expect(trackingAvailabilityMessage(null)).toContain("No tracking number");
  expect(trackingAvailabilityMessage("TRACK")).toBeNull();
  expect(trackingAvailabilityMessage("TRACK", { sync: { available: true, status: "RETRYING" } })).toContain("still being checked");
  expect(trackingAvailabilityMessage("TRACK", { registration: { state: "FAILED", errorCode: "UNSUPPORTED_CARRIER" } })).toContain("isn’t supported");
  expect(trackingAvailabilityMessage("TRACK", { refreshError: "bad gateway" })).toContain("temporarily unavailable");
  expect(trackingAvailabilityMessage("TRACK", { sync: { available: false, status: null } })).toContain("aren’t connected");
});

it("shows the current carrier status while viewing a historical scan and retains observations during an outage", async () => {
  const event = { id: "old", eventType: "IN_TRANSIT", occurredAt: "2026-09-08T10:00:00Z", location: "Cincinnati", provider: "UPS", source: "CARRIER_API", eventData: {} };
  render(<ShipmentTracking events={[event, { ...event, id: "new", eventType: "DELIVERED", occurredAt: "2026-09-08T12:00:00Z", location: "Columbus" }]} trackingNumber="TRACK" refreshError="timeout" />);
  await userEvent.click(screen.getByRole("button", { name: /In transit Cincinnati/ }));
  expect(document.querySelector(".tracking-status")).toHaveTextContent("Delivered");
  expect(screen.getByRole("status")).toHaveTextContent("temporarily unavailable");
  expect(screen.getByText("Selected observation")).toBeInTheDocument();
});

it("does not confuse redacted tracking with a missing shipping label", async () => {
  render(<SharedProofRecord proof={{ proofId: "scope", status: "FINALIZED", workflowType: "COMMERCE_SALE", workflowStage: "PACKING", scope: "SUMMARY", nextAction: null, join: { eligible: false, requiresAuthentication: true, message: "" }, disclosure: { viewHash: "authorized", scopeVersion: 1, revocationNotice: "", fields: ["order"] } }} />);
  await userEvent.click(screen.getByRole("tab", { name: "Tracking" }));
  const panel = screen.getByRole("tabpanel", { name: "Tracking" });
  expect(within(panel).getByText("Tracking details aren’t included in this link.")).toBeInTheDocument();
  expect(within(panel).queryByText(/No tracking number|Waiting for/)).not.toBeInTheDocument();
});

it("shows the participant declaration beside the matching original, with imported source attribution", async () => {
  const { WorkspaceProofRecord } = await import("../components/WorkspaceProofRecord");
  const proof = { ...canonicalProof, transaction: { ...canonicalProof.transaction, provenance: { source: "MARKETPLACE_API", provider: "etsy", adapterKey: "etsy", tenantKey: "tenant", externalTransactionId: "order", sourceRecordId: null, importedAt: "2026-09-08T12:00:00Z", payloadSha256: null, buyer: null } }, attestations: [{ kind: "ATTESTATION", attestationId: "statement", attestedBy: "user_seller", statement: "The item shown and attached in this Proof is the item I am shipping.", relatedEvidenceId: null, createdAt: "2026-09-08T12:01:00Z", digest: { algorithm: "SHA-256", sha256: "digest" } }] };
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:declaration" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  render(<WorkspaceProofRecord proof={proof} currentUserId="user_seller" loadEvidence={async () => new Blob(["evidence"], { type: "video/mp4" })} />);
  expect(await screen.findByText("The item shown and attached in this Proof is the item I am shipping.")).toBeInTheDocument();
  await userEvent.click(screen.getByText("Order details"));
  expect(screen.getByText("From Etsy. Imported order details are read-only.")).toBeVisible();
});

it("renders authorized public tracking health without requiring a disclosed tracking number", async () => {
  render(<SharedProofRecord proof={{ proofId: "public-updates", status: "FINALIZED", workflowType: "COMMERCE_SALE", workflowStage: "PACKING", scope: "EVIDENCE_VIEW", nextAction: null, join: { eligible: false, requiresAuthentication: true, message: "" }, recordTracking: { carrier: "UPS", status: "IN_TRANSIT", lastUpdatedAt: "2026-09-08T12:00:00Z", source: "SHIPPING_PROVIDER_API", syncState: "SERVICE_UNAVAILABLE", events: [{ id: "carrier-event", eventType: "IN_TRANSIT", occurredAt: "2026-09-08T10:00:00Z", source: "SHIPPING_PROVIDER_API", provider: "shippo" }] } }} />);
  await userEvent.click(screen.getByRole("tab", { name: "Tracking" }));
  expect(screen.getByRole("status")).toHaveTextContent("temporarily unavailable");
  expect(screen.getByText("shippo · SHIPPING_PROVIDER_API")).toBeInTheDocument();
  expect(screen.queryByText(/No tracking number/)).not.toBeInTheDocument();
});
