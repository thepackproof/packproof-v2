/** Session-only UX aggregates. No record identifiers, payloads, persistence or transport. */
export const mobileUxEvents = [
  "recommendation_displayed", "recommendation_selected", "capture_entered",
  "capture_durably_saved", "review_completed", "upload_recovery", "upload_intervention", "commitment", "finalization",
  "draft_started", "draft_left_before_capture",
] as const;
export type MobileUxEvent = typeof mobileUxEvents[number];
export interface MobileUxMetric { count: number; totalDurationMs: number; durationSamples: number; maxDurationMs: number; }
let startedAt = Date.now();
const metrics = new Map<MobileUxEvent, MobileUxMetric>();
let captureEntryStartedAt: number | null = null;
let draftActive = false;

/** Begin a deliberate creation/packing action; consumed when the camera surface opens. */
export function startMobileCaptureEntry(): void { captureEntryStartedAt ??= Date.now(); }

/** Observable draft exits only: never infer abandonment from crashes, backgrounding or account changes. */
export function observeMobileDraftRoute(kind: "draft" | "capture" | "other"): void {
  if (kind === "draft") {
    if (!draftActive) { draftActive = true; recordMobileUxEvent("draft_started"); startMobileCaptureEntry(); }
    return;
  }
  if (kind === "capture") { draftActive = false; return; }
  if (draftActive) recordMobileUxEvent("draft_left_before_capture");
  draftActive = false;
  captureEntryStartedAt = null;
}

/** Session event ratios, not unique-user conversion or a production performance baseline. */
export function readMobileUxIndicators() {
  const { events } = readMobileUxMetrics();
  return {
    meanTimeToCaptureEntryMs: events.capture_entered.durationSamples ? events.capture_entered.totalDurationMs / events.capture_entered.durationSamples : null,
    observedDraftExitRate: events.draft_started.count ? events.draft_left_before_capture.count / events.draft_started.count : null,
    uploadInterventionsPerReview: events.review_completed.count ? events.upload_intervention.count / events.review_completed.count : null,
    completedFinalizations: events.finalization.count,
  };
}

export function recordMobileUxEvent(name: MobileUxEvent, input?: { durationMs?: number }): void {
  // Runtime validation also excludes unexpected event strings supplied by external input.
  if (!mobileUxEvents.includes(name)) return;
  const previous = metrics.get(name) ?? { count: 0, totalDurationMs: 0, durationSamples: 0, maxDurationMs: 0 };
  const duration = input?.durationMs ?? (name === "capture_entered" && captureEntryStartedAt != null ? Date.now() - captureEntryStartedAt : undefined);
  if (name === "capture_entered") captureEntryStartedAt = null;
  const valid = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && duration <= 86_400_000;
  metrics.set(name, {
    count: Math.min(Number.MAX_SAFE_INTEGER, previous.count + 1),
    totalDurationMs: valid ? Math.min(Number.MAX_SAFE_INTEGER, previous.totalDurationMs + duration) : previous.totalDurationMs,
    durationSamples: valid ? Math.min(Number.MAX_SAFE_INTEGER, previous.durationSamples + 1) : previous.durationSamples,
    maxDurationMs: valid ? Math.max(previous.maxDurationMs, duration) : previous.maxDurationMs,
  });
}

export function readMobileUxMetrics(): { startedAt: number; events: Record<MobileUxEvent, MobileUxMetric> } {
  return { startedAt, events: Object.fromEntries(mobileUxEvents.map(name => [name,
    { ...(metrics.get(name) ?? { count: 0, totalDurationMs: 0, durationSamples: 0, maxDurationMs: 0 }) },
  ])) as Record<MobileUxEvent, MobileUxMetric> };
}

/** Call when signing out or changing the active server/account. */
export function clearMobileUxMetrics(): void { metrics.clear(); captureEntryStartedAt = null; draftActive = false; startedAt = Date.now(); }
