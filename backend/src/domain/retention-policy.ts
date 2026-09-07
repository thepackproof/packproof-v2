import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { canonicalize } from "../canonical.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { loadProof, requireParticipant } from "./proof-access.js";
import { buildProofRecoverySnapshot, enqueueRecoveryEvent } from "./recovery-journal.js";

const DAY = 86400000;
export interface VersionedRetentionPolicy {
  version: 1;
  policyId: string;
  minimumProtectionDays: number;
  startEvent: "FINALIZED" | "PAYMENT" | "DELIVERY";
  channelWindowDays: number | null;
  noticeDays: number;
  afterHoldReleaseDays: number;
  approvalReference: string | null;
}
export interface RetentionAnchors { finalizedAt?: string | null; paymentAt?: string | null; deliveryAt?: string | null; }
export const DRAFT_RETENTION_POLICIES: Record<string, VersionedRetentionPolicy> = Object.freeze({
  "pilot-manual-v1": { version: 1, policyId: "pilot-manual-v1", minimumProtectionDays: 90, startEvent: "FINALIZED", channelWindowDays: null, noticeDays: 30, afterHoldReleaseDays: 30, approvalReference: null },
  // Configuration proposal, not a legal interpretation or an automatic expiry promise.
  "paypal-us-review-v1": { version: 1, policyId: "paypal-us-review-v1", minimumProtectionDays: 90, startEvent: "PAYMENT", channelWindowDays: 180, noticeDays: 30, afterHoldReleaseDays: 30, approvalReference: null },
});
function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new DomainError("INVALID_RETENTION_DATE", "Retention dates must be valid timestamps", 400);
  return parsed;
}
function days(value: number) { if (!Number.isSafeInteger(value) || value < 0 || value > 36500) throw new DomainError("INVALID_RETENTION_POLICY", "Retention intervals must be bounded nonnegative whole days", 400); }
export function evaluateRetentionDates(input: {
  policy: VersionedRetentionPolicy; anchors: RetentionAnchors; contractualPreserveUntil?: string | null;
  now: Date; activeHold: boolean; releasedHoldProtectUntil?: string | null; noticeAt?: string | null;
}) {
  const { policy } = input;
  if (policy.version !== 1 || !["FINALIZED", "PAYMENT", "DELIVERY"].includes(policy.startEvent)) throw new DomainError("INVALID_RETENTION_POLICY", "Unsupported retention policy", 400);
  [policy.minimumProtectionDays, policy.noticeDays, policy.afterHoldReleaseDays].forEach(days);
  if (policy.minimumProtectionDays < 90) throw new DomainError("INVALID_RETENTION_POLICY", "Existing minimum protection cannot be shortened", 400);
  if (policy.channelWindowDays !== null) days(policy.channelWindowDays);
  const blockers: string[] = [];
  const finalized = timestamp(input.anchors.finalizedAt);
  const anchor = timestamp(input.anchors[policy.startEvent === "PAYMENT" ? "paymentAt" : policy.startEvent === "DELIVERY" ? "deliveryAt" : "finalizedAt"]);
  const dates: number[] = [];
  if (finalized === null) blockers.push("Proof is active or finalization date is unavailable");
  else dates.push(finalized + Math.max(90, policy.minimumProtectionDays) * DAY);
  if (anchor === null) blockers.push(`Missing ${policy.startEvent.toLowerCase()} retention anchor requires review`);
  else if (policy.channelWindowDays !== null) dates.push(anchor + policy.channelWindowDays * DAY);
  if (policy.channelWindowDays === null) blockers.push("Channel or offer disposition period requires approved review");
  if (!policy.approvalReference) blockers.push("Retention policy awaits approval");
  for (const value of [input.contractualPreserveUntil, input.releasedHoldProtectUntil]) { const parsed = timestamp(value); if (parsed !== null) dates.push(parsed); }
  if (input.activeHold) blockers.push("Active retention hold");
  const notice = timestamp(input.noticeAt);
  if (notice === null) blockers.push("Disposition notice has not been recorded");
  else dates.push(notice + policy.noticeDays * DAY);
  const protectedUntil = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
  if (protectedUntil && new Date(protectedUntil) > input.now) blockers.push("Applicable protection period has not elapsed");
  return { protectedUntil, blockers, eligibleForDisposition: blockers.length === 0 };
}

