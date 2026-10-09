import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { classifyProofPresentation } from "../../../backend/src/domain/proof-presentation";
import { mobileHomeState, mobileProofDestination } from "../mobile-task/task-state";
import { MobileHomeScreen } from "../mobile-task/MobileHomeScreen";
import { MobilePackScreen } from "../mobile-task/MobilePackScreen";
import { MobileNavigation } from "../mobile-task/MobileNavigation";
import { MobileActivityScreen } from "../mobile-task/MobileActivityScreen";
import { ApiError } from "../api/types";
import type { PackProofApi } from "../api/client";
import type { LocalRecordingSummary } from "../capture-queue";
import { summary, canonicalProof } from "./fixtures";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const draft = { ...summary, presentation: classifyProofPresentation(summary) };
const second = { ...draft, proofId: "second", transaction: { ...summary.transaction, itemTitle: "Second shipment" } };
const recording = (extra: Partial<LocalRecordingSummary> = {}): LocalRecordingSummary => ({ key: "capture", proofId: draft.proofId, kind: "station", file: new Blob(["fixture only"], { type: "video/webm" }), available: true, accepted: true, committed: false, finalized: false, preserved: false, ...extra });
const homeInput = () => ({ proofs: [draft, second], recordings: [], usable: new Set<string>(), queue: [], online: true, reconciled: true });
const homeProps = () => ({ ...homeInput(), loading: false, recordingsLoaded: true, error: null, refreshedAt: "2026-10-09T12:00:00Z", busy: false, notice: null, interactions: {}, onGo: vi.fn(), onRetry: vi.fn(), onAction: vi.fn(), onOpen: vi.fn() });

