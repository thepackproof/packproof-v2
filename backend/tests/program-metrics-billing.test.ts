import { syntheticPublication } from './program-metrics-publication-fixture.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgliteDatabase } from "../src/db/pglite.js";
import { migrate } from "../src/db/migrate.js";
import type { Database } from "../src/db/database.js";
import { bindBillingCustomer, getAccountUsageSummary, ingestVerifiedBillingEvent, reconcileDurableFinalizedUsage, registerOfferVersion as registerOfferStorage,
  scheduleApprovedOfferPeriod as scheduleOfferStorage, type BillingProviderVerifier, type OfferDefinition, type VerifiedProviderEvent } from "../src/billing/usage-ledger.js";

// Approved fixtures explicitly supply synthetic pinned policy receipts.
const registerOfferVersion: typeof registerOfferStorage = (db,clock,value) => registerOfferStorage(db,clock,value,
  (value as OfferDefinition).status==='approved'?{publication:syntheticPublication(value as OfferDefinition,clock.now())}:undefined);
const scheduleApprovedOfferPeriod: typeof scheduleOfferStorage = async(db,clock,input) => {
  const offer=(await db.query<{definition_json:OfferDefinition}>('SELECT definition_json FROM billing_offer_versions WHERE version=$1',[input.offerVersion])).rows[0];
  return scheduleOfferStorage(db,clock,input,offer?.definition_json.status==='approved'?{publication:syntheticPublication(offer.definition_json,clock.now())}:undefined);
};

let db: Database; let close: () => Promise<void>;
let sequence = 0;
let now = new Date("2026-09-01T00:00:00.000Z");
const clock = { now: () => new Date(now) };
const at = "2026-09-01T00:00:00.000Z";
const end = "2026-10-01T00:00:00.000Z";
const id = (prefix: string) => `${prefix}-${++sequence}`;
beforeAll(async () => { const opened = await createPgliteDatabase(); db = opened.db; close = opened.close; await migrate(db); }, 30_000);
beforeEach(() => { now = new Date(at); });
afterAll(async () => { await close(); });
async function user() {
  const userId = id("billing-user");
  await db.query("INSERT INTO users(id,created_at,updated_at) VALUES($1,$2,$2)", [userId, at]);
  return userId;
}
async function finalized(userId: string, durability: "DURABLE" | "PENDING" | "LEGACY" = "DURABLE") {
  const transactionId = id("billing-txn"); const proofId = id("billing-proof");
  await db.query("INSERT INTO transactions(id,created_by,created_at,updated_at) VALUES($1,$2,$3,$3)", [transactionId, userId, at]);
  await db.query("INSERT INTO proofs(id,transaction_id,status,created_at,updated_at) VALUES($1,$2,'READY_FOR_EVIDENCE',$3,$3)", [proofId, transactionId, at]);
  await db.query("INSERT INTO proof_participants(id,proof_id,user_id,role,joined_at) VALUES($1,$2,$3,'SELLER',$4)", [id("billing-participant"), proofId, userId, at]);
  await db.query("UPDATE proofs SET status='FINALIZED',finalized_at=$2 WHERE id=$1", [proofId, at]);
  if (durability !== "LEGACY") {
    const operationId = `finalize:${proofId}`; const hash = "a".repeat(64);
    await db.query(`INSERT INTO recovery_events(operation_id,proof_id,kind,request_sha256,canonical_json,sha256,created_at)
      VALUES($1,$2,'PROOF_FINALIZED',$3,'{}',$3,$4)`, [operationId, proofId, hash, at]);
    // Synthetic DB fixture: recovery signature validation is owned by recovery tests.
    const receipt = durability === "DURABLE" ? { version: 1, operationId, eventSha256: hash, envelopeSha256: "b".repeat(64), preservedAt: at } : null;
    await db.query("INSERT INTO recovery_delivery(operation_id,state,next_attempt_at,receipt_json) VALUES($1,$2,$3,$4)", [operationId, durability, at, receipt ? JSON.stringify(receipt) : null]);
  }
  return proofId;
}
function offer(status: "draft" | "approved" = "draft"): OfferDefinition {
  return { schemaVersion: "packproof.billing.v1", version: id("offer.v1"), status, currency: "USD", priceMinor: status === "approved" ? 2900 : null,
    interval: "monthly", includedFinalizedProofs: 2, maxRecordingBytes: 250_000_000, maxRecordingSeconds: 300,
    retentionPolicyVersion: "test-retention.v1", preservationStandard: "canonical-original-v1", supplements: "included_within_published_allowance",
    overage: "block_new_capture", approvedTermsReference: status === "approved" ? "synthetic-approved-terms" : null };
}

