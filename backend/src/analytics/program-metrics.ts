import { PROGRAM_SCHEMA_VERSION, deduplicate, enumValue, finiteNumber, record, reference, timestamp } from "./contracts.js";

const DAY = 86_400_000;
export const COST_CATEGORIES = ["original_storage", "replicas_versions_holds", "staging_abandoned", "derivatives", "storage_requests", "playback_export_transfer", "processing", "database", "provider_calls", "signing", "monitoring", "release_services", "support", "payment_processing", "other"] as const;
type Ref = string;
type DateValue = string | null;
export interface MerchantObservation {
  merchantRef: Ref; qualified: boolean; enrolledAt: DateValue; firstUseTestAt: DateValue;
  firstUsableAt: DateValue; assistedFirstProof: boolean | null; droppedOutAt: DateValue;
  paidDecisionAt: DateValue; firstPaidAt: DateValue; secondPeriodStart: DateValue;
  secondPeriodEnd: DateValue; secondPaidAt: DateValue;
}
export interface OrderObservation {
  orderRef: Ref; merchantRef: Ref; eligibleAt: string; eligible: boolean;
  exclusionReason: "unsupported_device" | "unsupported_workflow" | "not_consented" | "synthetic" | null;
  usableFinalizedAt: DateValue;
}
export interface UploadObservation {
  logicalAttemptRef: Ref; captureRef: Ref; merchantRef: Ref; startedAt: string;
  eligibility: "eligible" | "unsupported_workflow" | "not_consented" | "synthetic";
  committedAt: DateValue; durableReceiptAt: DateValue; cancelledAt: DateValue;
  offlineMs: number | null; outcome: "completed" | "failed" | "cancelled" | "pending" | "unknown";
}
export interface ReviewerObservation {
  taskRef: Ref; caseRef: Ref; reviewerRef: Ref; group: "ordinary" | "packproof";
  startedAt: string; completedAt: DateValue; uploadAccepted: boolean | null;
  checklistPassed: boolean | null; factsUnderstood: boolean | null;
  unsupportedConclusion: boolean | null; preparationSeconds: number | null;
}
export interface EffortObservation {
  taskRef: Ref; merchantRef: Ref; startedAt: string; completed: boolean;
  ordinaryActiveSeconds: number | null; packproofActiveSeconds: number | null;
  unattendedSeconds: number | null;
}
export interface SupportObservation {
  supportRef: Ref; merchantRef: Ref; occurredAt: string; phase: "onboarding" | "ongoing"; seconds: number;
}
export interface CostObservation {
  costRef: Ref; category: typeof COST_CATEGORIES[number]; scope: "fixed" | "variable" | "capacity_step" | "support";
  amountMinor: number | null; evidence: "actual" | "estimate" | "missing"; sourceRef: Ref | null;
}
export interface PaymentObservation {
  paymentRef: Ref; merchantRef: Ref; occurredAt: string; kind: "charge" | "refund";
  amountMinor: number; source: "verified_provider";
}
export interface ProgramInput {
  schemaVersion: typeof PROGRAM_SCHEMA_VERSION;
  evidenceClass: "synthetic" | "observed";
  period: { start: string; end: string; asOf: string };
  costPeriod: { start: string; end: string };
  billingReconciliation: { status: "unreconciled" | "reconciled"; sourceRef: Ref | null; unexplainedDifferenceMinor: number | null };
  currency: "USD";
  merchants: MerchantObservation[]; orders: OrderObservation[]; uploadIntents: UploadObservation[];
  reviewerTasks: ReviewerObservation[]; effortTasks: EffortObservation[]; support: SupportObservation[];
  costs: CostObservation[]; payments: PaymentObservation[];
}

