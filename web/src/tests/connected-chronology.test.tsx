import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConnectedChronology, connectedEventIdentity, originalForChronologyEvent, originalIdentity } from "../components/ConnectedChronology";
import { WorkspaceProofRecord } from "../components/WorkspaceProofRecord";
import { canonicalProof } from "./fixtures";
import type { ChronologyEntry } from "../api/types";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const first: ChronologyEntry = { id: "event-a", occurredAt: "2026-10-24T12:10:00-04:00", category: "PROOF", title: "Packing recorded", description: "Original evidence committed", source: "PACKPROOF", relatedEntityId: "evd_1", eventType: "EVIDENCE_COMMITTED" };
const carrier: ChronologyEntry = { id: "event-b", occurredAt: "2026-10-24T12:20:00-04:00", category: "SHIPMENT", title: "Carrier scan reported", description: "Reported by carrier", source: "CARRIER_REPORTED", provider: "UPS", relatedEntityId: "shipment-b", eventType: "IN_TRANSIT" };

describe("connected source chronology", () => {
  it("keeps exact selected source identity while duplicate and earlier late events arrive", () => {
    const onSelect = vi.fn();
    const proof = { ...canonicalProof, chronology: [first, carrier] };
    const { rerender } = render(<ConnectedChronology proof={proof} selectedId={connectedEventIdentity(carrier)} onSelect={onSelect}/>);
    const selected = screen.getByRole("region", { name: `Source details: ${carrier.title}` });
    expect(within(selected).getByText(carrier.occurredAt)).toBeInTheDocument();
    const late = { ...first, id: "late-event", title: "Earlier observation", eventType: "OBSERVATION_ADDED", occurredAt: "2026-10-24T11:50:00-04:00" };
    rerender(<ConnectedChronology proof={{ ...proof, chronology: [first, carrier, carrier, late] }} selectedId={connectedEventIdentity(carrier)} onSelect={onSelect}/>);
    expect(screen.getByRole("region", { name: `Source details: ${carrier.title}` })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Carrier scan reported/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Earlier observation/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /1 new event/ }));
    fireEvent.click(screen.getByRole("button", { name: /Earlier observation/ }));
    expect(onSelect).toHaveBeenLastCalledWith(late);
  });

  it("distinguishes carrier-reported time and ingestion and keeps unknown source selection explicit", () => {
    const shipment = { id: "shipment-b", proofId: canonicalProof.proofId, transactionId: canonicalProof.transactionId, eventType: "IN_TRANSIT", occurredAt: carrier.occurredAt, observedAt: "2026-10-24T16:25:00Z", source: carrier.source, provider: "UPS", carrier: "UPS", location: null, eventData: {}, sha256: "aa", sourceEventId: "carrier-event-b" };
    const proof = { ...canonicalProof, chronology: [carrier], shipmentObservations: { shippingId: "shipping", identity: null, events: [shipment], latest: shipment } };
    const { rerender } = render(<ConnectedChronology proof={proof} selectedId={connectedEventIdentity(carrier)} onSelect={vi.fn()}/>);
    const inspector = screen.getByRole("region", { name: `Source details: ${carrier.title}` });
    expect(within(inspector).getByText("Source-reported time")).toBeInTheDocument();
    expect(within(inspector).getByText("Ingested by PackProof")).toBeInTheDocument();
    expect(within(inspector).getByText(shipment.observedAt)).toBeInTheDocument();
    expect(within(inspector).getByText(/did not independently observe/)).toBeInTheDocument();
    rerender(<ConnectedChronology proof={proof} selectedId="unavailable-event" onSelect={vi.fn()}/>);
    expect(screen.queryByRole("region", { name: /Source details/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("selected event is no longer available");
  });
});


it("shows the first chronology response as baseline and makes no preservation claim for pending uploads", () => {
  const pendingProof = { ...canonicalProof, chronology: [] as ChronologyEntry[], evidence: [{ ...canonicalProof.evidence[0], validationStatus: "PENDING", committedAt: null }] };
  const { rerender } = render(<ConnectedChronology proof={pendingProof} selectedId={null} onSelect={vi.fn()}/>);
  expect(screen.getByText("No source events available")).toBeInTheDocument();
  rerender(<ConnectedChronology proof={{ ...pendingProof, chronology: [first] }} selectedId={connectedEventIdentity(first)} onSelect={vi.fn()}/>);
  expect(screen.queryByRole("button", { name: /new event/ })).not.toBeInTheDocument();
  const inspector = screen.getByRole("region", { name: `Source details: ${first.title}` });
  expect(within(inspector).getByText("Associated evidence is not committed.")).toBeInTheDocument();
  expect(within(inspector).getByText(/No preservation or completed record is confirmed/)).toBeInTheDocument();
  expect(within(inspector).queryByText(/preserved as recorded|original available/i)).not.toBeInTheDocument();
});


it("preserves conflicting source/provider representations and restores only the exact selected identity", () => {
  const other = { ...carrier, source: "PARTICIPANT_SUPPLIED", provider: "Participant", title: "Different reported account", description: "Conflicting source representation" };
  const proof = { ...canonicalProof, chronology: [carrier, other, carrier] };
  const onSelect = vi.fn();
  const { rerender } = render(<ConnectedChronology proof={proof} selectedId={connectedEventIdentity(carrier)} onSelect={onSelect}/>);
  expect(screen.getByRole("button", { name: /Carrier scan reported/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /Different reported account/ })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: /Different reported account/ }));
  expect(onSelect).toHaveBeenLastCalledWith(other);
  rerender(<ConnectedChronology proof={{ ...proof, chronology: [other] }} selectedId={connectedEventIdentity(carrier)} onSelect={onSelect}/>);
  expect(screen.getByRole("status")).toHaveTextContent("selected event is no longer available");
  expect(screen.queryByRole("region", { name: /Source details/ })).not.toBeInTheDocument();
});

