import assert from "node:assert/strict";
import test from "node:test";
import { committedRecordEvidence, initialProofRecordView, orderedRecordEvents, originalBookmarks, receiptAcknowledgment, recordActivityEvents, recordEventFilters, recordEvidenceKey, recordNextStepCopy, recordProofStatus } from "../src/copy/proof-record.ts";
import type { ReceiptRecordSummary } from "../src/copy/proof-record.ts";
import type { NextAction } from "../src/copy/next-action.ts";
import type { EvidenceAnchor } from "../src/signature.ts";
import type { ChronologyEntry, ProofView } from "../src/v2-api.ts";

const event = (id: string, category: string, occurredAt: string): ChronologyEntry => ({ id, category, occurredAt, title: id, description: null, source: "PACKPROOF", relatedEntityId: null, eventType: "PROOF_CREATED" });
const original: ProofView["evidence"][number] = { evidenceId: "ev1", evidenceType: "VIDEO", validationStatus: "COMMITTED", sha256: "abc", byteSize: 100, committedAt: "2026-09-01T00:00:00Z", contentType: "video/mp4" };
const bookmark = (anchorId: string, patch: Partial<EvidenceAnchor> = {}): EvidenceAnchor => ({ anchorId, proofId: "proof1", evidenceId: "ev1", sourceHash: "abc", sourceVersion: "sha256:abc", startMs: 4000, endMs: 5000, label: "Item shown", sourceType: "USER_MARKED", sourceCategory: "USER_MARKED_OBSERVATION", createdAt: "2026-09-01T00:00:00Z", ...patch });

test("timeline orders reported times without rewriting canonical events and keeps category counts", () => {
  const entries = [event("shipment", "SHIPMENT", "2026-09-02T00:00:00Z"), event("unknown", "PROOF", "invalid"), event("order", "COMMERCE", "2026-09-01T00:00:00Z"), event("capture", "PROOF", "2026-09-01T00:01:00Z")];
  assert.deepEqual(orderedRecordEvents(entries).map(item => item.id), ["order", "capture", "shipment", "unknown"]);
  assert.equal(entries[0].id, "shipment");
  assert.deepEqual(recordEventFilters(entries).map(item => [item.category, item.count]), [["ALL", 4], ["SHIPMENT", 1], ["PROOF", 2], ["COMMERCE", 1]]);
});

test("only valid bookmarks for the exact root original become replay chapters", () => {
  const anchors = [bookmark("good"), bookmark("early", { startMs: 0, endMs: 1000 }), bookmark("other-file", { evidenceId: "ev2" }), bookmark("stage", { stageId: "receipt1" }), bookmark("wrong-hash", { sourceHash: "other" }), bookmark("wrong-version", { sourceVersion: "sha256:other" }), bookmark("negative", { startMs: -1 }), bookmark("reversed", { startMs: 6000 }), bookmark("invalid", { startMs: NaN })];
  assert.deepEqual(originalBookmarks(original, anchors).map(item => item.anchorId), ["early", "good"]);
  assert.equal(originalBookmarks({ ...original, sha256: null }, anchors).length, 0);
});

test("corrections remove superseded chapters while preserving source history", () => {
  const anchors = [bookmark("first"), bookmark("second", { supersedesId: "first", label: "Corrected description" }), bookmark("third", { supersedesId: "second", label: "Final correction" })];
  assert.deepEqual(originalBookmarks(original, anchors).map(item => item.anchorId), ["third"]);
  assert.equal(anchors.length, 3);
});

test("receipt acknowledgment is derived from receipt stages, never carrier delivery or returns", () => {
  const record: ReceiptRecordSummary = { role: "BUYER", stages: [] };
  assert.equal(receiptAcknowledgment(null), "Not available");
  assert.equal(receiptAcknowledgment(record), "Not recorded");
  record.stages.push({ stageId: "return", type: "RETURN_PACKING", actorUserId: "buyer", finalizedAt: "2026-09-01T00:00:00Z", evidence: [] });
  assert.equal(receiptAcknowledgment(record), "Not recorded");
  record.stages.push({ stageId: "receipt", type: "RECEIPT", actorUserId: "buyer", finalizedAt: null, evidence: [{ evidenceId: "receipt-file", contentType: "video/mp4", committedAt: "2026-09-01T00:00:00Z" }] });
  assert.equal(receiptAcknowledgment(record), "Receipt recording saved · not finalized");
  record.stages[1].finalizedAt = "2026-09-01T00:01:00Z";
  assert.equal(receiptAcknowledgment(record), "Receipt recording finalized");
});

