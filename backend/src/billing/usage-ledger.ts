import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "../domain/errors.js";

const VERSION = "packproof.billing.v1";
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
function fail(code: string, message: string, status = 422): never { throw new DomainError(code, message, status); }
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OPAQUE.test(value)) fail("INVALID_BILLING_REFERENCE", "An opaque billing reference is required");
}
function date(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("INVALID_BILLING_DATE", "A UTC billing timestamp is required");
}
function integer(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("INVALID_BILLING_AMOUNT", "A bounded integer amount is required");
}
function strict(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_BILLING_INPUT", "Invalid billing input");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) fail("INVALID_BILLING_FIELDS", "Unsupported or missing billing fields");
  return row;
}

export interface OfferDefinition {
  schemaVersion: typeof VERSION;
  version: string;
  status: "draft" | "approved";
  currency: "USD";
  priceMinor: number | null;
  interval: "monthly" | "usage";
  includedFinalizedProofs: number;
  maxRecordingBytes: number;
  maxRecordingSeconds: number;
  retentionPolicyVersion: string;
  preservationStandard: "canonical-original-v1";
  supplements: "included_within_published_allowance";
  overage: "block_new_capture";
  approvedTermsReference: string | null;
}

export function validateOfferDefinition(value: unknown): OfferDefinition {
  const row = strict(value, ["schemaVersion", "version", "status", "currency", "priceMinor", "interval", "includedFinalizedProofs", "maxRecordingBytes", "maxRecordingSeconds", "retentionPolicyVersion", "preservationStandard", "supplements", "overage", "approvedTermsReference"]);
  if (row.schemaVersion !== VERSION || !["draft", "approved"].includes(String(row.status)) || row.currency !== "USD"
    || !["monthly", "usage"].includes(String(row.interval)) || row.preservationStandard !== "canonical-original-v1"
    || row.supplements !== "included_within_published_allowance" || row.overage !== "block_new_capture") fail("INVALID_BILLING_OFFER", "Unsupported offer definition");
  identifier(row.version); identifier(row.retentionPolicyVersion);
  for (const key of ["includedFinalizedProofs", "maxRecordingBytes", "maxRecordingSeconds"]) integer(row[key], 1);
  if (row.priceMinor !== null) integer(row.priceMinor);
  if (row.approvedTermsReference !== null) identifier(row.approvedTermsReference);
  if (row.status === "approved" && (row.priceMinor === null || row.approvedTermsReference === null)) fail("BILLING_OFFER_NOT_APPROVED", "A priced approved offer requires its terms approval reference", 409);
  if (row.status === "draft" && row.approvedTermsReference !== null) fail("INVALID_BILLING_OFFER", "A draft cannot claim approved terms");
  return row as unknown as OfferDefinition;
}

/** Internal configuration command. No public route may publish/approve pricing. */
export async function registerOfferVersion(db: Database, clock: Clock, value: unknown) {
  const offer = validateOfferDefinition(value); const digest = sha256Hex(canonicalize(offer));
  await db.query(`INSERT INTO billing_offer_versions(version,definition_json,sha256,approved_terms_reference,created_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(version) DO NOTHING`, [offer.version, JSON.stringify(offer), digest, offer.approvedTermsReference, clock.now().toISOString()]);
  const stored = (await db.query<{ sha256: string; definition_json: OfferDefinition }>("SELECT sha256,definition_json FROM billing_offer_versions WHERE version=$1", [offer.version])).rows[0];
  if (stored.sha256 !== digest) fail("BILLING_OFFER_VERSION_CONFLICT", "This offer version already records different terms", 409);
  return stored.definition_json;
}

/** Schedule only future consented terms: late reconciliation must never make an
 * already completed, previously unpriced recording retroactively chargeable.
 */