it("resolves backend audit identities to explicit originals and rejects mismatched/ambiguous associations", () => {
  const original = canonicalProof.evidence[0];
  const audit = { eventId: "audit-commit", eventType: "EVIDENCE_COMMITTED", actorUserId: "user_seller", at: first.occurredAt, data: { evidenceId: original.evidenceId, sha256: original.sha256 } };
  const entry = { ...first, id: audit.eventId, relatedEntityId: audit.eventId };
  const proof = { ...canonicalProof, events: [audit], chronology: [entry] };
  expect(originalForChronologyEvent(proof, entry)?.evidenceId).toBe(original.evidenceId);
  expect(originalForChronologyEvent(proof, { ...entry, occurredAt: "2026-10-24T15:00:00Z" })).toBeUndefined();
  expect(originalForChronologyEvent(proof, { ...entry, category: "SHIPMENT" })).toBeUndefined();
  expect(originalForChronologyEvent(proof, { ...entry, source: "PARTICIPANT_SUPPLIED", provider: "other-source" })).toBeUndefined();
  expect(originalForChronologyEvent({ ...proof, events: [{ ...audit, data: { evidenceId: original.evidenceId, sha256: "wrong" } }] }, entry)).toBeUndefined();
  expect(originalForChronologyEvent({ ...proof, events: [audit, audit] }, entry)).toBeUndefined();
  expect(originalForChronologyEvent({ ...proof, events: [{ ...audit, data: { evidenceId: "not-in-this-proof" } }] }, entry)).toBeUndefined();
  const stage = { stageId: "receipt-stage", type: "RECEIPT", finalizedAt: null, evidence: [{ evidenceId: original.evidenceId, contentType: "video/mp4", byteSize: 5, sha256: "stage-hash", committedAt: audit.at }] };
  const stageEntry = { ...entry, id: "audit-stage", relatedEntityId: "audit-stage", eventType: "LIFECYCLE_EVIDENCE_COMMITTED" };
  const stageAudit = { ...audit, eventId: stageEntry.id, eventType: stageEntry.eventType, data: { evidenceId: original.evidenceId, stageId: stage.stageId, sha256: "stage-hash" } };
  const stageProof = { ...proof, commerceStages: [stage], events: [stageAudit] };
  expect(originalIdentity(originalForChronologyEvent(stageProof, stageEntry)!)).toBe(`receipt-stage:${original.evidenceId}`);
  expect(originalForChronologyEvent({ ...stageProof, events: [{ ...stageAudit, data: { evidenceId: original.evidenceId } }] }, stageEntry)).toBeUndefined();
});

it("selecting an audit-linked source loads that exact original in the existing viewer", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => `blob:explicit-original`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
  sessionStorage.clear();
  const original = { ...canonicalProof.evidence[0], contentType: "video/mp4" };
  const second = { ...original, evidenceId: "evd_exact_second", sha256: "second-hash" };
  const audit = { eventId: "audit-exact-source", eventType: "EVIDENCE_COMMITTED", actorUserId: "user_seller", at: first.occurredAt, data: { evidenceId: second.evidenceId, sha256: second.sha256 } };
  const entry = { ...first, id: audit.eventId, relatedEntityId: audit.eventId, title: "Explicit second original" };
  const proof = { ...canonicalProof, evidence: [original, second], chronology: [entry], events: [audit] };
  const load = vi.fn(async (_id: string) => new Blob(["original"], { type: "video/mp4" }));
  render(<WorkspaceProofRecord proof={proof} currentUserId="user_seller" loadEvidence={load}/>);
  await screen.findByLabelText("Recorded packing evidence");
  expect(load).toHaveBeenLastCalledWith(original.evidenceId);
  const chronology = screen.getByRole("region", { name: "Connected source chronology" });
  fireEvent.click(within(chronology).getByRole("button", { expanded: false }));
  await waitFor(() => expect(load).toHaveBeenLastCalledWith(second.evidenceId));
  expect(screen.getByRole("region", { name: `Source details: ${entry.title}` })).toHaveTextContent("Linked committed original");
});
