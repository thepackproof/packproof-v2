import assert from "node:assert/strict";
import { test } from "node:test";
import { canConfirmManualReview, manualReviewBinding } from "../src/experience/manual-review";

const review = {
  proofId: "proof-a", originalId: "capture-a:file-a", accountId: "seller-a", apiBaseUrl: "https://api.example.test",
  metadata: { itemTitle: "Game console", trackingNumber: null }, reviewRevision: 1,
};

test("manual review cannot submit with unchecked consent, pending checks, offline blocking, or a busy owner", () => {
  const binding = manualReviewBinding(review);
  const input = { acceptedBinding: null, currentBinding: binding, blocked: false, busy: false };
  assert.equal(canConfirmManualReview(input), false);
  assert.equal(canConfirmManualReview({ ...input, acceptedBinding: binding }), true);
  assert.equal(canConfirmManualReview({ ...input, acceptedBinding: binding, blocked: true }), false);
  assert.equal(canConfirmManualReview({ ...input, acceptedBinding: binding, busy: true }), false);
});

test("consent for another original, Proof, account, server, or metadata revision cannot enable confirmation", () => {
  const acceptedBinding = manualReviewBinding(review);
  for (const changed of [
    { ...review, proofId: "proof-b" },
    { ...review, originalId: "capture-b:file-b" },
    { ...review, accountId: "seller-b" },
    { ...review, apiBaseUrl: "https://other.example.test" },
    { ...review, metadata: { itemTitle: "Different item", trackingNumber: null } },
    { ...review, metadata: { itemTitle: "Game console", trackingNumber: "123456789" } },
    { ...review, reviewRevision: 2 },
  ]) {
    assert.equal(canConfirmManualReview({ acceptedBinding, currentBinding: manualReviewBinding(changed), blocked: false, busy: false }), false);
  }
});