export async function scheduleApprovedOfferPeriod(db: Database, clock: Clock, input: {
  id: string; userId: string; offerVersion: string; start: string; end: string; consentReceiptReference: string;
}) {
  strict(input, ["id", "userId", "offerVersion", "start", "end", "consentReceiptReference"]);
  for (const field of [input.id, input.userId, input.offerVersion, input.consentReceiptReference]) identifier(field);
  date(input.start); date(input.end);
  if (input.start >= input.end) fail("INVALID_BILLING_PERIOD", "Offer period must have a positive duration");
  return db.transaction(async tx => {
    await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [input.userId]);
    const existing = (await tx.query<{ user_id: string; offer_version: string; period_start: string | Date; period_end: string | Date; consent_receipt_reference: string }>("SELECT * FROM billing_account_offer_periods WHERE id=$1", [input.id])).rows[0];
    if (existing) {
      if (existing.user_id !== input.userId || existing.offer_version !== input.offerVersion || new Date(existing.period_start).toISOString() !== input.start
        || new Date(existing.period_end).toISOString() !== input.end || existing.consent_receipt_reference !== input.consentReceiptReference) fail("BILLING_PERIOD_CONFLICT", "This period already records different consented terms", 409);
      return { id: input.id, replayed: true };
    }
    if (input.start < clock.now().toISOString()) fail("BILLING_RETROACTIVE_PERIOD_REJECTED", "New billing terms cannot be applied retroactively", 409);
    const offer = (await tx.query<{ definition_json: OfferDefinition }>("SELECT definition_json FROM billing_offer_versions WHERE version=$1 AND approved_terms_reference IS NOT NULL", [input.offerVersion])).rows[0];
    if (!offer || offer.definition_json.status !== "approved") fail("BILLING_OFFER_NOT_APPROVED", "This offer is not approved for enrollment", 409);
    const overlap = (await tx.query("SELECT 1 FROM billing_account_offer_periods WHERE user_id=$1 AND period_start < $3 AND period_end > $2", [input.userId, input.start, input.end])).rows[0];
    if (overlap) fail("BILLING_PERIOD_OVERLAP", "An offer already covers this billing period", 409);
    await tx.query(`INSERT INTO billing_account_offer_periods(id,user_id,offer_version,period_start,period_end,consent_receipt_reference,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.id, input.userId, input.offerVersion, input.start, input.end, input.consentReceiptReference, clock.now().toISOString()]);
    return { id: input.id, replayed: false };
  });
}

/** Bounded scheduled reconciliation, independent of visits to /me/usage.
 * Metering records a logical unit, never an invoice or a charge.
 */
export async function reconcileDurableFinalizedUsage(db: Database, clock: Clock, options: { limit?: number } = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail("INVALID_BILLING_BATCH", "Billing reconciliation batch must be between 1 and 1000");
  return db.transaction(async tx => {
    const candidates = (await tx.query<{ proof_id: string; user_id: string; operation_id: string; receipt_json: Record<string, unknown> }>(`
      SELECT p.id AS proof_id,pp.user_id,e.operation_id,d.receipt_json FROM proofs p
      JOIN proof_participants pp ON pp.proof_id=p.id AND pp.role='SELLER'
      JOIN recovery_events e ON e.proof_id=p.id AND e.kind='PROOF_FINALIZED' AND e.operation_id='finalize:'||p.id
      JOIN recovery_delivery d ON d.operation_id=e.operation_id AND d.state='DURABLE'
      WHERE p.status='FINALIZED' AND d.receipt_json IS NOT NULL
        AND d.receipt_json->>'operationId'=e.operation_id AND d.receipt_json->>'eventSha256'=e.sha256
        AND NOT EXISTS(SELECT 1 FROM billing_proof_usage u WHERE u.proof_id=p.id)
      ORDER BY p.finalized_at,p.id LIMIT $1 FOR UPDATE OF p SKIP LOCKED`, [limit])).rows;
    let recorded = 0;
    for (const candidate of candidates) {
      const preservedAt = candidate.receipt_json.preservedAt;
      date(preservedAt);
      // A future/invalid receipt is a preservation anomaly, not a chargeable unit.
      if (preservedAt > clock.now().toISOString()) fail("BILLING_RECEIPT_IN_FUTURE", "Finalization receipt time requires investigation", 409);
      const offer = (await tx.query<{ id: string }>(`SELECT p.id FROM billing_account_offer_periods p
        JOIN billing_offer_versions o ON o.version=p.offer_version AND o.approved_terms_reference IS NOT NULL
        WHERE p.user_id=$1 AND p.period_start <= $2 AND p.period_end > $2`, [candidate.user_id, preservedAt])).rows[0];
      const result = await tx.query(`INSERT INTO billing_proof_usage(proof_id,user_id,finalized_at,preservation_operation_id,receipt_sha256,offer_period_id,units,charge_eligible,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6,1,$7,$8) ON CONFLICT(proof_id) DO NOTHING`,
      [candidate.proof_id, candidate.user_id, preservedAt, candidate.operation_id, sha256Hex(canonicalize(candidate.receipt_json)), offer?.id ?? null, !!offer, clock.now().toISOString()]);
      recorded += result.rowCount;
    }
    return { inspected: candidates.length, recorded, automaticCharges: false, mayHaveMore: candidates.length === limit };
  });
}

/** Own-account read only. Retention, downloads and disclosure authorization never
 * consult subscription status or this remaining-new-capture allowance.
 */
export async function getAccountUsageSummary(db: Database, clock: Clock, userId: string, window?: { start: string; end: string }) {
  identifier(userId);
  const now = clock.now();
  const start = window?.start ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = window?.end ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  date(start); date(end);
  if (start >= end || Date.parse(end) - Date.parse(start) > 366 * 86_400_000) fail("INVALID_BILLING_WINDOW", "Choose a usage window of at most 366 days");
  const finalized = (await db.query<{ total: string | number; confirmed: string | number }>(`SELECT COUNT(*) AS total,
    COUNT(*) FILTER(WHERE d.state='DURABLE' AND d.receipt_json IS NOT NULL) AS confirmed
    FROM proofs p JOIN proof_participants pp ON pp.proof_id=p.id AND pp.user_id=$1 AND pp.role='SELLER'
    LEFT JOIN recovery_delivery d ON d.operation_id='finalize:'||p.id
    WHERE p.status='FINALIZED' AND p.finalized_at >= $2 AND p.finalized_at < $3`, [userId, start, end])).rows[0];
  const usage = (await db.query<{ total: string | number; charge_eligible: string | number }>(`SELECT COALESCE(SUM(units),0) AS total,
    COALESCE(SUM(units) FILTER(WHERE charge_eligible),0) AS charge_eligible FROM billing_proof_usage
    WHERE user_id=$1 AND finalized_at >= $2 AND finalized_at < $3`, [userId, start, end])).rows[0];
  const current = (await db.query<{ id: string; definition_json: OfferDefinition; period_start: Date | string; period_end: Date | string; used: number | string }>(`SELECT p.id,o.definition_json,p.period_start,p.period_end,
    (SELECT COALESCE(SUM(units),0) FROM billing_proof_usage u WHERE u.offer_period_id=p.id) AS used
    FROM billing_account_offer_periods p JOIN billing_offer_versions o ON o.version=p.offer_version
    WHERE p.user_id=$1 AND p.period_start <= $2 AND p.period_end > $2`, [userId, now.toISOString()])).rows[0];
  const paymentTotals = (await db.query<{ environment: string; net_minor: string | number }>(`SELECT environment,
    COALESCE(SUM(CASE WHEN kind='payment_settled' THEN amount_minor ELSE -amount_minor END),0) AS net_minor
    FROM billing_payment_ledger WHERE user_id=$1 AND occurred_at >= $2 AND occurred_at < $3 GROUP BY environment ORDER BY environment`, [userId, start, end])).rows;
  return {
    schemaVersion: VERSION, window: { start, end }, finalizedProofs: Number(finalized.total),
    finalizedWithDurabilityReceipt: Number(finalized.confirmed), finalizedWithoutConfirmedDurability: Number(finalized.total) - Number(finalized.confirmed),
    recordedUsageUnits: Number(usage.total), eligibleUnderConsentedOffer: Number(usage.charge_eligible), automaticChargesEnabled: false,
    currentOffer: current ? { version: current.definition_json.version, currency: current.definition_json.currency, priceMinor: current.definition_json.priceMinor,
      interval: current.definition_json.interval, period: { start: new Date(current.period_start).toISOString(), end: new Date(current.period_end).toISOString() },
      includedFinalizedProofs: current.definition_json.includedFinalizedProofs, used: Number(current.used),
      remaining: Math.max(0, current.definition_json.includedFinalizedProofs - Number(current.used)), overage: current.definition_json.overage } : null,
    verifiedProviderAmounts: paymentTotals.map(row => ({ environment: row.environment, currency: "USD", netMinor: Number(row.net_minor) })),
    preservationAndPastAccessIndependentOfAllowance: true,
    message: current ? "One finalized transaction counts once within your consented offer. Metering does not itself create a charge."
      : "No priced offer is active. Completed Proofs are counted without creating charges.",
    limitations: ["Legacy or pending-durability finalizations are shown separately and are not billed by inference.",
      "New-capture quotas must be reserved atomically by media admission; this summary is not a quota reservation.",
      "Provider configuration, approved terms, actual payments and invoice reconciliation remain separate operating requirements."],
  };
}

export interface VerifiedProviderEvent {
  eventReference: string; customerReference: string; subjectReference: string; paymentReference: string;
  kind: "payment_settled" | "refund_settled"; occurredAt: string; amountMinor: number; currency: "USD";
}
export interface BillingProviderVerifier {
  provider: string; environment: "sandbox" | "live"; providerAccount: string;
  /** Must validate provider-supported signature or authenticated server re-fetch,
   * freshness and the configured provider account before returning normalized facts.
   */
  verifyAndNormalize(input: { rawBody: Buffer; signature: string | null }): Promise<VerifiedProviderEvent>;
}

/** Internal binding after authenticated checkout/account linking, never from a
 * webhook's client-supplied PackProof user ID. Existing mappings cannot be moved.
 */
export async function bindBillingCustomer(db: Database, clock: Clock, input: {
  provider: string; environment: "sandbox" | "live"; providerAccount: string; customerReference: string; userId: string;
}) {
  strict(input, ["provider", "environment", "providerAccount", "customerReference", "userId"]);
  for (const field of [input.provider, input.providerAccount, input.customerReference, input.userId]) identifier(field);
  if (!["sandbox", "live"].includes(input.environment)) fail("INVALID_BILLING_ENVIRONMENT", "Provider environment is required");
  const key = [input.provider, input.environment, input.providerAccount, input.customerReference];
  await db.query(`INSERT INTO billing_customer_bindings(provider,environment,provider_account,customer_reference,user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [...key, input.userId, clock.now().toISOString()]);
  const row = (await db.query<{ user_id: string }>("SELECT user_id FROM billing_customer_bindings WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND customer_reference=$4", key)).rows[0];
  if (row.user_id !== input.userId) fail("BILLING_CUSTOMER_BINDING_CONFLICT", "This provider customer already belongs to a different account", 409);
}

/** No default verifier exists. This seam has no unsigned/disabled verification fallback,
 * makes no provider charge call, and never changes Proof integrity or old access.
 */
export async function ingestVerifiedBillingEvent(db: Database, clock: Clock, verifier: BillingProviderVerifier, input: { rawBody: Buffer; signature: string | null }) {
  if (input.rawBody.byteLength > 1024 * 1024) fail("BILLING_EVENT_TOO_LARGE", "Billing event exceeds its ingress budget", 413);
  identifier(verifier.provider); identifier(verifier.providerAccount);
  if (!["sandbox", "live"].includes(verifier.environment)) fail("INVALID_BILLING_ENVIRONMENT", "Provider environment is required");
  const event = await verifier.verifyAndNormalize(input);
  strict(event, ["eventReference", "customerReference", "subjectReference", "paymentReference", "kind", "occurredAt", "amountMinor", "currency"]);
  for (const field of [event.eventReference, event.customerReference, event.subjectReference, event.paymentReference]) identifier(field);
  date(event.occurredAt); integer(event.amountMinor);
  if (!["payment_settled", "refund_settled"].includes(event.kind) || event.currency !== "USD") fail("INVALID_BILLING_EVENT", "Unsupported normalized billing event");
  if (event.occurredAt > clock.now().toISOString()) fail("BILLING_EVENT_IN_FUTURE", "Provider occurrence time requires verification", 409);
  const providerKey = [verifier.provider, verifier.environment, verifier.providerAccount];
  const eventKey = [...providerKey, event.eventReference];
  const eventSha = sha256Hex(canonicalize(event));
  const { eventReference: _sourceEvent, ...paymentFacts } = event;
  const paymentSha = sha256Hex(canonicalize(paymentFacts));
  return db.transaction(async tx => {
    const binding = (await tx.query<{ user_id: string }>("SELECT user_id FROM billing_customer_bindings WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND customer_reference=$4", [...providerKey, event.customerReference])).rows[0];
    if (!binding) fail("BILLING_CUSTOMER_NOT_BOUND", "Verified provider customer is not bound to a PackProof account", 409);
    await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [binding.user_id]);
    const existing = (await tx.query<{ sha256: string }>("SELECT sha256 FROM billing_provider_events WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND event_reference=$4", eventKey)).rows[0];
    if (existing) {
      if (existing.sha256 !== eventSha) fail("BILLING_EVENT_CONFLICT", "A provider event cannot be reused with changed facts", 409);
      return { eventReference: event.eventReference, replayed: true, ledgerInserted: false };
    }
    const paymentKey = [...providerKey, event.subjectReference, event.kind];
    const payment = (await tx.query<{ sha256: string }>("SELECT sha256 FROM billing_payment_ledger WHERE provider=$1 AND environment=$2 AND provider_account=$3 AND subject_reference=$4 AND kind=$5", paymentKey)).rows[0];
    if (payment && payment.sha256 !== paymentSha) fail("BILLING_PAYMENT_CONFLICT", "An accounted payment cannot be rewritten by a later event", 409);
    await tx.query(`INSERT INTO billing_provider_events(provider,environment,provider_account,event_reference,user_id,normalized_json,sha256,received_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [...eventKey, binding.user_id, JSON.stringify(event), eventSha, clock.now().toISOString()]);
    if (!payment) await tx.query(`INSERT INTO billing_payment_ledger(provider,environment,provider_account,subject_reference,kind,payment_reference,source_event_reference,user_id,occurred_at,amount_minor,currency,sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [...paymentKey, event.paymentReference, event.eventReference, binding.user_id, event.occurredAt, event.amountMinor, event.currency, paymentSha]);
    return { eventReference: event.eventReference, replayed: false, ledgerInserted: !payment };
  });
}
