import { test } from "node:test";
import assert from "node:assert/strict";
import { createShippingScanQueue, labelNeedsReview, shortenedTracking, type ShippingScanJournal } from "../src/capture/shipping-scan-queue";

test("encoded-frame source metadata and stable keys survive network loss without inventing a match", async () => {
  const journal: ShippingScanJournal = { proofId: "proof-a", sessionId: "cap_a", userId: "seller-a", entries: [] };
  let persisted: ShippingScanJournal | null = null;
  const scan = { rawValue: "1Z999AA10123456784", format: "code128", detectedAtMs: 4200,
    source: "ENCODED_VIDEO_FRAME" as const, coordinateSpace: "DECODED_VIDEO_PIXELS" as const,
    decoderVersion: "mlkit-barcode-17.2.0", frameWidth: 1280, frameHeight: 720,
    bounds: { left: 20, top: 40, right: 400, bottom: 260 }, idempotencyKey: "cap_a:frame:stable" };
  const queue = createShippingScanQueue({ journal, persist: async value => { persisted = value; }, bind: async () => { throw new Error("offline"); } });
  assert.equal((await queue.detect(scan)).status, "QUEUED");
  assert.deepEqual(journal.entries[0].scan, scan);
  assert.ok(persisted);
  let calls = 0;
  const resumed = createShippingScanQueue({ journal, persist: async () => {}, bind: async value => {
    calls += 1; assert.deepEqual(value, scan); return { status: "NEEDS_CONFIRMATION", observationId: "observed-a" };
  } });
  await resumed.retry(); assert.equal(calls, 1);
  assert.equal(journal.entries[0].result.status, "NEEDS_CONFIRMATION");
  await resumed.retry(); assert.equal(calls, 1);
});

test("a conflict remains reviewable; an attributed exclusion does not erase its observation", () => {
  const observed = { observationId: "observed-a", trackingNumber: "1Z999AA10123456784", carrierHint: "UPS",
    format: "code128", detectedAtMs: 4000, associated: false, resolution: null };
  assert.equal(labelNeedsReview(observed), true);
  assert.equal(labelNeedsReview({ ...observed, associated: true }), false);
  const resolved = { ...observed, resolution: { decision: "NOT_THIS_PACKAGE" as const, reason: "Another package label is visible", resolvedAt: "2026-09-08T00:00:00Z" } };
  assert.equal(labelNeedsReview(resolved), false);
  assert.equal(resolved.observationId, observed.observationId);
  assert.equal(resolved.trackingNumber, observed.trackingNumber);
  assert.equal(shortenedTracking(observed.trackingNumber), "…23456784");
});

test("product codes, URLs and hostile payloads never reach shipping storage or transport", async () => {
  let writes = 0, requests = 0;
  const queue = createShippingScanQueue({ journal: { proofId: "proof-a", sessionId: "cap_a", userId: "seller-a", entries: [] },
    persist: async () => { writes += 1; }, bind: async () => { requests += 1; return { status: "BOUND" }; } });
  for (const input of [{ rawValue: "https://evil.example/shipment", format: "qr" },
    { rawValue: "javascript:alert(1)", format: "qr" }, { rawValue: "123456789012", format: "UPC_A" }]) {
    assert.equal((await queue.detect({ ...input, detectedAtMs: 500, idempotencyKey: "hostile" })).status, "UNRECOGNIZED");
  }
  assert.equal(writes, 0); assert.equal(requests, 0);
});