describe("durable finalized-Proof usage ledger", () => {
  it("refuses imprecise monetary aggregates instead of rounding a customer's amount", async () => {
    const account = await user(); const customer = id("large-customer");
    await bindBillingCustomer(db, clock, {provider:"fixture",environment:"sandbox",providerAccount:"account",customerReference:customer,userId:account});
    for(let index=0;index<2;index++) {
      const reference=id("large-payment");
      const verifier:BillingProviderVerifier={provider:"fixture",environment:"sandbox",providerAccount:"account",verifyAndNormalize:async()=>({eventReference:reference,customerReference:customer,subjectReference:reference,paymentReference:reference,kind:"payment_settled",occurredAt:at,amountMinor:Number.MAX_SAFE_INTEGER,currency:"USD"})};
      await ingestVerifiedBillingEvent(db,clock,verifier,{rawBody:Buffer.from("synthetic"),signature:"fixture"});
    }
    await expect(getAccountUsageSummary(db,clock,account)).rejects.toMatchObject({code:"BILLING_AMOUNT_RECONCILIATION_REQUIRED"});
  });

  it("does not seed pricing and meters each durable Proof once without charging legacy or pending records", async () => {
    const account = await user(); const other = await user();
    const proofId = await finalized(account); await finalized(account, "PENDING"); await finalized(account, "LEGACY"); await finalized(other);
    await reconcileDurableFinalizedUsage(db, clock); await reconcileDurableFinalizedUsage(db, clock);
    const result = await getAccountUsageSummary(db, clock, account);
    expect(result).toMatchObject({ finalizedProofs: 3, finalizedWithDurabilityReceipt: 1, finalizedWithoutConfirmedDurability: 2,
      recordedUsageUnits: 1, eligibleUnderConsentedOffer: 0, currentOffer: null, automaticChargesEnabled: false, preservationAndPastAccessIndependentOfAllowance: true });
    expect((await db.query("SELECT * FROM billing_proof_usage WHERE proof_id=$1", [proofId])).rows).toHaveLength(1);
    await expect(db.query("UPDATE billing_proof_usage SET units=2 WHERE proof_id=$1", [proofId])).rejects.toThrow("AUDIT_IMMUTABLE");
    await expect(db.query("DELETE FROM billing_proof_usage WHERE proof_id=$1", [proofId])).rejects.toThrow("AUDIT_IMMUTABLE");
  });

  it("rejects direct pending or wrong-account usage admissions", async () => {
    const account = await user(); const other = await user(); const pending = await finalized(account, "PENDING"); const durable = await finalized(account);
    const insert = (proofId: string, userId: string) => db.query(`INSERT INTO billing_proof_usage(proof_id,user_id,finalized_at,preservation_operation_id,receipt_sha256,units,recorded_at)
      VALUES($1,$2,$3,$4,$5,1,$3)`, [proofId, userId, at, `finalize:${proofId}`, "a".repeat(64)]);
    await expect(insert(pending, account)).rejects.toThrow("BILLING_DURABLE_FINALIZATION_REQUIRED");
    await expect(insert(durable, other)).rejects.toThrow("BILLING_DURABLE_FINALIZATION_REQUIRED");
  });

  it("requires approved versioned terms, prevents overlap and never retroactively prices recorded work", async () => {
    const account = await user(); const draft = offer(); await registerOfferVersion(db, clock, draft);
    const period = { id: id("period"), userId: account, offerVersion: draft.version, start: at, end, consentReceiptReference: "synthetic-consent" };
    await expect(scheduleApprovedOfferPeriod(db, clock, period)).rejects.toMatchObject({ code: "BILLING_OFFER_NOT_APPROVED" });
    const approved = offer("approved"); await registerOfferVersion(db, clock, approved);
    await expect(registerOfferVersion(db, clock, { ...approved, priceMinor: 7900 })).rejects.toMatchObject({ code: "BILLING_OFFER_VERSION_CONFLICT" });
    const proofId = await finalized(account); await reconcileDurableFinalizedUsage(db, clock);
    const scheduled = { ...period, offerVersion: approved.version };
    await scheduleApprovedOfferPeriod(db, clock, scheduled); await scheduleApprovedOfferPeriod(db, clock, scheduled);
    await expect(scheduleApprovedOfferPeriod(db, clock, { ...scheduled, id: id("overlap") })).rejects.toMatchObject({ code: "BILLING_PERIOD_OVERLAP" });
    await reconcileDurableFinalizedUsage(db, clock);
    const row = (await db.query<{ charge_eligible: boolean }>("SELECT charge_eligible FROM billing_proof_usage WHERE proof_id=$1", [proofId])).rows[0];
    expect(row.charge_eligible).toBe(false);
    now = new Date("2026-09-02T00:00:00.000Z");
    await expect(scheduleApprovedOfferPeriod(db, clock, { ...scheduled, id: id("backdated"), userId: await user() })).rejects.toMatchObject({ code: "BILLING_RETROACTIVE_PERIOD_REJECTED" });
  });

  it("reports approved allowance consumption without revoking past access at exhaustion", async () => {
    const account = await user(); const approved = offer("approved"); await registerOfferVersion(db, clock, approved);
    await scheduleApprovedOfferPeriod(db, clock, { id: id("period"), userId: account, offerVersion: approved.version, start: at, end, consentReceiptReference: "synthetic-consent" });
    await finalized(account); await finalized(account); await finalized(account);
    await reconcileDurableFinalizedUsage(db, clock, { limit: 100 });
    const summary = await getAccountUsageSummary(db, clock, account);
    expect(summary.currentOffer).toMatchObject({ used: 3, remaining: 0, includedFinalizedProofs: 2 });
    expect(summary.eligibleUnderConsentedOffer).toBe(3); expect(summary.automaticChargesEnabled).toBe(false);
    expect(summary.preservationAndPastAccessIndependentOfAllowance).toBe(true);
    expect(summary.limitations).toContain("New-capture quotas must be reserved atomically by media admission; this summary is not a quota reservation.");
  });
});