/** Internal policy command; HTTP callers may not provide their own approval reference. */
export async function assignRetentionPolicy(db: Database, clock: Clock, actorUserId: string, proofId: string, input: {
  operationId: string; policy: VersionedRetentionPolicy; anchors: RetentionAnchors; contractualPreserveUntil?: string | null;
}) {
  evaluateRetentionDates({ ...input, now: clock.now(), activeHold: false });
  return db.transaction(async tx => {
    await requireParticipant(tx, proofId, actorUserId, "SELLER");
    await loadProof(tx, proofId, true);
    await assertHoldAdmissionOpen(tx, proofId);
    const prior = (await tx.query<{ id: string; proof_id:string; actor_user_id:string; policy_json: unknown; anchors_json: unknown; contractual_preserve_until: string | Date | null }>("SELECT * FROM proof_retention_assignments WHERE operation_id=$1", [input.operationId])).rows[0];
    const contract = input.contractualPreserveUntil ? new Date(input.contractualPreserveUntil).toISOString() : null;
    if (prior) {
      if (prior.proof_id !== proofId || prior.actor_user_id !== actorUserId || canonicalize(prior.policy_json) !== canonicalize(input.policy) || canonicalize(prior.anchors_json) !== canonicalize(input.anchors) || (prior.contractual_preserve_until ? new Date(prior.contractual_preserve_until).toISOString() : null) !== contract) throw new DomainError("RETENTION_OPERATION_CONFLICT", "This policy operation already contains different terms", 409);
      return { id: prior.id };
    }
    const id = newId("ret");
    await tx.query(`INSERT INTO proof_retention_assignments(id,proof_id,operation_id,policy_id,policy_json,anchors_json,contractual_preserve_until,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, proofId, input.operationId, input.policy.policyId, JSON.stringify(input.policy), JSON.stringify(input.anchors), contract, actorUserId, clock.now().toISOString()]);
    await enqueueRecoveryEvent(tx, clock, { operationId: `retention-policy:${id}`, kind: "RETENTION_CHANGED", proofId, actorUserId, payload: await buildProofRecoverySnapshot(tx, proofId) });
    return { id };
  });
}

export async function assertHoldAdmissionOpen(db: Database, proofId: string) {
  const state = (await db.query<{ state: string }>("SELECT state FROM proof_disposition_state WHERE proof_id=$1", [proofId])).rows[0]?.state;
  if (state && state !== "OPEN") throw new DomainError("DISPOSITION_ALREADY_STARTED", "Disposition has already locked this record. A new hold cannot promise recovery of disposed originals; contact support", 409);
}

export async function evaluateProofDisposition(db: Database, clock: Clock, proofId: string) {
  const proof = await loadProof(db, proofId);
  const assignments = (await db.query<{ policy_json: VersionedRetentionPolicy; anchors_json: RetentionAnchors; contractual_preserve_until: Date | string | null }>("SELECT * FROM proof_retention_assignments WHERE proof_id=$1 ORDER BY created_at,id", [proofId])).rows;
  const holds = (await db.query<{ released_at: Date | string | null; release_protect_until: Date | string | null }>("SELECT released_at,release_protect_until FROM proof_retention_holds WHERE proof_id=$1", [proofId])).rows;
  const disposition = (await db.query<{ state: string; notice_at: Date | string | null }>("SELECT state,notice_at FROM proof_disposition_state WHERE proof_id=$1", [proofId])).rows[0];
  const releasedUntil = holds.map(h => h.release_protect_until ? new Date(h.release_protect_until).getTime() : 0);
  const latestStage = (await db.query<{ latest: Date | string | null }>("SELECT MAX(finalized_at) AS latest FROM commerce_stages WHERE proof_id=$1", [proofId])).rows[0]?.latest;
  const latestFinal = Math.max(proof.finalized_at ? new Date(proof.finalized_at).getTime() : 0, latestStage ? new Date(latestStage).getTime() : 0);
  const defaultAnchors = { finalizedAt: latestFinal ? new Date(latestFinal).toISOString() : null };
  const policies = assignments.length ? assignments : [{ policy_json: DRAFT_RETENTION_POLICIES["pilot-manual-v1"], anchors_json: defaultAnchors, contractual_preserve_until: null }];
  const evaluations = policies.map(row => evaluateRetentionDates({ policy: row.policy_json, anchors: { ...row.anchors_json, ...defaultAnchors }, contractualPreserveUntil: row.contractual_preserve_until ? new Date(row.contractual_preserve_until).toISOString() : null, now: clock.now(), activeHold: holds.some(h => h.released_at === null), releasedHoldProtectUntil: Math.max(0, ...releasedUntil) ? new Date(Math.max(...releasedUntil)).toISOString() : null, noticeAt: disposition?.notice_at ? new Date(disposition.notice_at).toISOString() : null }));
  const blockers = new Set(evaluations.flatMap(result => result.blockers));
  if (disposition && disposition.state !== "OPEN") blockers.add("Disposition is already locked or completed");
  if ((await db.query("SELECT 1 FROM commerce_stages WHERE proof_id=$1 AND finalized_at IS NULL", [proofId])).rows[0]) blockers.add("Receipt or return evidence in progress");
  const dates = evaluations.map(result => result.protectedUntil).filter((value): value is string => !!value);
  return { policyVersion: 2, automaticDeletion: false, protectedUntil: dates.length ? new Date(Math.max(...dates.map(value => new Date(value).getTime()))).toISOString() : null, blockers: [...blockers], eligibleForDisposition: blockers.size === 0, dispositionState: disposition?.state ?? "OPEN" };
}

/** Serializes the irreversible boundary with hold admission. No object deletion is performed here. */
export async function lockProofDisposition(db: Database, clock: Clock, proofId: string) {
  return db.transaction(async tx => {
    await loadProof(tx, proofId, true);
    const gates = (await tx.query<{ disposal_enabled: boolean; approved_policy_reference: string | null; successful_restore_drill_reference: string | null }>("SELECT * FROM retention_operations_gates WHERE singleton=1")).rows[0];
    if (!gates?.disposal_enabled || !gates.approved_policy_reference || !gates.successful_restore_drill_reference) throw new DomainError("DISPOSITION_GATE_CLOSED", "Disposition requires an approved policy and a successful restore drill", 409);
    const evaluation = await evaluateProofDisposition(tx, clock, proofId);
    if (!evaluation.eligibleForDisposition) throw new DomainError("RETENTION_PROTECTED", "The record still has retention requirements", 409);
    await tx.query(`INSERT INTO proof_disposition_state(proof_id,state,locked_at,updated_at) VALUES($1,'DISPOSITION_LOCKED',$2,$2) ON CONFLICT(proof_id) DO UPDATE SET state='DISPOSITION_LOCKED',locked_at=$2,updated_at=$2`, [proofId, clock.now().toISOString()]);
    await enqueueRecoveryEvent(tx, clock, { operationId: `disposition-lock:${proofId}`, kind: "RETENTION_CHANGED", proofId, actorUserId: null, payload: await buildProofRecoverySnapshot(tx, proofId) });
    return { state: "DISPOSITION_LOCKED", originalsDeleted: false };
  });
}

/** Scheduled dry run only. Defaults never infer day-90 disposal or delete stored bytes. */
export async function listDispositionCandidates(db: Database, clock: Clock, limit = 100) {
  const proofs = (await db.query<{ id: string }>("SELECT id FROM proofs WHERE status='FINALIZED' ORDER BY finalized_at,id LIMIT $1", [Math.max(1, Math.min(500, limit))])).rows;
  const candidates = [];
  for (const proof of proofs) candidates.push({ proofId: proof.id, ...await evaluateProofDisposition(db, clock, proof.id) });
  return { dryRun: true, candidates };
}