type Field = "reference" | "date" | "boolean" | "number" | "integer" | readonly string[];
type Shape = Record<string, { type: Field; nullable?: boolean }>;
const f = (type: Field, nullable = false) => ({ type, nullable });
const shapes: Record<string, Shape> = {
  merchants: { merchantRef: f("reference"), qualified: f("boolean"), enrolledAt: f("date", true), firstUseTestAt: f("date", true), firstUsableAt: f("date", true), assistedFirstProof: f("boolean", true), droppedOutAt: f("date", true), paidDecisionAt: f("date", true), firstPaidAt: f("date", true), secondPeriodStart: f("date", true), secondPeriodEnd: f("date", true), secondPaidAt: f("date", true) },
  orders: { orderRef: f("reference"), merchantRef: f("reference"), eligibleAt: f("date"), eligible: f("boolean"), exclusionReason: f(["unsupported_device", "unsupported_workflow", "not_consented", "synthetic"], true), usableFinalizedAt: f("date", true) },
  uploadIntents: { logicalAttemptRef: f("reference"), captureRef: f("reference"), merchantRef: f("reference"), startedAt: f("date"), eligibility: f(["eligible", "unsupported_workflow", "not_consented", "synthetic"]), committedAt: f("date", true), durableReceiptAt: f("date", true), cancelledAt: f("date", true), offlineMs: f("integer", true), outcome: f(["completed", "failed", "cancelled", "pending", "unknown"]) },
  reviewerTasks: { taskRef: f("reference"), caseRef: f("reference"), reviewerRef: f("reference"), group: f(["ordinary", "packproof"]), startedAt: f("date"), completedAt: f("date", true), uploadAccepted: f("boolean", true), checklistPassed: f("boolean", true), factsUnderstood: f("boolean", true), unsupportedConclusion: f("boolean", true), preparationSeconds: f("number", true) },
  effortTasks: { taskRef: f("reference"), merchantRef: f("reference"), startedAt: f("date"), completed: f("boolean"), ordinaryActiveSeconds: f("number", true), packproofActiveSeconds: f("number", true), unattendedSeconds: f("number", true) },
  support: { supportRef: f("reference"), merchantRef: f("reference"), occurredAt: f("date"), phase: f(["onboarding", "ongoing"]), seconds: f("number") },
  costs: { costRef: f("reference"), category: f(COST_CATEGORIES), scope: f(["fixed", "variable", "capacity_step", "support"]), amountMinor: f("integer", true), evidence: f(["actual", "estimate", "missing"]), sourceRef: f("reference", true) },
  payments: { paymentRef: f("reference"), merchantRef: f("reference"), occurredAt: f("date"), kind: f(["charge", "refund"]), amountMinor: f("integer"), source: f(["verified_provider"]) },
};

/** Exported from the same field definitions as the runtime validator. */
export function programInputJsonSchema() {
  const dateSchema = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" };
  const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
  const arrays = Object.fromEntries(Object.entries(shapes).map(([name, shape]) => [name, {
    type: "array", maxItems: 100_000, items: object(Object.fromEntries(Object.entries(shape).map(([field, rule]) => {
      const base = Array.isArray(rule.type) ? { type: "string", enum: rule.type }
        : rule.type === "date" ? dateSchema : rule.type === "reference" ? { type: "string", pattern: "^pr_[a-f0-9]{32}$" }
          : rule.type === "boolean" ? { type: "boolean" } : { type: rule.type, minimum: 0 };
      return [field, rule.nullable ? { anyOf: [base, { type: "null" }] } : base];
    }))),
  }]));
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "urn:packproof:program:observations:v1",
    ...object({ schemaVersion: { const: PROGRAM_SCHEMA_VERSION }, evidenceClass: { enum: ["synthetic", "observed"] },
      period: object({ start: dateSchema, end: dateSchema, asOf: dateSchema }), costPeriod: object({ start: dateSchema, end: dateSchema }),
      billingReconciliation: object({ status: { enum: ["unreconciled", "reconciled"] }, sourceRef: { anyOf: [{ type: "string", pattern: "^pr_[a-f0-9]{32}$" }, { type: "null" }] }, unexplainedDifferenceMinor: { anyOf: [{ type: "integer" }, { type: "null" }] } }),
      currency: { const: "USD" }, ...arrays }) };
}

