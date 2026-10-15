import assert from "node:assert/strict";
import { test } from "node:test";
import { recoveryPresentation as present, recordingRepresentedByTask, markNotificationAfterOpen } from "../src/experience/recovery-presentation";
import type { ActivityCaptureState } from "../src/experience/activity-model";

const capture = (phase: NonNullable<ActivityCaptureState["recovery"]>["phase"], submitRequested = true): ActivityCaptureState => ({
  localFileAvailable: true, byteSize: 2048, durationMs: 3000, recovery: { phase, submitRequested },
});
const online = { offline: false, active: false };

test("Proof task deduplication keeps every other original on the same Proof discoverable", () => {
  const first = { captureProofId: "proof-a", captureSessionId: "capture-first", uri: "file:///first.mp4" };
  const second = { ...first, captureSessionId: "capture-second", uri: "file:///second.mp4" };
  const tasks = [{ proofId: "proof-a", action: { sessionId: "capture-first" } }];
  assert.equal(recordingRepresentedByTask(first, tasks), true);
  assert.equal(recordingRepresentedByTask(second, tasks), false);
  assert.equal(recordingRepresentedByTask(second, [{ proofId: "proof-a", action: {} }]), false);
  assert.equal(recordingRepresentedByTask(first, [{ proofId: "other-proof", action: { sessionId: "capture-first" } }]), false);
});

test("failed or rejected notification navigation never marks the notification read", async () => {
  let reads = 0;
  assert.equal(await markNotificationAfterOpen(async () => false, async () => { reads++; }), false);
  await assert.rejects(markNotificationAfterOpen(async () => { throw new Error("Permission revoked"); }, async () => { reads++; }), /Permission revoked/);
  assert.equal(reads, 0);
});

test("successful notification navigation acknowledges once after opening", async () => {
  const events: string[] = [];
  assert.equal(await markNotificationAfterOpen(async () => { events.push("opened"); return true; }, async () => { events.push("read"); }), true);
  assert.deepEqual(events, ["opened", "read"]);
});

test("unsigned offline originals offer review without promising automatic submission", () => {
  const view = present(capture("LOCAL_ONLY", false), { ...online, offline: true });
  assert.equal(view.action, "resume");
  assert.equal(view.actionLabel, "Review recording");
  assert.match(view.message, /Not uploaded yet.*reconnect to securely confirm/);
  assert.doesNotMatch(view.message, /retry|automatically/);
});

test("only a live upload owns transfer progress; persisted uploading state stays queued", () => {
  assert.equal(present(capture("UPLOADING"), online).live, false);
  assert.equal(present(capture("UPLOADING"), online).title, "Waiting to upload");
  assert.equal(present(capture("UPLOADING"), { ...online, active: true }).live, true);
  assert.equal(present(capture("UPLOADING"), { offline: true, active: true }).live, false);
});

test("received bytes and submission never claim finalized or authorize cleanup", () => {
  for (const phase of ["BYTES_RECEIVED", "PRESERVATION_PENDING", "FINALIZATION_PENDING", "SUBMITTED"] as const) {
    const view = present(capture(phase), online);
    assert.notEqual(view.tone, "success");
    assert.doesNotMatch(view.title, /is finalized/);
  }
  assert.equal(present(capture("FINALIZED"), online).title, "Your Proof is finalized");
  assert.equal(present(capture("SUBMITTED"), online).actionLabel, "View Proof");
  assert.doesNotMatch(present({ ...capture("FINALIZED"), localFileAvailable: false }, online).message, /copy remains|original is kept/);
  assert.match(present({ ...capture("SUBMITTED"), localFileAvailable: false }, online).message, /original is unavailable/);
});

test("missing or incomplete originals expose recovery options without resume", () => {
  for (const original of [
    { ...capture("LOCAL_ONLY"), localFileAvailable: false },
    capture("RECORDING"),
    { ...capture("LOCAL_ONLY"), encodedInspection: { playable: false } },
    { ...capture("LOCAL_ONLY"), durationMs: 0 },
  ]) {
    const view = present(original, online);
    assert.equal(view.action, "details");
    assert.equal(view.tone, "error");
  }
});

test("a previously finalized root reconciles a different local original without claiming it accepted", () => {
  const original = capture("UPLOAD_QUEUED");
  const before = JSON.stringify(original);
  const view = present(original, { ...online, proofFinalized: true });
  assert.equal(view.actionLabel, "Check status");
  assert.equal(view.tone, "attention");
  assert.match(view.message, /local recording is kept/);
  assert.equal(JSON.stringify(original), before);
  assert.equal(present(original, { ...online, offline: true, proofFinalized: true }).action, "details");
});

test("receipt and return stages remain separate from an already-finalized root", () => {
  const stage = { ...capture("LOCAL_ONLY", false), captureStageId: "stage-a" };
  assert.equal(present(stage, { ...online, proofFinalized: true }).actionLabel, "Review recording");
  assert.equal(present({ ...capture("FINALIZATION_PENDING"), captureStageId: "stage-a" }, online).title, "Finishing this step");
});

test("scheduled retries stay passive while required confirmation is explicit", () => {
  const original = capture("UPLOAD_QUEUED");
  original.recovery!.lastError = { code: "NETWORK", message: "Connection lost", retryable: true };
  assert.equal(present(original, online).action, null);
  assert.equal(present(original, online).title, "Waiting to retry");
  assert.equal(present(capture("CONFIRMATION_NEEDED"), online).actionLabel, "Review confirmation");
});

test("discard pending never advertises a resume or completed local removal", () => {
  const view = present(capture("DISCARD_PENDING"), { ...online, offline: true });
  assert.equal(view.action, null);
  assert.match(view.message, /local original is kept/);
});
