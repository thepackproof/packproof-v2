import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { requireParticipant, loadProof } from "./proof-access.js";
import { appendAudit } from "./audit.js";
import { newId } from "../ids.js";
import { requireCommerceAccess } from "./commerce-lifecycle.js";
import { DomainError } from "./errors.js";

async function requireRetentionAccess(db: Database, proofId: string, userId: string) {
  const member = await db.query(
    "SELECT 1 FROM proof_participants WHERE proof_id=$1 AND user_id=$2",
    [proofId, userId],
  );
  if (!member.rows[0]) await requireCommerceAccess(db, proofId, userId);
}
function reasonText(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 1000)
    throw new DomainError("INVALID_REASON", "Provide a reason of up to 1,000 characters", 400);
  return value.trim();
}
export async function getRetentionControls(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
) {
  await requireRetentionAccess(db, proofId, userId);
  const proof = await loadProof(db, proofId);
  const holds = (
    await db.query(
      `SELECT id,created_by AS "createdBy",reason,created_at AS "createdAt",released_at AS "releasedAt" FROM proof_retention_holds WHERE proof_id=$1 ORDER BY created_at,id`,
      [proofId],
    )
  ).rows;
  const stages = await db.query(
    "SELECT 1 FROM commerce_stages WHERE proof_id=$1 AND finalized_at IS NULL",
    [proofId],
  );
  const lastStage = (
    await db.query<{ last_finalized: Date | string | null }>(
      "SELECT MAX(finalized_at) AS last_finalized FROM commerce_stages WHERE proof_id=$1",
      [proofId],
    )
  ).rows[0]?.last_finalized;
  const finalTime = Math.max(
    proof.finalized_at ? new Date(proof.finalized_at).getTime() : 0,
    lastStage ? new Date(lastStage).getTime() : 0,
  );
  const protectedUntil = finalTime ? new Date(finalTime + 90 * 86400000).toISOString() : null;
  const blockers: string[] = [];
  if (!protectedUntil) blockers.push("Proof is active");
  else if (new Date(protectedUntil) > clock.now())
    blockers.push("Standard 90-day retention window");
  if (holds.some((h) => h.releasedAt === null)) blockers.push("Active retention hold");
  if (stages.rows.length) blockers.push("Receipt or return evidence in progress");
  const requests = (
    await db.query(
      `SELECT id,state,requested_by AS "requestedBy",created_at AS "createdAt" FROM proof_deletion_requests WHERE proof_id=$1 ORDER BY created_at`,
      [proofId],
    )
  ).rows;
  return {
    policyVersion: 1,
    standardWindowDays: 90,
    automaticDeletion: false,
    protectedUntil,
    holds,
    deletionRequests: requests,
    blockers,
    eligibleForDeletionReview: !blockers.length,
  };
}
export async function createRetentionHold(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
  reason: unknown,
) {
  const text = reasonText(reason);
  return db.transaction(async (tx) => {
    await requireRetentionAccess(tx, proofId, userId);
    await loadProof(tx, proofId, true);
    const found = await tx.query<{ id: string }>(
      "SELECT id FROM proof_retention_holds WHERE proof_id=$1 AND created_by=$2 AND reason=$3 AND released_at IS NULL",
      [proofId, userId, text],
    );
    if (found.rows[0]) return { id: found.rows[0].id };
    const id = newId("hold");
    await tx.query(
      "INSERT INTO proof_retention_holds(id,proof_id,created_by,reason,created_at) VALUES($1,$2,$3,$4,$5)",
      [id, proofId, userId, text, clock.now().toISOString()],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId: userId,
      eventType: "RETENTION_HOLD_PLACED",
      eventData: { holdId: id },
      at: clock.now(),
    });
    return { id };
  });
}
export async function releaseRetentionHold(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
  holdId: string,
) {
  return db.transaction(async (tx) => {
    await requireRetentionAccess(tx, proofId, userId);
    const result = await tx.query(
      "UPDATE proof_retention_holds SET released_at=$4 WHERE id=$1 AND proof_id=$2 AND created_by=$3 AND released_at IS NULL RETURNING id",
      [holdId, proofId, userId, clock.now().toISOString()],
    );
    if (!result.rows[0])
      throw new DomainError(
        "HOLD_NOT_FOUND",
        "Only the person who placed an active hold can release it",
        404,
      );
    await appendAudit(tx, {
      proofId,
      actorUserId: userId,
      eventType: "RETENTION_HOLD_RELEASED",
      eventData: { holdId },
      at: clock.now(),
    });
    return { released: true };
  });
}
export async function requestProofDeletion(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
  reason: unknown,
) {
  const text = reasonText(reason);
  return db.transaction(async (tx) => {
    await requireRetentionAccess(tx, proofId, userId);
    await loadProof(tx, proofId, true);
    const existing = (
      await tx.query<{ id: string; state: string }>(
        "SELECT id,state FROM proof_deletion_requests WHERE proof_id=$1 AND requested_by=$2",
        [proofId, userId],
      )
    ).rows[0];
    if (existing)
      return {
        ...existing,
        retention: await getRetentionControls(tx, clock, userId, proofId),
      };
    const result = await tx.query<{ id: string }>(
      `INSERT INTO proof_deletion_requests(id,proof_id,requested_by,reason,created_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(proof_id,requested_by) DO UPDATE SET proof_id=EXCLUDED.proof_id RETURNING id`,
      [newId("del"), proofId, userId, text, clock.now().toISOString()],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId: userId,
      eventType: "DELETION_REVIEW_REQUESTED",
      eventData: { requestId: result.rows[0].id },
      at: clock.now(),
    });
    return {
      id: result.rows[0].id,
      state: "REQUESTED",
      retention: await getRetentionControls(tx, clock, userId, proofId),
      message:
        "Deletion requested for review. Evidence remains available while retention and hold requirements are assessed.",
    };
  });
}
