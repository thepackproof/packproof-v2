import test from "node:test";
import assert from "node:assert/strict";
import { activityGroup, activityRecordingUsable, type ActivityCaptureState } from "../src/experience/activity-model.ts";
import { resolveBackRoute, showsTabBar } from "../src/app/navigation.ts";

const capture = (phase: NonNullable<ActivityCaptureState["recovery"]>["phase"], submitRequested = true): ActivityCaptureState => ({ localFileAvailable: true, byteSize: 1024, durationMs: 1000, recovery: { phase, submitRequested } });

test("normal retries, byte transfer, preservation and finalization remain in progress", () => {
  for (const phase of ["UPLOAD_QUEUED", "UPLOADING", "BYTES_RECEIVED", "PRESERVATION_PENDING", "FINALIZATION_PENDING", "SUBMITTED"] as const) assert.equal(activityGroup(capture(phase)), "uploading");
  const retry = capture("UPLOAD_QUEUED");
  retry.recovery!.lastError = { code: "NETWORK", message: "Connection lost", retryable: true };
  assert.equal(activityGroup(retry), "uploading");
});

test("reviewable local work and blocked recovery require action but do not claim completion", () => {
  assert.equal(activityGroup(capture("LOCAL_ONLY", false)), "attention");
  for (const phase of ["NEEDS_ATTENTION", "NEEDS_SIGN_IN", "CONFIRMATION_NEEDED", "RECORDING"] as const) assert.equal(activityGroup(capture(phase)), "attention");
  const failed = capture("UPLOAD_QUEUED");
  failed.recovery!.lastError = { code: "ATTESTATION_REQUIRED", message: "Confirm shipping", retryable: false };
  assert.equal(activityGroup(failed), "attention");
});

test("missing originals, interrupted captures and unknown recovery stay actionable", () => {
  assert.equal(activityGroup({ ...capture("LOCAL_ONLY"), localFileAvailable: false }), "attention");
  assert.equal(activityGroup({ ...capture("RECORDING"), interrupted: true }), "attention");
  assert.equal(activityGroup({ ...capture("LOCAL_ONLY"), byteSize: 0 }), "attention");
  assert.equal(activityGroup({ ...capture("LOCAL_ONLY"), durationMs: null }), "attention");
  assert.equal(activityGroup({}), "attention");
});

test("validated completed media remains reviewable after an unexpected stop", () => {
  const recovered = { ...capture("LOCAL_ONLY", false), interrupted: true };
  assert.equal(activityRecordingUsable(recovered), true);
  assert.equal(activityGroup(recovered), "attention");
  assert.equal(activityRecordingUsable({ ...recovered, recovery: { phase: "RECORDING", submitRequested: false } }), false);
});

test("submission and finalization are separate milestones", () => {
  assert.equal(activityGroup(capture("SUBMITTED")), "uploading");
  assert.equal(activityGroup(capture("FINALIZATION_PENDING")), "uploading");
  assert.equal(activityGroup(capture("FINALIZED")), "completed");
});

test("persistent destinations do not compete with capture and return to Activity", () => {
  for (const name of ["home", "proofs", "station", "activity"] as const) assert.equal(showsTabBar({ name }), true);
  for (const name of ["capture", "scan", "finalize", "auth", "boot"] as const) assert.equal(showsTabBar({ name }), false);
  assert.equal(showsTabBar({ name: "station" }, true), false);
  assert.equal(resolveBackRoute("proof", "activity"), "activity");
  assert.equal(resolveBackRoute("scan", "station"), "station");
});
