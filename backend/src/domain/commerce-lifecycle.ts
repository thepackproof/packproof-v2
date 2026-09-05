import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import type { ObjectStore } from "../s3/object-store.js";
import { newId } from "../ids.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "./errors.js";
import { loadProof, requireParticipant } from "./proof-access.js";
import { appendAudit } from "./audit.js";

export const COMMERCE_STAGES = ["RECEIPT", "RETURN_PACKING", "RETURN_RECEIPT"] as const;
export type CommerceStageType = (typeof COMMERCE_STAGES)[number];
const ATTESTATIONS = {
  RECEIPT: "I_RECORDED_RECEIPT",
  RETURN_PACKING: "I_PACKED_RETURN",
  RETURN_RECEIPT: "I_RECEIVED_RETURN",
};
function stageType(value: unknown): CommerceStageType {
  if (typeof value !== "string" || !COMMERCE_STAGES.includes(value as CommerceStageType))
    throw new DomainError(
      "INVALID_STAGE",
      "Choose receipt, return packing, or return receipt",
      400,
    );
  return value as CommerceStageType;
}
async function commerceProof(db: Database, proofId: string, lock = false) {
  const proof = await loadProof(db, proofId, lock);
  if (proof.workflow_type !== "COMMERCE_SALE" || proof.status !== "FINALIZED")
    throw new DomainError(
      "LIFECYCLE_NOT_READY",
      "Finalize the seller Proof before documenting receipt or returns",
      409,
    );
  return proof;
}
export async function requireCommerceAccess(
  db: Database,
  proofId: string,
  userId: string,
): Promise<"SELLER" | "BUYER"> {
  await commerceProof(db, proofId);
  const member = await db.query<{ role: "SELLER" | "BUYER" }>(
    "SELECT role FROM proof_participants WHERE proof_id=$1 AND user_id=$2",
    [proofId, userId],
  );
  if (member.rows[0]) return member.rows[0].role;
  const receiver = await db.query(
    "SELECT 1 FROM commerce_receivers WHERE proof_id=$1 AND user_id=$2 AND accepted_at IS NOT NULL",
    [proofId, userId],
  );
  if (!receiver.rows[0])
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "You do not have access to this receipt record",
      403,
    );
  return "BUYER";
}
export async function inviteCommerceReceiver(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
  receiverId: unknown,
) {
  if (typeof receiverId !== "string" || !receiverId || receiverId === userId)
    throw new DomainError("INVALID_RECEIVER", "Choose another PackProof user", 400);
  return db.transaction(async (tx) => {
    await commerceProof(tx, proofId, true);
    await requireParticipant(tx, proofId, userId, "SELLER");
    if (!(await tx.query("SELECT 1 FROM users WHERE id=$1", [receiverId])).rows[0])
      throw new DomainError("USER_NOT_FOUND", "Receiver not found", 404);
    const buyer = await tx.query<{ user_id: string }>(
      "SELECT user_id FROM proof_participants WHERE proof_id=$1 AND role='BUYER'",
      [proofId],
    );
    if (buyer.rows[0] && buyer.rows[0].user_id !== receiverId)
      throw new DomainError("RECEIVER_ALREADY_BOUND", "The recorded buyer cannot be replaced", 409);
    const existing = await tx.query<{ user_id: string }>(
      "SELECT user_id FROM commerce_receivers WHERE proof_id=$1",
      [proofId],
    );
    if (existing.rows[0] && existing.rows[0].user_id !== receiverId)
      throw new DomainError(
        "RECEIVER_ALREADY_BOUND",
        "This Proof already has a receiver invitation",
        409,
      );
    if (!existing.rows[0]) {
      await tx.query(
        "INSERT INTO commerce_receivers(proof_id,user_id,invited_by,created_at) VALUES($1,$2,$3,$4)",
        [proofId, receiverId, userId, clock.now().toISOString()],
      );
      await appendAudit(tx, {
        proofId,
        actorUserId: userId,
        eventType: "RECEIVER_INVITED",
        eventData: { receiverUserId: receiverId },
        at: clock.now(),
      });
    }
    return {
      proofId,
      receiverUserId: receiverId,
      invitationPath: `/receipt/${proofId}`,
    };
  });
}
export async function acceptCommerceReceiver(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
) {
  return db.transaction(async (tx) => {
    const invitation = await tx.query<{ accepted_at: unknown }>(
      "SELECT accepted_at FROM commerce_receivers WHERE proof_id=$1 AND user_id=$2 FOR UPDATE",
      [proofId, userId],
    );
    if (!invitation.rows[0])
      throw new DomainError("INVITATION_NOT_FOUND", "Receipt invitation not found", 404);
    if (!invitation.rows[0].accepted_at) {
      await tx.query(
        "UPDATE commerce_receivers SET accepted_at=$3 WHERE proof_id=$1 AND user_id=$2",
        [proofId, userId, clock.now().toISOString()],
      );
      await appendAudit(tx, {
        proofId,
        actorUserId: userId,
        eventType: "RECEIVER_JOINED",
        eventData: { userId },
        at: clock.now(),
      });
    }
    return { proofId, accepted: true };
  });
}
export async function listCommerceStages(db: Database, proofId: string) {
  const stages = (
    await db.query<{
      id: string;
      stage_type: string;
      actor_user_id: string;
      created_at: Date | string;
      finalized_at: Date | string | null;
      sha256: string | null;
      canonical_json: string | null;
    }>("SELECT * FROM commerce_stages WHERE proof_id=$1 ORDER BY created_at,id", [proofId])
  ).rows;
  return Promise.all(
    stages.map(async (s) => ({
      stageId: s.id,
      type: s.stage_type,
      actorUserId: s.actor_user_id,
      createdAt: new Date(s.created_at).toISOString(),
      finalizedAt: s.finalized_at ? new Date(s.finalized_at).toISOString() : null,
      sha256: s.sha256,
      manifest: s.canonical_json ? JSON.parse(s.canonical_json) : null,
      evidence: (
        await db.query(
          `SELECT id AS "evidenceId",content_type AS "contentType",byte_size AS "byteSize",sha256,committed_at AS "committedAt" FROM commerce_stage_evidence WHERE stage_id=$1 AND discarded_at IS NULL ORDER BY created_at,id`,
          [s.id],
        )
      ).rows,
    })),
  );
}
export async function createCommerceStage(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
  type: unknown,
) {
  const kind = stageType(type);
  return db.transaction(async (tx) => {
    await commerceProof(tx, proofId, true);
    const role = await requireCommerceAccess(tx, proofId, userId);
    if (role !== (kind === "RETURN_RECEIPT" ? "SELLER" : "BUYER"))
      throw new DomainError(
        "PARTICIPANT_NOT_AUTHORIZED",
        "This stage belongs to the other participant",
        403,
      );
    const previous = COMMERCE_STAGES.indexOf(kind) - 1;
    if (
      previous >= 0 &&
      !(
        await tx.query(
          "SELECT 1 FROM commerce_stages WHERE proof_id=$1 AND stage_type=$2 AND finalized_at IS NOT NULL",
          [proofId, COMMERCE_STAGES[previous]],
        )
      ).rows[0]
    )
      throw new DomainError("LIFECYCLE_NOT_READY", "Complete the previous stage first", 409);
    const result = await tx.query<{ id: string }>(
      "SELECT id FROM commerce_stages WHERE proof_id=$1 AND stage_type=$2",
      [proofId, kind],
    );
    if (result.rows[0])
      return {
        stageId: result.rows[0].id,
        type: kind,
        attestation: ATTESTATIONS[kind],
      };
    const id = newId("stage");
    await tx.query(
      "INSERT INTO commerce_stages(id,proof_id,stage_type,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5)",
      [id, proofId, kind, userId, clock.now().toISOString()],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId: userId,
      eventType: "LIFECYCLE_STAGE_CREATED",
      eventData: { stageId: id, type: kind },
      at: clock.now(),
    });
    return { stageId: id, type: kind, attestation: ATTESTATIONS[kind] };
  });
}
async function ownedStage(db: Database, proofId: string, stageId: string, userId: string) {
  await requireCommerceAccess(db, proofId, userId);
  const result = await db.query<{
    id: string;
    stage_type: CommerceStageType;
    finalized_at: unknown;
    canonical_json: string | null;
    sha256: string | null;
  }>("SELECT * FROM commerce_stages WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3 FOR UPDATE", [
    stageId,
    proofId,
    userId,
  ]);
  if (!result.rows[0]) throw new DomainError("STAGE_NOT_FOUND", "Stage not found", 404);
  return result.rows[0];
}
export async function initializeStageEvidence(
  db: Database,
  clock: Clock,
  store: ObjectStore,
  userId: string,
  proofId: string,
  stageId: string,
  input: { contentType?: unknown; idempotencyKey?: unknown },
) {
  if (
    typeof input.contentType !== "string" ||
    !/^(video\/(mp4|webm|quicktime)|image\/(jpeg|png))$/.test(input.contentType) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  )
    throw new DomainError(
      "INVALID_EVIDENCE",
      "A supported media type and upload key are required",
      400,
    );
  const contentType = input.contentType,
    key = input.idempotencyKey;
  return db.transaction(async (tx) => {
    const stage = await ownedStage(tx, proofId, stageId, userId);
    if (stage.finalized_at)
      throw new DomainError("COMMERCE_STAGE_IMMUTABLE", "This stage is finalized", 409);
    const existing = (
      await tx.query<{
        id: string;
        object_key: string;
        content_type: string;
        committed_at: unknown;
        discarded_at: unknown;
      }>("SELECT * FROM commerce_stage_evidence WHERE stage_id=$1 AND idempotency_key=$2", [
        stageId,
        key,
      ])
    ).rows[0];
    if (existing?.content_type && existing.content_type !== contentType)
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Upload type changed", 409);
    if (existing?.discarded_at)
      throw new DomainError("EVIDENCE_UPLOAD_DISCARDED", "Start a new upload with a new key", 409);
    if (existing?.committed_at)
      throw new DomainError("EVIDENCE_ALREADY_COMMITTED", "Evidence is already committed", 409);
    const id = existing?.id ?? newId("media"),
      objectKey = existing?.object_key ?? `proofs/${proofId}/lifecycle/${stageId}/${id}`;
    if (!existing)
      await tx.query(
        "INSERT INTO commerce_stage_evidence(id,stage_id,idempotency_key,object_key,content_type,created_at) VALUES($1,$2,$3,$4,$5,$6)",
        [id, stageId, key, objectKey, contentType, clock.now().toISOString()],
      );
    return {
      evidenceId: id,
      upload: await store.createUploadTarget({ key: objectKey, contentType }),
    };
  });
}
export async function commitStageEvidence(
  db: Database,
  clock: Clock,
  store: ObjectStore,
  userId: string,
  proofId: string,
  stageId: string,
  evidenceId: string,
  expectedHash: unknown,
) {
  return db.transaction(async (tx) => {
    await ownedStage(tx, proofId, stageId, userId);
    const row = (
      await tx.query<{
        object_key: string;
        content_type: string;
        sha256: string | null;
      }>(
        "SELECT * FROM commerce_stage_evidence WHERE id=$1 AND stage_id=$2 AND discarded_at IS NULL FOR UPDATE",
        [evidenceId, stageId],
      )
    ).rows[0];
    if (!row) throw new DomainError("EVIDENCE_NOT_FOUND", "Stage evidence not found", 404);
    if (row.sha256) return { evidenceId, sha256: row.sha256 };
    const object = await store.commitUpload(row.object_key);
    if (!object) throw new DomainError("EVIDENCE_OBJECT_MISSING", "Upload recording first", 409);
    if (
      object.byteSize > 200 * 1024 * 1024 ||
      object.byteSize === 0 ||
      object.contentType !== row.content_type ||
      (expectedHash != null && expectedHash !== object.sha256)
    )
      throw new DomainError(
        "EVIDENCE_INTEGRITY_FAILURE",
        "Uploaded recording does not match expected metadata",
        422,
      );
    await tx.query(
      "UPDATE commerce_stage_evidence SET object_key=$2,sha256=$3,byte_size=$4,committed_at=$5 WHERE id=$1",
      [evidenceId, object.key, object.sha256, object.byteSize, clock.now().toISOString()],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId: userId,
      eventType: "LIFECYCLE_EVIDENCE_COMMITTED",
      eventData: { stageId, evidenceId, sha256: object.sha256 },
      at: clock.now(),
    });
    return { evidenceId, sha256: object.sha256 };
  });
}
export async function finalizeCommerceStage(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
  stageId: string,
  statement: unknown,
) {
  return db.transaction(async (tx) => {
    const stage = await ownedStage(tx, proofId, stageId, userId);
    if (statement !== ATTESTATIONS[stage.stage_type])
      throw new DomainError("ATTESTATION_REQUIRED", "Confirm the recorded stage attestation", 400);
    if (stage.finalized_at)
      return {
        stageId,
        sha256: stage.sha256,
        manifest: JSON.parse(stage.canonical_json!),
      };
    const media = (
      await tx.query<{
        id: string;
        sha256: string | null;
        object_key: string;
        content_type: string;
        byte_size: string;
        committed_at: Date | string;
      }>(
        "SELECT * FROM commerce_stage_evidence WHERE stage_id=$1 AND discarded_at IS NULL ORDER BY id",
        [stageId],
      )
    ).rows;
    if (!media.length || media.some((m) => !m.sha256))
      throw new DomainError(
        "STAGE_EVIDENCE_REQUIRED",
        "Commit all stage recordings before finalizing",
        409,
      );
    const base = (
      await tx.query<{ sha256: string }>("SELECT sha256 FROM final_manifests WHERE proof_id=$1", [
        proofId,
      ])
    ).rows[0];
    const previousIndex = COMMERCE_STAGES.indexOf(stage.stage_type) - 1;
    const previous =
      previousIndex >= 0
        ? (
            await tx.query<{ id: string; sha256: string }>(
              "SELECT id,sha256 FROM commerce_stages WHERE proof_id=$1 AND stage_type=$2 AND finalized_at IS NOT NULL",
              [proofId, COMMERCE_STAGES[previousIndex]],
            )
          ).rows[0]
        : null;
    const payload = {
      schema: "packproof.commerce-stage.v1",
      proofId,
      stageId,
      type: stage.stage_type,
      baseManifestSha256: base.sha256,
      previousStage: previous ? { stageId: previous.id, sha256: previous.sha256 } : null,
      actorUserId: userId,
      statement,
      finalizedAt: clock.now().toISOString(),
      evidence: media.map((m) => ({
        evidenceId: m.id,
        sha256: m.sha256,
        byteSize: Number(m.byte_size),
        objectKey: m.object_key,
        contentType: m.content_type,
        committedAt: new Date(m.committed_at).toISOString(),
      })),
    };
    const json = canonicalize(payload),
      hash = sha256Hex(json);
    await tx.query(
      "UPDATE commerce_stages SET finalized_at=$2,canonical_json=$3,sha256=$4 WHERE id=$1",
      [stageId, payload.finalizedAt, json, hash],
    );
    await appendAudit(tx, {
      proofId,
      actorUserId: userId,
      eventType: "LIFECYCLE_STAGE_FINALIZED",
      eventData: { stageId, type: stage.stage_type, sha256: hash },
      at: clock.now(),
    });
    return { stageId, sha256: hash, manifest: payload };
  });
}