function validateRows(value: unknown, shape: Shape, path: string): void {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error(`INVALID_ARRAY:${path}`);
  value.forEach(item => {
    const row = record(item, Object.keys(shape), Object.keys(shape), path);
    for (const [key, rule] of Object.entries(shape)) {
      const entry = row[key];
      if (entry === null && rule.nullable) continue;
      const field = `${path}.${key}`;
      if (Array.isArray(rule.type)) enumValue(entry, rule.type, field);
      else if (rule.type === "reference") reference(entry, field);
      else if (rule.type === "date") timestamp(entry, field);
      else if (rule.type === "boolean") { if (typeof entry !== "boolean") throw new Error(`INVALID_BOOLEAN:${field}`); }
      else finiteNumber(entry, field, 0, rule.type === "integer");
    }
  });
}

export function validateProgramInput(value: unknown): ProgramInput {
  const keys = ["schemaVersion", "evidenceClass", "period", "costPeriod", "billingReconciliation", "currency", ...Object.keys(shapes)];
  const row = record(value, keys, keys, "report");
  if (row.schemaVersion !== PROGRAM_SCHEMA_VERSION) throw new Error("UNSUPPORTED_ANALYTICS_SCHEMA");
  enumValue(row.evidenceClass, ["synthetic", "observed"], "evidenceClass");
  enumValue(row.currency, ["USD"], "currency");
  const period = record(row.period, ["start", "end", "asOf"], ["start", "end", "asOf"], "period");
  for (const [key, date] of Object.entries(period)) timestamp(date, key);
  if (String(period.start) >= String(period.end) || String(period.asOf) < String(period.start)) throw new Error("INVALID_REPORT_PERIOD");
  const costPeriod = record(row.costPeriod, ["start", "end"], ["start", "end"], "costPeriod");
  for (const [key, date] of Object.entries(costPeriod)) timestamp(date, key);
  if (String(costPeriod.start) >= String(costPeriod.end)) throw new Error("INVALID_COST_PERIOD");
  const billing = record(row.billingReconciliation, ["status", "sourceRef", "unexplainedDifferenceMinor"], ["status", "sourceRef", "unexplainedDifferenceMinor"], "billingReconciliation");
  enumValue(billing.status, ["unreconciled", "reconciled"], "billingReconciliation.status");
  if (billing.sourceRef !== null) reference(billing.sourceRef, "billingReconciliation.sourceRef");
  if (billing.unexplainedDifferenceMinor !== null) finiteNumber(billing.unexplainedDifferenceMinor, "billingReconciliation.unexplainedDifferenceMinor", -Number.MAX_SAFE_INTEGER, true);
  if (billing.status === "reconciled" && (billing.sourceRef === null || billing.unexplainedDifferenceMinor === null)) throw new Error("RECONCILIATION_REQUIRES_SOURCE");
  for (const [key, shape] of Object.entries(shapes)) validateRows(row[key], shape, key);
  const input = row as unknown as ProgramInput;
  const merchantIds = new Set(input.merchants.map(item => item.merchantRef));
  for (const items of [input.orders, input.uploadIntents, input.effortTasks, input.support, input.payments]) {
    if (items.some(item => !merchantIds.has(item.merchantRef))) throw new Error("UNKNOWN_MERCHANT_REFERENCE");
  }
  const ordered = (before: DateValue, after: DateValue) => { if (before && after && before > after) throw new Error("INVALID_OBSERVATION_SEQUENCE"); };
  for (const merchant of input.merchants) {
    ordered(merchant.enrolledAt, merchant.firstUseTestAt); ordered(merchant.firstUseTestAt, merchant.firstUsableAt);
    ordered(merchant.enrolledAt, merchant.firstPaidAt); ordered(merchant.enrolledAt, merchant.droppedOutAt);
    ordered(merchant.secondPeriodStart, merchant.secondPeriodEnd);
    if (!!merchant.secondPeriodStart !== !!merchant.secondPeriodEnd || (merchant.secondPeriodStart && merchant.secondPeriodStart === merchant.secondPeriodEnd)) throw new Error("INVALID_SECOND_PERIOD");
  }
  for (const order of input.orders) {
    if (order.eligible === (order.exclusionReason !== null)) throw new Error("INVALID_ORDER_ELIGIBILITY");
    ordered(order.eligibleAt, order.usableFinalizedAt);
  }
  for (const intent of input.uploadIntents) {
    ordered(intent.startedAt, intent.committedAt); ordered(intent.startedAt, intent.cancelledAt);
    ordered(intent.committedAt, intent.durableReceiptAt);
    if (intent.durableReceiptAt && !intent.committedAt) throw new Error("RECEIPT_WITHOUT_COMMIT");
  }
  for (const task of input.reviewerTasks) ordered(task.startedAt, task.completedAt);
  for (const cost of input.costs) {
    if (cost.evidence === "actual" && (cost.sourceRef === null || cost.amountMinor === null)) throw new Error("ACTUAL_COST_REQUIRES_SOURCE");
    if (cost.evidence === "missing" && cost.amountMinor !== null) throw new Error("MISSING_COST_CANNOT_HAVE_AMOUNT");
    if (cost.category === "support" && cost.scope !== "support") throw new Error("INVALID_SUPPORT_COST_SCOPE");
  }
  return input;
}

