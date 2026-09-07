import { Readable } from "node:stream";
import { MEDIA_MAX_BYTES, reserveMediaAdmission } from "./media-admission.js";
import { enqueueRecoveryEvent, buildProofRecoverySnapshot, getRecoveryStatus, requireDurableOperation } from "./recovery-journal.js";
import { appendProofSupplementInTransaction } from "./proof-supplements.js";
import type { ManifestSigner } from "./manifest-signing.js";
import { assertPolicyAccessSafe } from "./policy-recovery.js";
import { eligibleCaptureSession, readCaptureClientContext } from "./capture-sessions.js";
import { validateCapturedMediaStream } from "./capture-media.js";
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
  await assertPolicyAccessSafe(db);
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
      evidence: await Promise.all((
        await db.query<{captureSessionId:string|null;[key:string]:unknown}>(
          `SELECT id AS "evidenceId",content_type AS "contentType",byte_size AS "byteSize",sha256,committed_at AS "committedAt",capture_origin AS "captureOrigin",capture_session_id AS "captureSessionId",captured_duration_ms AS "capturedDurationMs",CASE WHEN capture_session_id IS NULL THEN 'UNKNOWN' WHEN EXISTS(SELECT 1 FROM capture_sessions c WHERE c.id=capture_session_id AND c.recorded_at>c.expires_at) THEN 'DELAYED_NOT_INDEPENDENTLY_ATTESTED' ELSE 'WITHIN_START_WINDOW' END AS "captureRegistrationTiming" FROM commerce_stage_evidence WHERE stage_id=$1 AND discarded_at IS NULL ORDER BY created_at,id`,
          [s.id],
        )
      ).rows.map(async row=>({...row,clientReportedCapture:row.captureSessionId?await readCaptureClientContext(db,row.captureSessionId):null}))),
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
  input: { contentType?: unknown; idempotencyKey?: unknown; captureSessionId?: unknown; byteSize?: number },
) {
  if (
    typeof input.contentType !== "string" ||
    !/^(video\/(mp4|webm|quicktime)|image\/(jpeg|png))$/.test(input.contentType.split(";")[0].trim().toLowerCase()) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  )
    throw new DomainError(
      "INVALID_EVIDENCE",
      "A supported media type and upload key are required",
      400,
    );
  const contentType = input.contentType.split(";")[0].trim().toLowerCase(),
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
        capture_session_id: string | null;
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
    const capture=contentType.startsWith("video/") ? await eligibleCaptureSession(tx,clock,userId,proofId,typeof input.captureSessionId==="string"?input.captureSessionId:undefined,contentType,stageId) : null;
    if (existing && (existing.capture_session_id??null)!==(capture?.id??null)) throw new DomainError("CAPTURE_SESSION_CONFLICT","A retry cannot change its stage recording",409);
    if(capture?.evidence_id && capture.evidence_id!==existing?.id) throw new DomainError("CAPTURE_SESSION_ALREADY_USED","This recording belongs to another upload",409);
    if(input.captureSessionId && !capture) throw new DomainError("CAPTURE_SESSION_CONFLICT","Supporting images do not use a video capture session",409);
    const id = existing?.id ?? newId("media"),
      objectKey = existing?.object_key ?? `evidence/${proofId}/${id}/object`;
    if (!existing)
      await tx.query(
        "INSERT INTO commerce_stage_evidence(id,stage_id,idempotency_key,object_key,content_type,created_at,capture_session_id,capture_origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, stageId, key, objectKey, contentType, clock.now().toISOString(),capture?.id??null,capture?"AUTHORIZED_CAPTURE_SESSION":"UPLOADED_ATTACHMENT"],
      );
    if(capture) await tx.query("UPDATE capture_sessions SET state='UPLOADING',evidence_id=$2 WHERE id=$1",[capture.id,id]);
    return {
      evidenceId: id,
      upload: await reserveMediaAdmission(tx,clock,store,{evidenceId:id,actorUserId:userId,stagingKey:objectKey,contentType,declaredBytes:capture?Number(capture.expected_byte_size):input.byteSize,sourceKind:"STAGE"}),
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
        capture_session_id:string|null;
      }>(
        "SELECT * FROM commerce_stage_evidence WHERE id=$1 AND stage_id=$2 AND discarded_at IS NULL FOR UPDATE",
        [evidenceId, stageId],
      )
    ).rows[0];
    if (!row) throw new DomainError("EVIDENCE_NOT_FOUND", "Stage evidence not found", 404);
    if (row.sha256) return { evidenceId, sha256: row.sha256 };
    const capture=row.capture_session_id ? await eligibleCaptureSession(tx,clock,userId,proofId,row.capture_session_id,row.content_type,stageId) : null;
    if (row.content_type.startsWith("video/") && !capture) throw new DomainError("CAPTURE_SESSION_REQUIRED","Start a new authorized recording for this unfinished stage upload",422);
    if(capture && capture.evidence_id!==evidenceId) throw new DomainError("CAPTURE_SESSION_CONFLICT","Stage capture is bound to another upload",409);
    const object = await store.commitUpload(row.object_key,{sha256:typeof expectedHash === 'string' ? expectedHash : capture?.expected_sha256??undefined,byteSize:capture?Number(capture.expected_byte_size):undefined,contentType:row.content_type,maxBytes:250000000});
    if (!object) throw new DomainError("EVIDENCE_OBJECT_MISSING", "Upload recording first", 409);
    if (
      object.byteSize > MEDIA_MAX_BYTES ||
      object.byteSize === 0 ||
      object.contentType.split(";")[0].trim().toLowerCase() !== row.content_type ||
      (expectedHash != null && expectedHash !== object.sha256)
    )
      throw new DomainError(
        "EVIDENCE_INTEGRITY_FAILURE",
        "Uploaded recording does not match expected metadata",
        422,
      );
    let durationMs:number|null=null;
    if(capture) {
      if(capture.expected_sha256!==object.sha256 || Number(capture.expected_byte_size)!==object.byteSize) throw new DomainError("CAPTURE_RECORDING_MISMATCH","Uploaded bytes differ from this stage recording",422);
      const original=store.getStream?await store.getStream(object.key,{versionId:object.versionId}):null;
      const fallback=!store.getStream?await store.get(object.key,{versionId:object.versionId}):null;
      if(!original&&!fallback)throw new DomainError("EVIDENCE_INTEGRITY_FAILURE","Stored stage original is unavailable",409);
      durationMs=(await validateCapturedMediaStream(original?.body??Readable.from([fallback!.body]),row.content_type,{byteSize:object.byteSize,sha256:object.sha256,maxDurationMs:(capture as typeof capture & {max_duration_ms?:number|null}).max_duration_ms??1_800_000})).durationMs;
    }
    await tx.query(
      "UPDATE commerce_stage_evidence SET object_key=$2,sha256=$3,byte_size=$4,committed_at=$5,captured_duration_ms=$6,object_version_id=$7,staging_version_id=$8 WHERE id=$1",
      [evidenceId, object.key, object.sha256, object.byteSize, clock.now().toISOString(),durationMs,object.versionId??null,object.stagingVersionId??null],
    );
    if(capture) await tx.query("UPDATE capture_sessions SET state='COMMITTED',verified_duration_ms=$2 WHERE id=$1",[capture.id,durationMs]);
    await appendAudit(tx, {
      proofId,
      actorUserId: userId,
      eventType: "LIFECYCLE_EVIDENCE_COMMITTED",
      eventData: { stageId, evidenceId, sha256: object.sha256 },
      at: clock.now(),
    });
    await tx.query("UPDATE evidence_upload_admissions SET state='COMMITTED',staging_version_id=COALESCE($2,staging_version_id) WHERE evidence_id=$1",[evidenceId,object.stagingVersionId??null]);
    await enqueueRecoveryEvent(tx,clock,{operationId:`stage-evidence:${evidenceId}`,kind:'EVIDENCE_COMMITTED',proofId,actorUserId:userId,payload:await buildProofRecoverySnapshot(tx,proofId)});
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
  signer?: ManifestSigner,
  options: {requireDurableReceipts?: boolean} = {},
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
        recovery: await getRecoveryStatus(tx, `stage-finalize:${stageId}`),
      };
    const media = (
      await tx.query<{
        id: string;
        sha256: string | null;
        object_key: string;
        content_type: string;
        byte_size: string;
        committed_at: Date | string;
        capture_session_id:string|null;
        capture_origin:string;
        object_version_id?:string|null;
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
    if(options.requireDurableReceipts) {
      if(!signer) throw new DomainError("MANIFEST_SIGNING_UNAVAILABLE", "Stage signing is temporarily unavailable", 503);
      for(const row of media) await requireDurableOperation(tx,`stage-evidence:${row.id}`);
    }
    const eligibleCaptures=(await tx.query<{id:string;policy_version:string;client:string;recorded_at:string|Date;expires_at:string|Date}>(`SELECT c.id,c.policy_version,c.client,c.recorded_at,c.expires_at FROM capture_sessions c JOIN commerce_stage_evidence e ON e.id=c.evidence_id WHERE c.proof_id=$1 AND c.stage_id=$2 AND c.actor_user_id=$3 AND c.state='COMMITTED' AND c.expected_sha256=e.sha256 AND c.expected_byte_size=e.byte_size AND e.capture_session_id=c.id`,[proofId,stageId,userId])).rows;
    const captureContexts=new Map(await Promise.all(eligibleCaptures.map(async capture=>[capture.id,await readCaptureClientContext(tx,capture.id)] as const)));
    if(!media.some(m=>m.capture_origin==='LEGACY_UNKNOWN' || eligibleCaptures.some(c=>c.id===m.capture_session_id))) throw new DomainError("STAGE_CAPTURE_REQUIRED","An authorized stage recording is required; supporting images cannot replace it",422);
    if(media.some(m=>m.capture_session_id && !eligibleCaptures.some(c=>c.id===m.capture_session_id))) throw new DomainError("CAPTURE_SESSION_CONFLICT","A committed stage recording has conflicting session context",409);
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
        ...(m.capture_session_id ? {capture:{sessionId:m.capture_session_id,clientReportedCapture:captureContexts.get(m.capture_session_id)??null,policyVersion:eligibleCaptures.find(c=>c.id===m.capture_session_id)?.policy_version,client:eligibleCaptures.find(c=>c.id===m.capture_session_id)?.client,registrationTiming:new Date(eligibleCaptures.find(c=>c.id===m.capture_session_id)!.recorded_at).getTime()>new Date(eligibleCaptures.find(c=>c.id===m.capture_session_id)!.expires_at).getTime()?"DELAYED_NOT_INDEPENDENTLY_ATTESTED":"WITHIN_START_WINDOW",assurance:"Authorized workflow; physical camera origin and offline timing are not independently attested."}} : {}),
        sha256: m.sha256,
        byteSize: Number(m.byte_size),
        objectKey: m.object_key,
        ...(m.object_version_id ? {objectVersionId:m.object_version_id} : {}),
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
    if(signer) await appendProofSupplementInTransaction(tx,clock,signer,userId,proofId,{operationId:`stage:${stageId}`,kind:stage.stage_type === 'RECEIPT' ? 'RECIPIENT_RESPONSE' : 'RETURN',facts:{stage:payload},sourceReference:stageId});
    const recovery=await enqueueRecoveryEvent(tx,clock,{operationId:`stage-finalize:${stageId}`,kind:'STAGE_FINALIZED',proofId,actorUserId:userId,payload:await buildProofRecoverySnapshot(tx,proofId)});
    return { stageId, sha256: hash, manifest: payload, recovery };
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
      await tx.query("UPDATE evidence_upload_admissions SET state='DISCARDED' WHERE evidence_id=$1",[evidenceId]);
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