describe("verified provider event ingestion", () => {
  function verifier(customerReference: string, payment: Partial<VerifiedProviderEvent> = {}): BillingProviderVerifier {
    const source: VerifiedProviderEvent = { eventReference: id("evt"), customerReference, subjectReference: id("charge"), paymentReference: id("payment"),
      kind: "payment_settled", occurredAt: at, amountMinor: 2900, currency: "USD", ...payment };
    return { provider: "test-provider", providerAccount: "fixture-account", environment: "sandbox", verifyAndNormalize: async input => {
      if (input.signature !== "fixture-valid") throw new Error("TEST_PROVIDER_SIGNATURE_INVALID"); return source;
    } };
  }
  const body = { rawBody: Buffer.from("synthetic provider event"), signature: "fixture-valid" };
  async function bind(account: string, customerReference: string, environment: "sandbox" | "live" = "sandbox") {
    await bindBillingCustomer(db, clock, { provider: "test-provider", providerAccount: "fixture-account", environment, customerReference, userId: account });
  }

  it("requires verifier acceptance and server-side customer binding before any accounting write", async () => {
    const account = await user(); const customer = id("customer"); const adapter = verifier(customer);
    await expect(ingestVerifiedBillingEvent(db, clock, adapter, { ...body, signature: "forged" })).rejects.toThrow("TEST_PROVIDER_SIGNATURE_INVALID");
    await expect(ingestVerifiedBillingEvent(db, clock, adapter, body)).rejects.toMatchObject({ code: "BILLING_CUSTOMER_NOT_BOUND" });
    await bind(account, customer);
    await expect(bind(await user(), customer)).rejects.toMatchObject({ code: "BILLING_CUSTOMER_BINDING_CONFLICT" });
    await expect(ingestVerifiedBillingEvent(db, clock, adapter, { ...body, rawBody: Buffer.alloc(1024 * 1024 + 1) })).rejects.toMatchObject({ code: "BILLING_EVENT_TOO_LARGE" });
  });

  it("deduplicates repeated event IDs and different notifications of the same payment", async () => {
    const account = await user(); const customer = id("customer"); await bind(account, customer);
    const adapter = verifier(customer); const source = await adapter.verifyAndNormalize(body);
    expect(await ingestVerifiedBillingEvent(db, clock, adapter, body)).toMatchObject({ ledgerInserted: true, replayed: false });
    expect(await ingestVerifiedBillingEvent(db, clock, adapter, body)).toMatchObject({ ledgerInserted: false, replayed: true });
    const duplicate = verifier(customer, { ...source, eventReference: id("new-notification") });
    expect(await ingestVerifiedBillingEvent(db, clock, duplicate, body)).toMatchObject({ ledgerInserted: false, replayed: false });
    const changed = verifier(customer, { ...source, amountMinor: 7900 });
    await expect(ingestVerifiedBillingEvent(db, clock, changed, body)).rejects.toMatchObject({ code: "BILLING_EVENT_CONFLICT" });
    expect((await getAccountUsageSummary(db, clock, account)).verifiedProviderAmounts).toEqual([{ environment: "sandbox", currency: "USD", netMinor: 2900 }]);
  });

  it("counts distinct partial refunds once and keeps sandbox amounts separate from live", async () => {
    const account = await user(); const customer = id("customer"); await bind(account, customer); await bind(account, customer, "live");
    const charge = verifier(customer); const source = await charge.verifyAndNormalize(body); await ingestVerifiedBillingEvent(db, clock, charge, body);
    const refund = verifier(customer, { subjectReference: id("refund"), paymentReference: source.paymentReference, kind: "refund_settled", amountMinor: 900 });
    await ingestVerifiedBillingEvent(db, clock, refund, body); await ingestVerifiedBillingEvent(db, clock, refund, body);
    const live = { ...verifier(customer), environment: "live" as const }; await ingestVerifiedBillingEvent(db, clock, live, body);
    expect((await getAccountUsageSummary(db, clock, account)).verifiedProviderAmounts).toEqual([
      { environment: "live", currency: "USD", netMinor: 2900 }, { environment: "sandbox", currency: "USD", netMinor: 2000 },
    ]);
    await expect(db.query("UPDATE billing_payment_ledger SET amount_minor=0 WHERE user_id=$1", [account])).rejects.toThrow("AUDIT_IMMUTABLE");
    await expect(db.query("DELETE FROM billing_provider_events WHERE user_id=$1", [account])).rejects.toThrow("AUDIT_IMMUTABLE");
  });
});