it("ranks verified usable saved evidence ahead of upload intervention and excludes corrupt or interrupted segments", () => {
  const saved = recording({ accepted: false });
  const input = { ...homeInput(), recordings: [saved, recording({ key: "failed", proofId: second.proofId, retryStopped: true })], usable: new Set([saved.key]) };
  expect(mobileHomeState(input).recommendation).toMatchObject({ kind: "review_evidence", targetId: draft.proofId, sessionId: saved.key });
  expect(mobileHomeState({ ...input, recordings: [{ ...saved, interrupted: true }] }).recommendation.kind).toBe("review_upload");
  expect(mobileHomeState({ ...input, usable: new Set() }).recommendation.kind).toBe("review_upload");
});
it("keeps healthy and automatically retrying jobs passive and counts failed Proofs once", () => {
  const healthy = mobileHomeState({ ...homeInput(), recordings: [recording({ active: true })] });
  expect(healthy.recommendation.targetId).toBe(second.proofId);
  expect(healthy.counts).toMatchObject({ attention: 1, uploading: 1 });
  const automatic = mobileHomeState({ ...homeInput(), recordings: [recording({ errorMessage: "Transient network error", retryScheduled: true })] });
  expect(automatic.recommendation.targetId).toBe(second.proofId);
  expect(automatic.counts.waiting).toBe(1);
  const failed = mobileHomeState({ ...homeInput(), proofs: [draft], recordings: [recording({ retryStopped: true }), recording({ key: "two", retryStopped: true })] });
  expect(failed.counts.attention).toBe(1);
});
it("keeps unauthorized local work and unknown statuses out of capture recommendations", () => {
  const buyer = { ...summary, role: "BUYER", presentation: classifyProofPresentation({ ...summary, role: "BUYER" }) };
  expect(mobileHomeState({ ...homeInput(), proofs: [buyer], recordings: [recording({ retryStopped: true })] }).recommendation.kind).toBe("create_proof");
  expect(mobileHomeState({ ...homeInput(), proofs: [{ ...summary, status: "UNRECOGNIZED" }] }).recommendation.kind).toBe("reconcile");
  expect(mobileHomeState({ ...homeInput(), proofs: [{ ...draft, status: "FINALIZED", finalizedAt: null }] }).counts.completed).toBe(0);
});
it("defers server actions offline while preserving local intervention", () => {
  expect(mobileHomeState({ ...homeInput(), online: false }).recommendation.kind).toBe("create_proof");
  expect(mobileHomeState({ ...homeInput(), online: false, recordings: [recording({ retryStopped: true })] }).recommendation.kind).toBe("review_upload");
});
it("routes finalized and noncontributor canonical records to view despite stale capture intent", () => {
  const complete = { ...canonicalProof, status: "FINALIZED", finalizedAt: "2026-10-09T12:00:00Z" };
  expect(mobileProofDestination(complete, "user_seller", recording())).toBe(`/proofs/${complete.proofId}`);
  expect(mobileProofDestination(canonicalProof, "unknown-user", recording())).toBe(`/proofs/${canonicalProof.proofId}`);
});
it("routes fresh capture, exact saved station review, commitment confirmation and upload recovery separately", () => {
  const ready = { ...canonicalProof, status: "READY_FOR_EVIDENCE", evidence: [], participationPolicy: "COUNTERPARTY_OPTIONAL" };
  expect(mobileProofDestination(ready, "user_seller")).toBe(`/proofs/${ready.proofId}/capture`);
  expect(mobileProofDestination(ready, "user_seller", recording({ accepted: false }))).toBe(`/proofs/${ready.proofId}/capture`);
  expect(mobileProofDestination(ready, "user_seller", recording())).toBe("/activity");
  const committed = { ...ready, status: "EVIDENCE_COMMITTED", evidence: [{ ...canonicalProof.evidence[0], evidenceType: "FULFILLMENT_CAPTURE", validationStatus: "COMMITTED" as const }] };
  expect(mobileProofDestination(committed, "user_seller")).toBe(`/proofs/${ready.proofId}/finalize`);
});
it("keeps an authorized receipt stage actionable while leaving its finalized root immutable", () => {
  const presentation = classifyProofPresentation({ ...summary, status: "FINALIZED", finalizedAt: "2026-10-09T12:00:00Z", pendingStage: { type: "RECEIPT", hasEvidence: false } });
  const completed = { ...draft, status: "FINALIZED", finalizedAt: "2026-10-09T12:00:00Z", presentation };
  expect(mobileHomeState({ ...homeInput(), proofs: [completed] }).recommendation.kind).toBe("continue_proof");
  expect(mobileProofDestination({ ...canonicalProof, ...completed, transaction: canonicalProof.transaction }, "user_seller")).toBe(`/receipt/${draft.proofId}`);
});
it("starts an empty account manually without a connection prerequisite and retains Create Proof beside recommendations", () => {
  const props = homeProps();
  const view = render(<MobileHomeScreen {...props} proofs={[]} />);
  expect(screen.getByRole("heading", { name: "Create your first Proof" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create Proof" }));
  expect(props.onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "create_proof" }));
  view.rerender(<MobileHomeScreen {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Create Proof" }));
  expect(props.onGo).toHaveBeenCalledWith("/new");
});
it("does not flash first-account copy while loading and labels cached completion after refresh failure", () => {
  const props = homeProps();
  const view = render(<MobileHomeScreen {...props} proofs={[]} loading refreshedAt={null} />);
  expect(screen.queryByRole("heading", { name: "Create your first Proof" })).not.toBeInTheDocument();
  expect(screen.getByText("Finding your next task…")).toBeInTheDocument();
  view.rerender(<MobileHomeScreen {...props} error="Cannot refresh" proofs={[{ ...draft, status: "FINALIZED", finalizedAt: "2026-10-09T10:00:00Z" }]} />);
  expect(screen.getByText(/Cached completion is not a new verification/)).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Workspace summary" })).getByRole("button", { name: /Completed/ })).toHaveTextContent("1");
});
it("keeps all four primary labels visible and secondary destinations in profile navigation", () => {
  Object.defineProperties(HTMLDialogElement.prototype, { close: { configurable: true, value() { this.removeAttribute("open"); } }, showModal: { configurable: true, value() { this.setAttribute("open", ""); } } });
  const session = { userId: "seller", displayName: "Seller", username: "seller", apiBaseUrl: "", authMode: "dev" as const, token: "test", refreshToken: null, accessExpiresAt: null, subject: "seller" };
  render(<MobileNavigation session={session} route="home" adminAllowed={false} onGo={vi.fn()} onSignOut={vi.fn()} />);
  expect(within(screen.getByRole("navigation", { name: "Primary navigation" })).getAllByRole("link").map(link => link.textContent)).toEqual(["Home", "Proofs", "Pack", "Activity"]);
  expect(screen.getByRole("button", { name: "Open profile menu" })).toBeInTheDocument();
});
it("empty Pack queue supports manual creation and unknown scans prefill only after a deliberate action", async () => {
  const api = { resolvePackingStation: vi.fn(async () => { throw new ApiError("STATION_REFERENCE_NOT_FOUND", "No matching shipment", 404); }) };
  const onCreate = vi.fn();
  render(<MobilePackScreen api={api as unknown as PackProofApi} queue={[]} loading={false} error={null} onRetry={vi.fn()} onGo={vi.fn()} onOpen={vi.fn()} onCreate={onCreate} />);
  fireEvent.click(screen.getByRole("button", { name: "Create new Proof" }));
  expect(onCreate).toHaveBeenCalledWith();
  fireEvent.change(screen.getByLabelText("Order or tracking reference"), { target: { value: "UNKNOWN-123" } });
  fireEvent.click(screen.getByRole("button", { name: "Find shipment" }));
  expect(await screen.findByRole("heading", { name: "No matching shipment" })).toBeInTheDocument();
  expect(onCreate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Create Proof with this reference" }));
  expect(onCreate).toHaveBeenLastCalledWith("UNKNOWN-123");
});
it("repeated lookup taps join one request and never create duplicate records", async () => {
  let resolve!: (value: unknown) => void;
  const api = { resolvePackingStation: vi.fn(() => new Promise(done => { resolve = done; })) };
  const onOpen = vi.fn();
  render(<MobilePackScreen api={api as unknown as PackProofApi} queue={[]} loading={false} error={null} onRetry={vi.fn()} onGo={vi.fn()} onOpen={onOpen} onCreate={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Order or tracking reference"), { target: { value: "KNOWN" } });
  const form = screen.getByLabelText("Order or tracking reference").closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(api.resolvePackingStation).toHaveBeenCalledTimes(1);
  resolve({ proofId: draft.proofId, itemSummary: "Shipment", orderLabel: "KNOWN" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue Proof" })).toBeInTheDocument());
  expect(onOpen).not.toHaveBeenCalled();
});
it("Activity separates commitment from finalization and exposes stopped upload retry", () => {
  const saved = recording({ committed: true, retryStopped: true });
  render(<MobileActivityScreen api={{} as PackProofApi} userId="seller" recordings={[saved]} recordingsLoaded invitations={[]} error={null} onRefresh={vi.fn()} onChange={vi.fn()} onOpen={vi.fn()} onInvitation={vi.fn()} onCreate={vi.fn()} />);
  expect(screen.getByText("Evidence committed · finalization pending")).toBeInTheDocument();
  expect(screen.queryByText("Proof finalized")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry confirmation" })).toBeInTheDocument();
});
