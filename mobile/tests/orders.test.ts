import test from "node:test";
import assert from "node:assert/strict";
import { classifyOrders, matchesOrderQuery, orderChannelNotice, orderDestination, orderPresentation, type QueueOrder } from "../src/copy/orders.ts";

const queue = (proofId: string, changes: Partial<QueueOrder> = {}): QueueOrder => ({ proofId, proofStatus: "READY_FOR_EVIDENCE", workflowState: "READY_TO_PACK", evidenceCount: 0, pendingEvidenceCount: 0, ...changes });
const draft = (proofId: string, changes: Record<string, string> = {}) => ({ proofId, status: "READY_FOR_EVIDENCE", role: "SELLER", workflowType: "COMMERCE_SALE", ...changes });

test("cancelled or ineligible marketplace work cannot return as manual drafts", () => {
  const lists = classifyOrders({ allQueue: [queue("cancelled", { workflowState: "REMOVED_FROM_FULFILLMENT" }), queue("ready")], queueLoaded: true, proofs: [draft("cancelled"), draft("ready"), draft("manual")], pendingProofIds: [] });
  assert.deepEqual(lists.ready.map(item => item.proofId), ["ready"]);
  assert.deepEqual(lists.drafts.map(item => item.proofId), ["manual"]);
});
test("a failed initial queue request does not guess every Proof is a manual order", () => {
  assert.deepEqual(classifyOrders({ allQueue: [], queueLoaded: false, proofs: [draft("unknown-marketplace")], pendingProofIds: [] }).drafts, []);
});
test("pending journals appear once rather than again as ready rows or manual drafts", () => {
  const lists = classifyOrders({ allQueue: [queue("marketplace")], queueLoaded: true, proofs: [draft("manual")], pendingProofIds: ["marketplace", "manual"] });
  assert.deepEqual(lists, { ready: [], attention: [], drafts: [] });
});
test("committed and pending evidence have honest labels and viewer actions", () => {
  assert.deepEqual(orderPresentation(queue("in-progress", { workflowState: "IN_PROGRESS", evidenceCount: 1 })), { state: "attention", label: "Finish your Proof", action: "Open Proof" });
  assert.deepEqual(orderPresentation(queue("uploading", { pendingEvidenceCount: 1 })), { state: "attention", label: "Finish saving", action: "Open Proof" });
  assert.equal(orderPresentation(queue("new")).action, "Open camera preview");
});
test("authoritative finalization overrides stale queue state and a retained local original", () => {
  assert.equal(orderPresentation(queue("done", { proofStatus: "FINALIZED" })).state, "excluded");
  assert.deepEqual(classifyOrders({ allQueue: [queue("done")], queueLoaded: true, proofs: [draft("done", { status: "FINALIZED" })], pendingProofIds: [] }).ready, []);
  assert.equal(orderDestination({ proofStatus: "FINALIZED", seller: true, hasLocalCapture: true, committedEvidenceCount: 1 }), "proof");
});
test("grading remains a contextual workflow rather than ordinary packing", () => {
  assert.deepEqual(classifyOrders({ allQueue: [], queueLoaded: true, proofs: [draft("grading", { workflowType: "GRADING_SUBMISSION" })], pendingProofIds: [] }).drafts, []);
  assert.equal(orderDestination({ proofStatus: "READY_FOR_EVIDENCE", workflowType: "GRADING_SUBMISSION", seller: true, hasLocalCapture: false, committedEvidenceCount: 0 }), "proof");
});
test("only ready seller work or its unfinished local capture enters capture", () => {
  assert.equal(orderDestination({ proofStatus: "READY_FOR_EVIDENCE", seller: true, hasLocalCapture: false, committedEvidenceCount: 0 }), "capture");
  assert.equal(orderDestination({ proofStatus: "READY_FOR_EVIDENCE", seller: false, hasLocalCapture: false, committedEvidenceCount: 0 }), "proof");
  assert.equal(orderDestination({ proofStatus: "EVIDENCE_COMMITTED", seller: true, hasLocalCapture: false, committedEvidenceCount: 1 }), "proof");
});

test("Orders search matches titles, references, and tracking without case sensitivity", () => {
  assert.equal(matchesOrderQuery(" vintage ", ["Vintage camera", "order-123", "1Z999"]), true);
  assert.equal(matchesOrderQuery("order-123", ["Vintage camera", "order-123", "1Z999"]), true);
  assert.equal(matchesOrderQuery("1z999", ["Vintage camera", "order-123", "1Z999"]), true);
  assert.equal(matchesOrderQuery("unrelated", ["Vintage camera", "order-123", "1Z999"]), false);
});

test("successful queue reads do not hide failed or pending ingestion", () => {
  assert.equal(orderChannelNotice([{ providerDisplay: "eBay", status: "ACTIVE", sync: { runStatus: "FAILED" } }])?.kind, "error");
  assert.match(orderChannelNotice([{ providerDisplay: "Etsy", status: "NEEDS_REAUTH" }])!.message, /needs reconnecting/);
  assert.equal(orderChannelNotice([{ providerDisplay: "Etsy", status: "ACTIVE", lastErrorCode: "RATE_LIMIT", sync: { runStatus: "RETRYING" } }])?.kind, "waiting");
  assert.equal(orderChannelNotice([{ providerDisplay: "eBay", status: "ACTIVE", autoSyncEnabled: true, sync: { initialSyncCompletedAt: "2026-09-08T00:00:00Z" } }]), null);
});

import { normalizeRouteName, resolveBackRoute } from "../src/app/navigation.ts";

test("packing returns to its canonical Proof before the unified Proofs list, including retired queue origins", () => {
  for (const origin of ["home", "orders", "station"] as const) {
    assert.equal(resolveBackRoute("capture", origin), "proof");
    assert.equal(resolveBackRoute("proof", origin), "home");
    assert.equal(resolveBackRoute("create", origin), "home");
    assert.equal(resolveBackRoute("manual", origin), "home");
  }
});

test("retired batch and account destinations return to Proofs without a queue redirect loop", () => {
  assert.equal(resolveBackRoute("station", "station"), "home");
  for (const origin of ["home", "orders", "station"] as const) {
    assert.equal(resolveBackRoute("account", origin), "home");
  }
  for (const retired of ["tabs", "overview", "orders", "activity", "station"]) {
    assert.equal(normalizeRouteName(retired), "home");
    assert.equal(normalizeRouteName(normalizeRouteName(retired)), "home");
  }
});

test("Proof disclosure and legacy routes keep their prior destinations", () => {
  assert.equal(resolveBackRoute("capture", "home"), "proof");
  assert.equal(resolveBackRoute("event", "orders"), "proof");
  assert.equal(resolveBackRoute("sharing", "station"), "proof");
  assert.equal(resolveBackRoute("scan", "orders"), "create");
  assert.equal(resolveBackRoute("intake", "station"), "create");
  assert.equal(normalizeRouteName("tabs"), "home");
});
