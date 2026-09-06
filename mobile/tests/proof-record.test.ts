import assert from "node:assert/strict";
import test from "node:test";
import { initialProofRecordView, orderedRecordEvents, originalBookmarks, receiptAcknowledgment, recordEventFilters } from "../src/copy/proof-record.ts";
import type { ReceiptRecordSummary } from "../src/copy/proof-record.ts";
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
  assert.deepEqual(second.offsets, { Evidence: 0, Timeline: 0, Tracking: 0, Receipt: 0 });
});