type Gate = "pass" | "fail" | "insufficient_data";
interface Rate { numerator: number; denominator: number; missing: number; excluded: number; pendingWindow: number; value: number | null; target: number | null; gate: Gate; }
function rate(numerator: number, denominator: number, target: number | null, missing = 0, excluded = 0, pendingWindow = 0): Rate {
  const value = denominator === 0 ? null : numerator / denominator;
  return { numerator, denominator, missing, excluded, pendingWindow, value, target,
    gate: value === null || target === null || missing > 0 ? "insufficient_data" : value >= target ? "pass" : "fail" };
}
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function buildWeeklyReport(value: unknown) {
  const input = validateProgramInput(value);
  const merchants = deduplicate(input.merchants, row => row.merchantRef);
  const orders = deduplicate(input.orders, row => row.orderRef);
  const uploads = deduplicate(input.uploadIntents, row => row.logicalAttemptRef);
  // One capture is one logical attempt even when a transport retries with a new ID.
  if (new Set(uploads.map(row => row.captureRef)).size !== uploads.length) throw new Error("CAPTURE_ATTEMPT_ID_CHANGED");
  const reviewers = deduplicate(input.reviewerTasks, row => row.taskRef);
  const efforts = deduplicate(input.effortTasks, row => row.taskRef);
  const support = deduplicate(input.support, row => row.supportRef);
  const costs = deduplicate(input.costs, row => row.costRef);
  const payments = deduplicate(input.payments, row => row.paymentRef);
  const { start, end, asOf } = input.period;
  const observed = (date: DateValue): date is string => date !== null && date <= asOf;
  const inPeriod = (date: DateValue): date is string => observed(date) && date >= start && date < end;
  const newSellers = merchants.filter(row => inPeriod(row.firstUseTestAt));
  const periodOrders = orders.filter(row => inPeriod(row.eligibleAt));
  const eligibleOrders = periodOrders.filter(row => row.eligible);
  const active = new Set(orders.filter(row => row.eligible && inPeriod(row.usableFinalizedAt)).map(row => row.merchantRef));
  const activePaying = merchants.filter(row => active.has(row.merchantRef) && observed(row.firstPaidAt)).length;
  const periodUploads = uploads.filter(row => inPeriod(row.startedAt));
  const eligibleUploads = periodUploads.filter(row => row.eligibility === "eligible");
  const elapsedUploads = eligibleUploads.filter(row => Date.parse(row.startedAt) + DAY <= Date.parse(asOf));
  const onTime = (row: UploadObservation) => observed(row.durableReceiptAt) && Date.parse(row.durableReceiptAt) - Date.parse(row.startedAt) <= DAY;
  const enrolled = merchants.filter(row => row.qualified && observed(row.enrolledAt));
  const decided = enrolled.filter(row => observed(row.paidDecisionAt));
  const firstPayers = enrolled.filter(row => observed(row.firstPaidAt));
  const secondElapsed = firstPayers.filter(row => observed(row.secondPeriodEnd));
  const secondPaid = secondElapsed.filter(row => observed(row.secondPaidAt) && row.secondPaidAt >= row.secondPeriodStart! && row.secondPaidAt < row.secondPeriodEnd!);
  const secondUsed = secondElapsed.filter(merchant => orders.some(order => order.eligible && order.merchantRef === merchant.merchantRef
    && observed(order.usableFinalizedAt) && order.usableFinalizedAt >= merchant.secondPeriodStart! && order.usableFinalizedAt < merchant.secondPeriodEnd!));
  const thirdWeekMerchants = merchants.filter(row => row.enrolledAt && Date.parse(row.enrolledAt) + 21 * DAY <= Date.parse(asOf));
  const thirdWeekOrders = orders.filter(order => order.eligible && thirdWeekMerchants.some(merchant => merchant.merchantRef === order.merchantRef
    && Date.parse(order.eligibleAt) >= Date.parse(merchant.enrolledAt!) + 14 * DAY && Date.parse(order.eligibleAt) < Date.parse(merchant.enrolledAt!) + 21 * DAY));
  const comparisonTasks = reviewers.filter(row => inPeriod(row.startedAt));
  const enhancedTasks = comparisonTasks.filter(row => row.group === "packproof");
  const completedTasks = comparisonTasks.filter(row => observed(row.completedAt));
  const baseline = completedTasks.filter(row => row.group === "ordinary" && row.preparationSeconds !== null).map(row => row.preparationSeconds!);
  const enhanced = completedTasks.filter(row => row.group === "packproof" && row.preparationSeconds !== null).map(row => row.preparationSeconds!);
  const baselineMedian = quantile(baseline, 0.5); const enhancedMedian = quantile(enhanced, 0.5);
  const improvement = baselineMedian === null || baselineMedian <= 0 || enhancedMedian === null ? null : (baselineMedian - enhancedMedian) / baselineMedian;
  const preparationMissing = comparisonTasks.filter(row => !observed(row.completedAt) || row.preparationSeconds === null).length;
  const effortTasks = efforts.filter(row => inPeriod(row.startedAt));
  const pairedEffort = effortTasks.filter(row => row.completed && row.ordinaryActiveSeconds !== null && row.packproofActiveSeconds !== null)
    .map(row => row.packproofActiveSeconds! - row.ordinaryActiveSeconds!);
  const effortMedian = quantile(pairedEffort, 0.5); const effortP90 = quantile(pairedEffort, 0.9);
  const effortMissing = effortTasks.length - pairedEffort.length;
  const metrics = {
    unassistedActivation: rate(newSellers.filter(row => observed(row.firstUsableAt) && row.assistedFirstProof === false).length, newSellers.length, 0.8,
      newSellers.filter(row => row.assistedFirstProof === null).length),
    eligibleOrderCoverage: rate(eligibleOrders.filter(row => observed(row.usableFinalizedAt)).length, eligibleOrders.length, 0.8, 0, periodOrders.length - eligibleOrders.length),
    cohortWeekThreeCoverage: rate(thirdWeekOrders.filter(row => observed(row.usableFinalizedAt)).length, thirdWeekOrders.length, 0.8, 0, 0,
      merchants.filter(row => observed(row.enrolledAt) && Date.parse(row.enrolledAt) + 21 * DAY > Date.parse(asOf)).length),
    eventualCommitment: rate(elapsedUploads.filter(onTime).length, elapsedUploads.length, 0.99,
      elapsedUploads.filter(row => row.outcome === "unknown").length, periodUploads.length - eligibleUploads.length, eligibleUploads.length - elapsedUploads.length),
    allStartedCompletion: rate(periodUploads.filter(row => observed(row.durableReceiptAt)).length, periodUploads.length, null),
    reviewerCompleteness: rate(enhancedTasks.filter(row => observed(row.completedAt) && row.checklistPassed === true).length, enhancedTasks.length, 0.9,
      enhancedTasks.filter(row => row.checklistPassed === null).length),
    reviewerTechnicalAcceptance: rate(enhancedTasks.filter(row => row.uploadAccepted === true).length, enhancedTasks.length, null, enhancedTasks.filter(row => row.uploadAccepted === null).length),
    reviewerComprehension: rate(enhancedTasks.filter(row => observed(row.completedAt) && row.factsUnderstood === true).length, enhancedTasks.length, null,
      enhancedTasks.filter(row => row.factsUnderstood === null).length),
    paidContinuation: rate(decided.filter(row => observed(row.firstPaidAt)).length, decided.length, 0.5, 0, 0, enrolled.length - decided.length),
    secondPeriodPaymentRetention: rate(secondPaid.length, secondElapsed.length, null, 0, 0, firstPayers.length - secondElapsed.length),
    secondPeriodUseRetention: rate(secondUsed.length, secondElapsed.length, null, 0, 0, firstPayers.length - secondElapsed.length),
  };
  const periodSupport = support.filter(row => inPeriod(row.occurredAt));
  const supportMinutes = periodSupport.reduce((sum, row) => sum + row.seconds / 60, 0);
  const actualCosts = costs.filter(row => row.evidence === "actual");
  const missingCostCategories = COST_CATEGORIES.filter(category => !costs.some(row => row.category === category)
    || costs.some(row => row.category === category && row.evidence !== "actual"));
  const costWindowElapsed = input.costPeriod.end <= asOf;
  const costPayments = payments.filter(row => observed(row.occurredAt) && row.occurredAt >= input.costPeriod.start && row.occurredAt < input.costPeriod.end);
  const sumCost = (scopes: CostObservation["scope"][]) => actualCosts.filter(row => scopes.includes(row.scope)).reduce((sum, row) => sum + row.amountMinor!, 0);
  const netRevenueMinor = costPayments.reduce((sum, row) => sum + row.amountMinor * (row.kind === "charge" ? 1 : -1), 0);
  const knownVariableCostMinor = sumCost(["variable", "support"]);
  const completeCostEvidence = costWindowElapsed && missingCostCategories.length === 0
    && input.billingReconciliation.status === "reconciled" && input.billingReconciliation.unexplainedDifferenceMinor === 0;
  const contributionMinor = completeCostEvidence ? netRevenueMinor - knownVariableCostMinor : null;
  const infrastructureCostMinor = actualCosts.filter(row => !["support", "payment_processing", "release_services", "other"].includes(row.category))
    .reduce((sum, row) => sum + row.amountMinor!, 0);
  const addedEffortGate: Gate = effortMedian === null || effortP90 === null || effortMissing > 0 ? "insufficient_data" : effortMedian <= 20 && effortP90 <= 45 ? "pass" : "fail";
  const preparationGate: Gate = improvement === null || preparationMissing > 0 ? "insufficient_data" : improvement >= 0.3 ? "pass" : "fail";
  const nextActions: string[] = [];
  if (metrics.eventualCommitment.gate === "fail") nextActions.push("Pause expansion; repair admission, capture recovery and preservation (W03/W04/W11).");
  else if (metrics.eventualCommitment.gate === "pass") {
    if (metrics.cohortWeekThreeCoverage.gate === "fail" || addedEffortGate === "fail") nextActions.push("Simplify the packing workflow or retest the qualified segment (W07/W14).");
    else if (metrics.cohortWeekThreeCoverage.gate === "pass") {
      if (metrics.paidContinuation.gate === "fail") nextActions.push("Test value and the offer before acquiring more merchants (W13/W14).");
      else if (metrics.paidContinuation.gate === "pass") {
        if (metrics.reviewerCompleteness.gate === "fail" || preparationGate === "fail") nextActions.push("Repair recipient-compatible exports and reviewer handling (W08).");
        else if (metrics.reviewerCompleteness.gate === "pass" && preparationGate === "pass" && contributionMinor !== null && contributionMinor <= 0) nextActions.push("Repair measured cost or packaging before growth spending (W13).");
      }
    }
  }
  if (nextActions.length === 0) nextActions.push("Review remaining missing evidence and elapsed cohort windows; these thresholds alone do not authorize an expansion gate.");
  return {
    schemaVersion: PROGRAM_SCHEMA_VERSION, evidenceClass: input.evidenceClass, period: input.period, metrics,
    weeklyActiveMerchants: { count: active.size, paying: activePaying },
    cohort: { qualified: merchants.filter(row => row.qualified).length, enrolled: enrolled.length, dropouts: enrolled.filter(row => observed(row.droppedOutAt)).length,
      firstPayers: firstPayers.length, secondPeriodsElapsed: secondElapsed.length },
    uploadDiagnostics: { allStarted: periodUploads.length, eligible: eligibleUploads.length, cancelled: periodUploads.filter(row => observed(row.cancelledAt)).length,
      committedPendingDurability: periodUploads.filter(row => observed(row.committedAt) && !observed(row.durableReceiptAt)).length,
      completedAfter24Hours: periodUploads.filter(row => observed(row.durableReceiptAt) && !onTime(row)).length,
      offlineMs: periodUploads.reduce((sum, row) => sum + (row.offlineMs ?? 0), 0), offlineMissing: periodUploads.filter(row => row.offlineMs === null).length,
      exclusions: Object.fromEntries(["unsupported_workflow", "not_consented", "synthetic"].map(reason => [reason, periodUploads.filter(row => row.eligibility === reason).length])) },
    addedActiveEffort: { medianSeconds: effortMedian, p90Seconds: effortP90, completePairs: pairedEffort.length, allTasks: effortTasks.length,
      missingOrIncomplete: effortMissing, unattendedSeconds: effortTasks.reduce((sum, row) => sum + (row.unattendedSeconds ?? 0), 0), gate: addedEffortGate },
    preparationImprovement: { ordinaryMedianSeconds: baselineMedian, packproofMedianSeconds: enhancedMedian, value: improvement, target: 0.3,
      ordinaryTimedTasks: baseline.length, packproofTimedTasks: enhanced.length, allTasks: comparisonTasks.length, missingOrIncomplete: preparationMissing, gate: preparationGate },
    reviewerDiagnostics: { uniqueReviewers: new Set(comparisonTasks.map(row => row.reviewerRef)).size, uniqueCases: new Set(comparisonTasks.map(row => row.caseRef)).size,
      unsupportedConclusions: enhancedTasks.filter(row => row.unsupportedConclusion === true).length, unsupportedConclusionMissing: enhancedTasks.filter(row => row.unsupportedConclusion === null).length },
    support: { totalMinutes: supportMinutes, activeMerchants: active.size, minutesPerActiveMerchant: active.size ? supportMinutes / active.size : null,
      onboardingMinutes: periodSupport.filter(row => row.phase === "onboarding").reduce((sum, row) => sum + row.seconds / 60, 0),
      ongoingMinutes: periodSupport.filter(row => row.phase === "ongoing").reduce((sum, row) => sum + row.seconds / 60, 0),
      minutesForInactiveMerchants: periodSupport.filter(row => !active.has(row.merchantRef)).reduce((sum, row) => sum + row.seconds / 60, 0), trend: "requires_prior_comparable_period" },
    economics: { currency: input.currency, period: input.costPeriod, periodElapsed: costWindowElapsed, netRevenueMinor, knownVariableAndSupportCostMinor: knownVariableCostMinor,
      knownFixedCostMinor: sumCost(["fixed"]), knownCapacityStepCostMinor: sumCost(["capacity_step"]), missingCostCategories, contributionMinor,
      billingReconciliation: input.billingReconciliation, infrastructureCostMinor,
      infrastructureGrossMarginMinor: completeCostEvidence ? netRevenueMinor - infrastructureCostMinor : null,
      operatingResultMinor: contributionMinor === null ? null : contributionMinor - sumCost(["fixed", "capacity_step"]),
      reconciliation: "Provider source records and invoices must still be reconciled by the accountable operator; valid input is not proof of invoice completeness." },
    nextActions,
    limitations: [input.evidenceClass === "synthetic" ? "Synthetic fixtures: no customer, release, commercial or legal gate is satisfied." : "Submitted observations require accountable source review; the tool does not independently authenticate their origin.",
      "All rates retain failures; unelapsed windows, exclusions and missingness are explicit. A zero denominator is unknown, never 100%.",
      "Usable Proof assessments require the versioned issue checklist. A finalized status alone is insufficient.",
      "Small and repeated merchant/reviewer samples do not establish causal fraud reduction, statistical certainty or marketplace endorsement.",
      "Cost projections are not provider invoices; missing categories prevent a complete contribution result."],
  };
}