test("new proof view state starts independent tab offsets", () => {
  const first = initialProofRecordView(), second = initialProofRecordView();
  first.tab = "Timeline"; first.offsets.Timeline = 440;
  assert.equal(second.tab, "Evidence");
  assert.equal(second.timelineFilter, "MILESTONES");
  assert.deepEqual(second.offsets, { Evidence: 0, Timeline: 0, Tracking: 0, Receipt: 0 });
});

test("activity highlights keep shipment and evidence milestones while detailed history retains every access", () => {
  const entries = [
    { ...event("view", "PROOF", "2026-09-02T01:00:00Z"), eventType: "PROOF_ACCESSED" },
    { ...event("saved", "PROOF", "2026-09-01T01:00:00Z"), eventType: "EVIDENCE_COMMITTED" },
    { ...event("guest", "PROOF", "2026-09-02T02:00:00Z"), eventType: "PROOF_VIEWED_VIA_ACCESS_LINK" },
    { ...event("delivered", "SHIPMENT", "2026-09-02T00:00:00Z"), eventType: "DELIVERED" },
    { ...event("return", "PROOF", "2026-09-03T00:00:00Z"), eventType: "RETURN_PACKING_FINALIZED" },
  ];
  const snapshot = structuredClone(entries);
  assert.deepEqual(recordActivityEvents(entries).map(item => item.id), ["saved", "delivered", "return"]);
  assert.deepEqual(recordActivityEvents(entries, true).map(item => item.id), ["saved", "delivered", "view", "guest", "return"]);
  assert.deepEqual(entries, snapshot);
});

test("ordinary Proof finalization guidance cannot be overwritten by a stale server capture instruction", () => {
  const finalize: NextAction = { key: "finalize", label: "Finalize Proof", hint: "Review and seal", kind: "primary", enabled: true };
  const staleServer = { title: "Record packing", hint: "Record the item being packed and the package being sealed." };
  const copy = recordNextStepCopy(finalize, staleServer, false);
  assert.equal(copy.title, "Finalize Proof");
  assert.match(copy.hint, /recording is saved/);
  assert.doesNotMatch(copy.hint, /Record the item/);
  assert.deepEqual(recordNextStepCopy(finalize, staleServer, true), staleServer);
});

test("Proof completion labels reflect canonical state and do not expose internal enums", () => {
  assert.equal(recordProofStatus("READY_FOR_EVIDENCE"), "Recording needed");
  assert.equal(recordProofStatus("EVIDENCE_COMMITTED"), "Ready to finalize");
  assert.equal(recordProofStatus("FINALIZED"), "Proof finalized");
  assert.equal(recordProofStatus("UNKNOWN_STATE"), "In progress");
});

test("the same Proof includes committed receipt and return originals without mixing stage identities", () => {
  const proof: Pick<ProofView, "evidence" | "commerceStages"> = {
    evidence: [original, { ...original, evidenceId: "pending-root", validationStatus: "PENDING", sha256: null }],
    commerceStages: [{
      stageId: "receipt", type: "RECEIPT", actorUserId: "buyer", createdAt: "2026-09-02T00:00:00Z", finalizedAt: null, sha256: null,
      evidence: [
        { evidenceId: "ev1", contentType: "video/mp4", sha256: "abc", byteSize: "123", committedAt: "2026-09-02T00:00:00Z" },
        { evidenceId: "pending-stage", contentType: "video/mp4", sha256: null, byteSize: null, committedAt: null },
      ],
    }],
  };
  const snapshot = structuredClone(proof);
  const media = committedRecordEvidence(proof);
  assert.deepEqual(media.map(recordEvidenceKey), ["ev1", "receipt:ev1"]);
  assert.equal(media[1].stageId, "receipt");
  assert.equal(media[1].byteSize, 123);
  assert.equal(media[1].sha256, "abc");
  assert.equal(originalBookmarks(media[1], [bookmark("root-anchor")]).length, 0);
  assert.equal(originalBookmarks(media[0], [bookmark("root-anchor")]).length, 1);
  assert.deepEqual(proof, snapshot);
});
