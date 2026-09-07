import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROGRAM_SCHEMA_VERSION, deduplicateProgramEvents, pseudonymizeReference, reconcileFinalizedProofUsage, type ProgramEvent } from "../src/analytics/contracts.js";
import { buildWeeklyReport, COST_CATEGORIES, programInputJsonSchema, renderWeeklyReport, type MerchantObservation, type ProgramInput, type UploadObservation } from "../src/analytics/program-metrics.js";
import { runWeeklyReportCli } from "../src/analytics/weekly-report-cli.js";

const ref = (number: number) => `pr_${number.toString(16).padStart(32, "0")}`;
const date = (day: number, hour = 0) => `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
function empty(): ProgramInput {
  return { schemaVersion: PROGRAM_SCHEMA_VERSION, evidenceClass: "synthetic", period: { start: date(1), end: date(8), asOf: date(8) },
    costPeriod: { start: "2026-08-01T00:00:00.000Z", end: date(1) },
    billingReconciliation: { status: "unreconciled", sourceRef: null, unexplainedDifferenceMinor: null }, currency: "USD",
    merchants: [], orders: [], uploadIntents: [], reviewerTasks: [], effortTasks: [], support: [], costs: [], payments: [] };
}
function merchant(number = 1): MerchantObservation {
  return { merchantRef: ref(number), qualified: true, enrolledAt: "2026-08-10T00:00:00.000Z", firstUseTestAt: date(1), firstUsableAt: null,
    assistedFirstProof: false, droppedOutAt: null, paidDecisionAt: date(6), firstPaidAt: null, secondPeriodStart: null, secondPeriodEnd: null, secondPaidAt: null };
}
function upload(number: number, overrides: Partial<UploadObservation> = {}): UploadObservation {
  return { logicalAttemptRef: ref(100 + number), captureRef: ref(200 + number), merchantRef: ref(1), startedAt: date(1), eligibility: "eligible",
    committedAt: null, durableReceiptAt: null, cancelledAt: null, offlineMs: 0, outcome: "pending", ...overrides };
}
function event(overrides: Partial<ProgramEvent> = {}): ProgramEvent {
  return { schemaVersion: PROGRAM_SCHEMA_VERSION, eventRef: ref(1), tenantRef: ref(2), merchantRef: ref(3), subjectRef: ref(4), logicalAttemptRef: ref(5),
    eventName: "proof.finalized", occurredAt: date(1), authority: "server", deviceClass: "s24_ultra", channel: "ebay", outcome: "succeeded", ...overrides };
}

describe("program metrics preserve denominators and measurement windows", () => {
  it("returns unknown for zero observations and does not invent revenue or contribution", () => {
    const report = buildWeeklyReport(empty());
    for (const metric of Object.values(report.metrics)) expect(metric).toMatchObject({ numerator: 0, denominator: 0, value: null, gate: "insufficient_data" });
    expect(report.economics.contributionMinor).toBeNull();
    expect(report.economics.missingCostCategories).toEqual(COST_CATEGORIES);
    expect(renderWeeklyReport(report)).toContain("Synthetic fixtures");
  });

  it("counts failures, cancellations and dropouts while showing exclusions separately", () => {
    const input = empty(); input.merchants = [merchant(), { ...merchant(2), droppedOutAt: date(3) }];
    input.orders = [
      { orderRef: ref(10), merchantRef: ref(1), eligibleAt: date(1), eligible: true, exclusionReason: null, usableFinalizedAt: date(2) },
      { orderRef: ref(11), merchantRef: ref(2), eligibleAt: date(1), eligible: true, exclusionReason: null, usableFinalizedAt: null },
      { orderRef: ref(12), merchantRef: ref(2), eligibleAt: date(1), eligible: false, exclusionReason: "unsupported_device", usableFinalizedAt: null },
    ];
    input.uploadIntents = [upload(1, { committedAt: date(1, 1), durableReceiptAt: date(1, 2), outcome: "completed" }),
      upload(2, { cancelledAt: date(1, 1), outcome: "cancelled", offlineMs: 1000 }), upload(3, { outcome: "failed" }),
      upload(4, { eligibility: "unsupported_workflow", outcome: "failed" })];
    const report = buildWeeklyReport(input);
    expect(report.metrics.eligibleOrderCoverage).toMatchObject({ numerator: 1, denominator: 2, excluded: 1 });
    expect(report.metrics.eventualCommitment).toMatchObject({ numerator: 1, denominator: 3, excluded: 1, gate: "fail" });
    expect(report.metrics.allStartedCompletion).toMatchObject({ numerator: 1, denominator: 4 });
    expect(report.metrics.paidContinuation).toMatchObject({ numerator: 0, denominator: 2 });
    expect(report.cohort.dropouts).toBe(1); expect(report.uploadDiagnostics.cancelled).toBe(1);
    expect(report.nextActions[0]).toContain("Pause expansion");
  });

  it("uses durable receipts, exact 24-hour boundaries and excludes unelapsed windows", () => {
    const input = empty(); input.merchants = [merchant()];
    input.uploadIntents = [upload(1, { committedAt: date(1), durableReceiptAt: date(2), outcome: "completed" }),
      upload(2, { committedAt: date(1), durableReceiptAt: date(2, 1), outcome: "completed" }),
      upload(3, { committedAt: date(1), outcome: "pending" }),
      upload(4, { startedAt: date(7, 1), committedAt: date(7, 1), outcome: "pending" }),
      upload(5, { startedAt: date(8, 1), outcome: "pending" })];
    const report = buildWeeklyReport(input);
    expect(report.metrics.eventualCommitment).toMatchObject({ numerator: 1, denominator: 3, pendingWindow: 1 });
    expect(report.uploadDiagnostics).toMatchObject({ allStarted: 4, committedPendingDurability: 2, completedAfter24Hours: 1 });
  });

  it("never counts future preservation or payments as observations", () => {
    const input = empty(); input.merchants = [{ ...merchant(), firstPaidAt: date(9) }];
    input.uploadIntents = [upload(1, { committedAt: date(1), durableReceiptAt: date(9), outcome: "completed" })];
    const report = buildWeeklyReport(input);
    expect(report.metrics.eventualCommitment.numerator).toBe(0);
    expect(report.metrics.paidContinuation.numerator).toBe(0);
    expect(report.uploadDiagnostics.committedPendingDurability).toBe(1);
  });

  it("uses only elapsed second periods and reports payment and use separately", () => {
    const input = empty(); input.merchants = [
      { ...merchant(), firstUseTestAt: null, firstPaidAt: "2026-08-11T00:00:00.000Z", secondPeriodStart: date(1), secondPeriodEnd: date(7), secondPaidAt: date(1) },
      { ...merchant(2), firstUseTestAt: null, firstPaidAt: "2026-08-11T00:00:00.000Z", secondPeriodStart: date(1), secondPeriodEnd: date(9), secondPaidAt: date(1) },
    ];
    const report = buildWeeklyReport(input);
    expect(report.metrics.secondPeriodPaymentRetention).toMatchObject({ numerator: 1, denominator: 1, pendingWindow: 1 });
    expect(report.metrics.secondPeriodUseRetention).toMatchObject({ numerator: 0, denominator: 1, pendingWindow: 1 });
  });

  it("retains failed exports and incomplete timing tasks without a success-only improvement gate", () => {
    const input = empty(); input.merchants = [merchant()];
    input.reviewerTasks = [
      { taskRef: ref(10), caseRef: ref(20), reviewerRef: ref(30), group: "ordinary", startedAt: date(1), completedAt: date(1, 1), uploadAccepted: true, checklistPassed: true, factsUnderstood: true, unsupportedConclusion: false, preparationSeconds: 100 },
      { taskRef: ref(11), caseRef: ref(21), reviewerRef: ref(31), group: "packproof", startedAt: date(1), completedAt: date(1, 1), uploadAccepted: true, checklistPassed: true, factsUnderstood: true, unsupportedConclusion: false, preparationSeconds: 50 },
      { taskRef: ref(12), caseRef: ref(22), reviewerRef: ref(31), group: "packproof", startedAt: date(1), completedAt: null, uploadAccepted: false, checklistPassed: false, factsUnderstood: null, unsupportedConclusion: null, preparationSeconds: null },
    ];
    input.effortTasks = [
      { taskRef: ref(40), merchantRef: ref(1), startedAt: date(1), completed: true, ordinaryActiveSeconds: 60, packproofActiveSeconds: 75, unattendedSeconds: 200 },
      { taskRef: ref(41), merchantRef: ref(1), startedAt: date(1), completed: false, ordinaryActiveSeconds: 60, packproofActiveSeconds: null, unattendedSeconds: null },
    ];
    const report = buildWeeklyReport(input);
    expect(report.metrics.reviewerCompleteness).toMatchObject({ numerator: 1, denominator: 2, gate: "fail" });
    expect(report.preparationImprovement).toMatchObject({ value: 0.5, missingOrIncomplete: 1, gate: "insufficient_data" });
    expect(report.addedActiveEffort).toMatchObject({ medianSeconds: 15, missingOrIncomplete: 1, gate: "insufficient_data" });
  });

  it("deduplicates exact input rows, remains order-independent, and rejects changed facts", () => {
    const input = empty(); input.merchants = [merchant()]; const first = upload(1); const second = upload(2, { outcome: "failed" });
    input.uploadIntents = [first, second, first];
    const report = buildWeeklyReport(input);
    expect(buildWeeklyReport({ ...input, uploadIntents: [second, first] })).toEqual(report);
    expect(report.metrics.eventualCommitment.denominator).toBe(2);
    expect(() => buildWeeklyReport({ ...input, uploadIntents: [first, { ...first, outcome: "failed" }] })).toThrow("ANALYTICS_DEDUPLICATION_CONFLICT");
    expect(() => buildWeeklyReport({ ...input, uploadIntents: [first, { ...first, logicalAttemptRef: ref(900) }] })).toThrow("CAPTURE_ATTEMPT_ID_CHANGED");
  });

  it("requires actual complete reconciled costs before showing contribution", () => {
    const input = empty(); input.merchants = [merchant()];
    input.payments = [{ paymentRef: ref(500), merchantRef: ref(1), occurredAt: "2026-08-20T00:00:00.000Z", kind: "charge", amountMinor: 5000, source: "verified_provider" }];
    input.costs = COST_CATEGORIES.map((category, index) => ({ costRef: ref(600 + index), category, scope: category === "support" ? "support" : "variable",
      amountMinor: 10, evidence: "actual", sourceRef: ref(800 + index) }));
    expect(buildWeeklyReport(input).economics.contributionMinor).toBeNull();
    input.billingReconciliation = { status: "reconciled", sourceRef: ref(900), unexplainedDifferenceMinor: 0 };
    expect(buildWeeklyReport(input).economics.contributionMinor).toBe(5000 - COST_CATEGORIES.length * 10);
    input.billingReconciliation.unexplainedDifferenceMinor = 1;
    expect(buildWeeklyReport(input).economics.contributionMinor).toBeNull();
    input.billingReconciliation.unexplainedDifferenceMinor = 0; input.costs[0].evidence = "estimate";
    expect(buildWeeklyReport(input).economics).toMatchObject({ contributionMinor: null, missingCostCategories: ["original_storage"] });
  });

  it("rejects personal fields, malformed identifiers, invalid dates, missing bindings and impossible states", () => {
    const input = empty(); input.merchants = [merchant()];
    expect(() => buildWeeklyReport({ ...input, email: "private@example.invalid" })).toThrow("UNKNOWN_FIELD");
    expect(() => buildWeeklyReport({ ...input, merchants: [{ ...merchant(), name: "Private" }] })).toThrow("UNKNOWN_FIELD");
    expect(() => buildWeeklyReport({ ...input, merchants: [{ ...merchant(), merchantRef: "user_123" }] })).toThrow("INVALID_REFERENCE");
    expect(() => buildWeeklyReport({ ...input, period: { ...input.period, start: "2026-02-30T00:00:00.000Z" } })).toThrow("INVALID_TIMESTAMP");
    expect(() => buildWeeklyReport({ ...input, uploadIntents: [upload(1, { merchantRef: ref(900) })] })).toThrow("UNKNOWN_MERCHANT_REFERENCE");
    expect(() => buildWeeklyReport({ ...input, uploadIntents: [upload(1, { durableReceiptAt: date(2) })] })).toThrow("RECEIPT_WITHOUT_COMMIT");
  });
});

describe("program event and usage contracts", () => {
  it("uses keyed namespace-isolated references without exposing source identifiers", () => {
    const key = "a".repeat(32);
    expect(pseudonymizeReference(key, "merchant", "secret-account")).toMatch(/^pr_[a-f0-9]{32}$/);
    expect(pseudonymizeReference(key, "merchant", "secret-account")).toBe(pseudonymizeReference(key, "merchant", "secret-account"));
    expect(pseudonymizeReference(key, "order", "secret-account")).not.toBe(pseudonymizeReference(key, "merchant", "secret-account"));
    expect(() => pseudonymizeReference("short", "order", "id")).toThrow("ANALYTICS_KEY_TOO_SHORT");
  });

  it("deduplicates durable server facts and refuses client authority or altered replay", () => {
    const first = event(); const repeated = event({ eventRef: ref(99) });
    expect(deduplicateProgramEvents([repeated, first, first])).toEqual([first]);
    expect(() => deduplicateProgramEvents([first, event({ eventRef: ref(99), occurredAt: date(2) })])).toThrow("ANALYTICS_DEDUPLICATION_CONFLICT");
    expect(() => deduplicateProgramEvents([event({ authority: "client" })])).toThrow("INVALID_EVENT_AUTHORITY");
    expect(() => deduplicateProgramEvents([{ ...first, statement: "private declaration" }])).toThrow("UNKNOWN_FIELD");
  });

  it("charges one durable finalized Proof once even if plan/period is changed on retry", () => {
    const usage = { schemaVersion: PROGRAM_SCHEMA_VERSION, tenantRef: ref(1), merchantRef: ref(2), proofRef: ref(3), durableFinalizationReceiptRef: ref(4),
      planVersion: "pilot.v1", periodStart: date(1), periodEnd: date(8), finalizedAt: date(2), units: 1 };
    expect(reconcileFinalizedProofUsage([usage, usage])).toEqual([usage]);
    expect(() => reconcileFinalizedProofUsage([usage, { ...usage, planVersion: "pilot.v2" }])).toThrow("ANALYTICS_DEDUPLICATION_CONFLICT");
    expect(() => reconcileFinalizedProofUsage([{ ...usage, durableFinalizationReceiptRef: null }])).toThrow("INVALID_REFERENCE");
    expect(() => reconcileFinalizedProofUsage([{ ...usage, finalizedAt: date(8) }])).toThrow("INVALID_USAGE_PERIOD");
  });
});

describe("weekly decision CLI", () => {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

  it("writes reviewable JSON and Markdown and retains the synthetic warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packproof-metrics-")); temporary.push(dir);
    const source = join(dir, "input.json"); const json = join(dir, "report.json"); const markdown = join(dir, "report.md");
    await writeFile(source, JSON.stringify(empty()));
    await runWeeklyReportCli(["--input", source, "--json", json, "--markdown", markdown]);
    expect(JSON.parse(await readFile(json, "utf8")).metrics.eventualCommitment.value).toBeNull();
    expect(await readFile(markdown, "utf8")).toContain("Synthetic fixtures");
    await expect(runWeeklyReportCli(["--input", source, "--json", source])).rejects.toThrow("OUTPUT_PATH_CONFLICT");
    await expect(runWeeklyReportCli(["--input", source, "--input", source])).rejects.toThrow("INVALID_CLI_ARGUMENTS");
  });

  it("exports the versioned schema from its runtime field definitions", async () => {
    const chunks: string[] = []; await runWeeklyReportCli(["--schema"], value => { chunks.push(value); });
    expect(JSON.parse(chunks.join(""))).toEqual(programInputJsonSchema());
    expect(programInputJsonSchema().additionalProperties).toBe(false);
  });
});