export type WeeklyReport = ReturnType<typeof buildWeeklyReport>;

export function renderWeeklyReport(report: WeeklyReport): string {
  const lines = [`# PackProof weekly decision report`, ``, `Evidence: **${report.evidenceClass}**. Period: ${report.period.start} to ${report.period.end} (end exclusive). As of: ${report.period.asOf}.`, ``,
    "| Measure | Numerator / denominator | Result | Missing | Excluded | Unelapsed | Starting gate |", "|---|---:|---:|---:|---:|---:|---|"];
  for (const [name, metric] of Object.entries(report.metrics)) lines.push(`| ${name} | ${metric.numerator} / ${metric.denominator} | ${metric.value === null ? "Unknown" : `${(metric.value * 100).toFixed(1)}%`} | ${metric.missing} | ${metric.excluded} | ${metric.pendingWindow} | ${metric.gate} |`);
  lines.push("", `Weekly active merchants: ${report.weeklyActiveMerchants.count}; paying: ${report.weeklyActiveMerchants.paying}. Dropouts retained: ${report.cohort.dropouts}.`, "",
    `Added active seconds: median ${report.addedActiveEffort.medianSeconds ?? "unknown"}; p90 ${report.addedActiveEffort.p90Seconds ?? "unknown"}; incomplete/missing tasks ${report.addedActiveEffort.missingOrIncomplete}.`, "",
    `Preparation improvement: ${report.preparationImprovement.value === null ? "unknown" : `${(report.preparationImprovement.value * 100).toFixed(1)}%`}; incomplete/missing tasks ${report.preparationImprovement.missingOrIncomplete}.`, "",
    `Support: ${report.support.totalMinutes.toFixed(1)} minutes; ongoing ${report.support.ongoingMinutes.toFixed(1)} minutes.`, "",
    `Contribution: ${report.economics.contributionMinor === null ? "unknown" : `${report.economics.currency} ${(report.economics.contributionMinor / 100).toFixed(2)}`}. Missing cost categories: ${report.economics.missingCostCategories.join(", ") || "none"}.`, "",
    ...report.nextActions.map(action => `- ${action}`), "", ...report.limitations.map(limitation => `- ${limitation}`), "");
  return lines.join("\n");
}