export async function discardStageEvidence(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
  stageId: string,
  evidenceId: string,
) {
  return db.transaction(async (tx) => {
    const stage = await ownedStage(tx, proofId, stageId, userId);
    if (stage.finalized_at)
      throw new DomainError("COMMERCE_STAGE_IMMUTABLE", "This stage is finalized", 409);
    const media = (
      await tx.query<{ committed_at: unknown; discarded_at: unknown }>(
        "SELECT committed_at,discarded_at FROM commerce_stage_evidence WHERE id=$1 AND stage_id=$2 FOR UPDATE",
        [evidenceId, stageId],
      )
    ).rows[0];
    if (!media) throw new DomainError("EVIDENCE_NOT_FOUND", "Upload not found", 404);
    if (media.committed_at)
      throw new DomainError(
        "EVIDENCE_ALREADY_COMMITTED",
        "Preserved evidence cannot be discarded",
        409,
      );
    if (!media.discarded_at) {
      await tx.query("UPDATE commerce_stage_evidence SET discarded_at=$2 WHERE id=$1", [
        evidenceId,
        clock.now().toISOString(),
      ]);
      await appendAudit(tx, {
        proofId,
        actorUserId: userId,
        eventType: "LIFECYCLE_UPLOAD_DISCARDED",
        eventData: { stageId, evidenceId },
        at: clock.now(),
      });
    }
    return { discarded: true };
  });
}
