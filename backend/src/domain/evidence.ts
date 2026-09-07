import { eligibleCaptureSession, loadCaptureSession, assertCaptureRecoverable } from "./capture-sessions.js";
import { validateCapturedMediaStream } from "./capture-media.js";
import { MEDIA_MAX_BYTES, reserveMediaAdmission, validateAdmissionMetadata } from "./media-admission.js";
import { enqueueRecoveryEvent, buildProofRecoverySnapshot } from "./recovery-journal.js";
import { Readable } from "node:stream";
import { sha256Hex } from "../hash.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { evidenceObjectKey } from "../s3/object-key.js";
import type { ObjectStore, UploadTarget } from "../s3/object-store.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import {
  assertNotFinalized,
  authorizeProofAccess,
  getProofView,
  loadProof,
  requireParticipant,
  type ProofView,
} from "./proofs.js";
import { parseEvidenceType } from "./evidence-types.js";
import { asRequiredIso, type EvidenceRow } from "./types.js";
import { requireWorkflowType, rolesAllowedToSubmitEvidence } from "./workflow.js";

export interface EvidenceUploadView {
  evidenceId: string;
  proofId: string;
  objectKey: string;
  contentType: string;
  evidenceType: string;
  validationStatus: string;
  upload: UploadTarget;
}

export interface EvidenceCommitView {
  evidenceId: string;
  proofId: string;
  sha256: string;
  byteSize: number;
  validationStatus: string;
  committedAt: string;
  proof: ProofView;
}

export const MAX_EVIDENCE_BYTES = MEDIA_MAX_BYTES;

function objectKeyFor(proofId: string, evidenceId: string): string {
  return evidenceObjectKey(proofId, evidenceId);
}

export async function initializeEvidenceUpload(
  db: Database,
  clock: Clock,
  objectStore: ObjectStore,
  actorUserId: string,
  proofId: string,
  input: {
    contentType: string;
    evidenceType?: string;
    captureSessionId?: string;
    byteSize?: number;
    idempotencyKey: string;
  },
): Promise<EvidenceUploadView> {
  if (!input.idempotencyKey.trim()) {
    throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required", 400);
  }
  const contentType = input.contentType.trim();
  if (!contentType) {
    throw new DomainError("INVALID_CONTENT_TYPE", "contentType is required", 400);
  }
  const evidenceType = parseEvidenceType(input.evidenceType);
  validateAdmissionMetadata(contentType, input.byteSize);

  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    const participant = await requireParticipant(tx, proofId, actorUserId);
    const allowed = rolesAllowedToSubmitEvidence(
      requireWorkflowType(proof.workflow_type),
      evidenceType,
    );
    if (!allowed.includes(participant.role as "SELLER" | "BUYER")) {
      throw new DomainError(
        "PARTICIPANT_NOT_AUTHORIZED",
        "Not authorized to submit evidence on this Proof",
        403,
      );
    }

    if (proof.status !== "READY_FOR_EVIDENCE" && proof.status !== "EVIDENCE_COMMITTED") {
      throw new DomainError("INVALID_PROOF_TRANSITION", "Proof is not ready for evidence", 422);
    }

    const existing = await tx.query<EvidenceRow>(
      `SELECT * FROM evidence WHERE proof_id = $1 AND idempotency_key = $2`,
      [proofId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      assertUploadReplay(row, actorUserId, contentType, evidenceType, input.captureSessionId);
      if (row.validation_status === "REJECTED") {
        throw new DomainError(
          "EVIDENCE_UPLOAD_DISCARDED",
          "Start a new upload for a replacement recording",
          409,
        );
      }
      if (row.validation_status === "COMMITTED") {
        throw new DomainError(
          "EVIDENCE_ALREADY_COMMITTED",
          "Committed evidence cannot receive another upload authorization",
          409,
        );
      }
      if (evidenceType === "FULFILLMENT_CAPTURE") await eligibleCaptureSession(tx,clock,actorUserId,proofId,input.captureSessionId,contentType);
      const upload = await admittedTarget(tx, clock, objectStore, row, input.byteSize);
      return toUploadView(row, upload);
    }

    const capture = evidenceType === "FULFILLMENT_CAPTURE"
      ? await eligibleCaptureSession(tx,clock,actorUserId,proofId,input.captureSessionId,contentType) : null;
    if (capture?.evidence_id) throw new DomainError("CAPTURE_SESSION_ALREADY_USED", "This recording is already bound to another upload", 409);
    if (input.captureSessionId && !capture) throw new DomainError("CAPTURE_SESSION_CONFLICT", "Packing sessions are only used for primary packing capture", 409);
    const evidenceId = newId("evd");
    const objectKey = objectKeyFor(proofId, evidenceId);
    const now = clock.now().toISOString();

    try {
      await tx.query(
        `INSERT INTO evidence (
           id, proof_id, submitted_by, object_key, content_type, created_at,
           validation_status, evidence_type, idempotency_key, capture_session_id, capture_origin
         ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, $10)`,
        [
          evidenceId,
          proofId,
          actorUserId,
          objectKey,
          contentType,
          now,
          evidenceType,
          input.idempotencyKey,
          capture?.id ?? null,
          capture ? "AUTHORIZED_CAPTURE_SESSION" : "UPLOADED_ATTACHMENT",
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await tx.query<EvidenceRow>(
          `SELECT * FROM evidence WHERE proof_id = $1 AND idempotency_key = $2`,
          [proofId, input.idempotencyKey],
        );
        if (raced.rows[0]) {
          assertUploadReplay(raced.rows[0], actorUserId, contentType, evidenceType, input.captureSessionId);
          if (raced.rows[0].validation_status === "REJECTED") {
            throw new DomainError(
              "EVIDENCE_UPLOAD_DISCARDED",
              "Start a new upload for a replacement recording",
              409,
            );
          }
          if (raced.rows[0].validation_status === "COMMITTED") {
            throw new DomainError(
              "EVIDENCE_ALREADY_COMMITTED",
              "Committed evidence cannot receive another upload authorization",
              409,
            );
          }
          const upload = await admittedTarget(tx, clock, objectStore, raced.rows[0], input.byteSize);
          return toUploadView(raced.rows[0], upload);
        }
      }
      throw error;
    }

    if (capture) await tx.query("UPDATE capture_sessions SET state='UPLOADING', evidence_id=$2 WHERE id=$1", [capture.id,evidenceId]);
    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "EVIDENCE_UPLOAD_CREATED",
      eventData: { evidenceId, objectKey, evidenceType },
      at: clock.now(),
    });

    const upload = await reserveMediaAdmission(tx, clock, objectStore, {
      evidenceId, actorUserId, stagingKey: objectKey, contentType,
      declaredBytes: capture ? Number(capture.expected_byte_size) : input.byteSize,
    });

    return {
      evidenceId,
      proofId,
      objectKey,
      contentType,
      evidenceType,
      validationStatus: "PENDING",
      upload,
    };
  });
}

async function admittedTarget(tx: Database, clock: Clock, store: ObjectStore, row: EvidenceRow, byteSize?: number): Promise<UploadTarget> {
  let declaredBytes=byteSize;
  if(row.capture_session_id) {
    const capture=(await tx.query<{expected_byte_size:string|number}>("SELECT expected_byte_size FROM capture_sessions WHERE id=$1",[row.capture_session_id])).rows[0];
    if(capture) declaredBytes=Number(capture.expected_byte_size);
    if(byteSize!==undefined && byteSize!==declaredBytes) throw new DomainError("UPLOAD_SIZE_MISMATCH","Upload size differs from its registered recording",409);
  }
  return reserveMediaAdmission(tx,clock,store,{evidenceId:row.id,actorUserId:row.submitted_by,stagingKey:row.object_key,contentType:row.content_type,declaredBytes});
}

function assertUploadReplay(
  row: EvidenceRow,
  actorUserId: string,
  contentType: string,
  evidenceType: string,
  captureSessionId?: string,
): void {
  if (row.submitted_by !== actorUserId) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "This upload belongs to another participant",
      403,
    );
  }
  if ((row.capture_session_id ?? undefined) !== captureSessionId) {
    throw new DomainError("EVIDENCE_UPLOAD_CONFLICT", "An upload retry cannot change its recording", 409);
  }
  if (row.content_type !== contentType || row.evidence_type !== evidenceType) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "This upload key already identifies different evidence metadata",
      409,
    );
  }
}

function toUploadView(row: EvidenceRow, upload: UploadTarget): EvidenceUploadView {
  return {
    evidenceId: row.id,
    proofId: row.proof_id,
    objectKey: row.object_key,
    contentType: row.content_type,
    evidenceType: row.evidence_type,
    validationStatus: row.validation_status,
    upload,
  };
}

export async function commitEvidence(
  db: Database,
  clock: Clock,
  objectStore: ObjectStore,
  actorUserId: string,
  proofId: string,
  evidenceId: string,
  clientSha256?: string,
): Promise<EvidenceCommitView> {
  const prepared = await db.transaction(async (tx) => {
    return loadEvidenceForCommit(tx, clock, actorUserId, proofId, evidenceId);
  });
  if (prepared.committed) {
    return prepared.committed;
  }

  const expectedSession=prepared.captureSessionId?await loadCaptureSession(db,actorUserId,proofId,prepared.captureSessionId):null;
  let committedObject:Awaited<ReturnType<ObjectStore['commitUpload']>>;
  try { committedObject=await objectStore.commitUpload(prepared.objectKey,{sha256:clientSha256??expectedSession?.expected_sha256??undefined,byteSize:expectedSession?Number(expectedSession.expected_byte_size):undefined,contentType:prepared.contentType,maxBytes:MAX_EVIDENCE_BYTES}); }
  catch(error) {
    if(expectedSession&&!clientSha256&&error instanceof DomainError&&['EVIDENCE_SIZE_MISMATCH','EVIDENCE_HASH_MISMATCH'].includes(error.code))throw new DomainError('CAPTURE_RECORDING_MISMATCH','Uploaded bytes differ from the recording registered to this session',422);
    throw error;
  }
  if (!committedObject) {
    throw new DomainError("EVIDENCE_OBJECT_MISSING", "Uploaded object was not found", 409);
  }
  if (!Number.isSafeInteger(committedObject.byteSize) || committedObject.byteSize < 1 ||
    committedObject.byteSize > MAX_EVIDENCE_BYTES) {
    throw new DomainError(
      "INVALID_EVIDENCE_SIZE",
      "Evidence must contain between 1 byte and 250 MB",
      422,
    );
  }
  if (!contentTypesCompatible(committedObject.contentType, prepared.contentType)) {
    throw new DomainError(
      "EVIDENCE_METADATA_MISMATCH",
      "Uploaded object content type does not match the pending evidence record",
      422,
    );
  }
  if (clientSha256 && clientSha256.toLowerCase() !== committedObject.sha256) {
    throw new DomainError(
      "EVIDENCE_HASH_MISMATCH",
      "Client hash does not match independently computed SHA-256",
      422,
    );
  }

  let capturedDurationMs: number | null = null;
  if (prepared.captureSessionId) {
    const session = await loadCaptureSession(db,actorUserId,proofId,prepared.captureSessionId);
    if (committedObject.sha256 !== session.expected_sha256 || committedObject.byteSize !== Number(session.expected_byte_size))
      throw new DomainError("CAPTURE_RECORDING_MISMATCH", "Uploaded bytes differ from the recording registered to this session", 422);
    if(!objectStore.getStream) {
      // Compatibility for explicitly supplied in-memory test adapters only.
      const original=await objectStore.get(committedObject.key,{versionId:committedObject.versionId});
      if(!original) throw new DomainError("EVIDENCE_INTEGRITY_FAILURE","The stored original is unavailable",409);
      capturedDurationMs=(await validateCapturedMediaStream(Readable.from([original.body]),prepared.contentType,{byteSize:committedObject.byteSize,sha256:committedObject.sha256,maxDurationMs:(session as typeof session & {max_duration_ms?:number|null}).max_duration_ms??1_800_000})).durationMs;
    } else {
      const original=await objectStore.getStream(committedObject.key,{versionId:committedObject.versionId});
      if(!original) throw new DomainError("EVIDENCE_INTEGRITY_FAILURE","The stored original is unavailable",409);
      capturedDurationMs=(await validateCapturedMediaStream(original.body,prepared.contentType,{byteSize:committedObject.byteSize,sha256:committedObject.sha256,maxDurationMs:(session as typeof session & {max_duration_ms?:number|null}).max_duration_ms??1_800_000})).durationMs;
    }
  }

  return db.transaction(async (tx) => {
    const current = await loadEvidenceForCommit(tx, clock, actorUserId, proofId, evidenceId);
    if (current.committed) {
      return current.committed;
    }

    const now = clock.now().toISOString();
    await tx.query(
      `UPDATE evidence
          SET object_key = $2,
              sha256 = $3,
              byte_size = $4,
              committed_at = $5,
              validation_status = 'COMMITTED',
              captured_duration_ms = $6,
              object_version_id = $7,
              staging_version_id = $8
        WHERE id = $1 AND committed_at IS NULL`,
      [evidenceId, committedObject.key, committedObject.sha256, committedObject.byteSize, now, capturedDurationMs, committedObject.versionId ?? null, committedObject.stagingVersionId ?? null],
    );

    await tx.query("UPDATE evidence_upload_admissions SET state='COMMITTED',staging_version_id=COALESCE($2,staging_version_id),lease_token=NULL,lease_until=NULL WHERE evidence_id=$1",[evidenceId,committedObject.stagingVersionId??null]);
    if (current.captureSessionId) await tx.query("UPDATE capture_sessions SET state='COMMITTED',verified_duration_ms=$2 WHERE id=$1",[current.captureSessionId,capturedDurationMs]);
    if (current.proofStatus === "READY_FOR_EVIDENCE") {
      await tx.query(
        `UPDATE proofs SET status = 'EVIDENCE_COMMITTED', updated_at = $2 WHERE id = $1`,
        [proofId, now],
      );
    } else {
      await tx.query(`UPDATE proofs SET updated_at = $2 WHERE id = $1`, [proofId, now]);
    }

    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "EVIDENCE_COMMITTED",
      eventData: {
        evidenceId,
        sha256: committedObject.sha256,
        byteSize: committedObject.byteSize,
        objectKey: committedObject.key,
        objectVersionId: committedObject.versionId ?? null,
      },
      at: clock.now(),
    });

    await enqueueRecoveryEvent(tx, clock, {operationId:`evidence:${evidenceId}`,kind:'EVIDENCE_COMMITTED',proofId,actorUserId,payload:await buildProofRecoverySnapshot(tx,proofId)});
    return {
      evidenceId,
      proofId,
      sha256: committedObject.sha256,
      byteSize: committedObject.byteSize,
      validationStatus: "COMMITTED",
      committedAt: now,
      proof: await getProofView(tx, proofId),
    };
  });
}

async function loadEvidenceForCommit(
  tx: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  evidenceId: string,
): Promise<
  | {
      committed: EvidenceCommitView;
      objectKey?: never;
      contentType?: never;
      proofStatus?: never;
      captureSessionId?: never;
    }
  | {
      committed: null;
      objectKey: string;
      contentType: string;
      proofStatus: string;
      captureSessionId: string | null;
    }
> {
  const proof = await loadProof(tx, proofId, true);
  const participant = await requireParticipant(tx, proofId, actorUserId);

  const found = await tx.query<EvidenceRow>(
    `SELECT * FROM evidence WHERE id = $1 AND proof_id = $2 FOR UPDATE`,
    [evidenceId, proofId],
  );
  const evidence = found.rows[0];
  if (!evidence) {
    throw new DomainError("EVIDENCE_NOT_FOUND", "Evidence not found", 404);
  }
  const allowed = rolesAllowedToSubmitEvidence(
    requireWorkflowType(proof.workflow_type),
    evidence.evidence_type,
  );
  if (
    !allowed.includes(participant.role as "SELLER" | "BUYER") ||
    evidence.submitted_by !== actorUserId
  ) {
    throw new DomainError(
      "PARTICIPANT_NOT_AUTHORIZED",
      "Only the submitting participant can commit this evidence",
      403,
    );
  }

  if (evidence.validation_status === "COMMITTED" && evidence.sha256 && evidence.committed_at) {
    return {
      committed: {
        evidenceId: evidence.id,
        proofId,
        sha256: evidence.sha256,
        byteSize: Number(evidence.byte_size ?? 0),
        validationStatus: evidence.validation_status,
        committedAt: asRequiredIso(evidence.committed_at),
        proof: await getProofView(tx, proofId),
      },
    };
  }

  if (evidence.validation_status === "REJECTED") {
    throw new DomainError(
      "EVIDENCE_UPLOAD_DISCARDED",
      "Discarded uploads cannot be committed",
      409,
    );
  }

  assertNotFinalized(proof);
  if (proof.status !== "READY_FOR_EVIDENCE" && proof.status !== "EVIDENCE_COMMITTED") {
    throw new DomainError(
      "INVALID_PROOF_TRANSITION",
      "Proof is not ready for evidence commitment",
      422,
    );
  }

  if (evidence.evidence_type === "FULFILLMENT_CAPTURE") {
    if (!evidence.capture_session_id) throw new DomainError("CAPTURE_SESSION_REQUIRED", "An old unfinished upload cannot be relabeled as direct capture; start a new recording", 422);
    const session=await loadCaptureSession(tx,actorUserId,proofId,evidence.capture_session_id,true);
    assertCaptureRecoverable(session,clock);
    if (session.evidence_id !== evidence.id) throw new DomainError("CAPTURE_SESSION_CONFLICT", "Capture belongs to another evidence upload",409);
  }
  return {
    committed: null,
    captureSessionId: evidence.capture_session_id ?? null,
    objectKey: evidence.object_key,
    contentType: evidence.content_type,
    proofStatus: proof.status,
  };
}

function contentTypesCompatible(stored: string, expected: string): boolean {
  const storedType = mediaType(stored);
  const expectedType = mediaType(expected);
  if (!storedType || !expectedType) {
    return true;
  }
  return storedType === expectedType;
}

function mediaType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

export async function readCommittedEvidence(
  db: Database,
  objectStore: ObjectStore,
  actorUserId: string,
  proofId: string,
  evidenceId: string,
): Promise<{ body: Buffer; contentType: string; evidenceId: string }> {
  await authorizeProofAccess(db, proofId, actorUserId);
  const found = await db.query<EvidenceRow>(
    `SELECT * FROM evidence WHERE id = $1 AND proof_id = $2`,
    [evidenceId, proofId],
  );
  const row = found.rows[0];
  if (!row || row.validation_status !== "COMMITTED") {
    throw new DomainError("EVIDENCE_NOT_FOUND", "Evidence not found", 404);
  }
  const stored = await objectStore.get(row.object_key, {versionId: (row as EvidenceRow & {object_version_id?:string|null}).object_version_id});
  if (!stored) {
    throw new DomainError("EVIDENCE_NOT_FOUND", "Evidence is not available", 404);
  }
  if (sha256Hex(stored.body) !== row.sha256 || stored.body.length !== Number(row.byte_size)) {
    throw new DomainError(
      "EVIDENCE_INTEGRITY_FAILURE",
      "Stored evidence does not match its committed digest",
      409,
    );
  }
  return {
    body: stored.body,
    contentType: stored.contentType || row.content_type,
    evidenceId: row.id,
  };
}

export interface EvidenceStreamView {
  body: Readable | null;
  contentType: string;
  evidenceId: string;
  sha256: string;
  byteSize: number;
  status: 200 | 206 | 416;
  headers: Record<string,string>;
}
export function parseEvidenceByteRange(value:string|undefined,total:number):{start:number;end:number}|null|'unsatisfiable'{
  if(!value)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if(!match||(!match[1]&&!match[2])||total<1)return 'unsatisfiable';
  let start:number,end:number;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<1)return 'unsatisfiable';start=Math.max(0,total-suffix);end=total-1;}
  else{start=Number(match[1]);end=match[2]?Number(match[2]):total-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=total||end<start)return 'unsatisfiable';
  return {start,end:Math.min(end,total-1)};
}
/** Only an authorized, exact-version range reaches storage. Newly committed S3
 * rows always include VersionId. Legacy rows are stream-verified before serving. */
export async function readCommittedEvidenceStream(db:Database,store:ObjectStore,userId:string,proofId:string,evidenceId:string,rangeHeader?:string):Promise<EvidenceStreamView>{
  await authorizeProofAccess(db,proofId,userId);
  const row=(await db.query<EvidenceRow & {object_version_id?:string|null}>('SELECT * FROM evidence WHERE id=$1 AND proof_id=$2',[evidenceId,proofId])).rows[0];
  if(!row||row.validation_status!=='COMMITTED'||!row.sha256)throw new DomainError('EVIDENCE_NOT_FOUND','Evidence is unavailable',404);
  return streamPreservedObject(store,row,rangeHeader);
}
export async function streamPreservedObject(store:ObjectStore,row:{id:string;object_key:string;content_type:string;sha256:string|null;byte_size:number|string|null;object_version_id?:string|null},rangeHeader?:string):Promise<EvidenceStreamView>{
  if(!row.sha256)throw new DomainError('EVIDENCE_NOT_FOUND','Evidence is unavailable',404);
  const total=Number(row.byte_size),range=parseEvidenceByteRange(rangeHeader,total);
  const headers:Record<string,string>={'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','ETag':`"sha256-${row.sha256}"`,'Content-Type':row.content_type};
  if(range==='unsatisfiable')return {body:null,contentType:row.content_type,evidenceId:row.id,sha256:row.sha256,byteSize:0,status:416,headers:{...headers,'Content-Range':`bytes */${total}`,'Content-Length':'0'}};
  let versionId=row.object_version_id;
  if(!versionId&&store.head){
    const metadata=await store.head(row.object_key);if(!metadata)throw new DomainError('EVIDENCE_NOT_FOUND','Evidence is unavailable',404);
    // This is a bounded-memory compatibility path, not a claimed constant-I/O
    // legacy range path. Backfill must preserve immutable evidence history.
    const verified=await store.digest(row.object_key,{versionId:metadata.versionId});
    if(!verified||verified.sha256!==row.sha256||verified.byteSize!==total)throw new DomainError('EVIDENCE_INTEGRITY_FAILURE','The stored original failed integrity verification',409);
    versionId=metadata.versionId;
  }
  let body:Readable;
  if(store.getStream){
    const source=await store.getStream(row.object_key,{versionId,...(range??{})});
    if(!source)throw new DomainError('EVIDENCE_NOT_FOUND','Evidence is unavailable',404);
    if(versionId&&source.versionId!==versionId){source.body.destroy();throw new DomainError('EVIDENCE_VERSION_MISMATCH','The exact preserved version is unavailable',409);}
    const expectedLength=range?range.end-range.start+1:total;
    if(source.byteSize!==expectedLength){source.body.destroy();throw new DomainError('EVIDENCE_INTEGRITY_FAILURE','Storage returned an unexpected range length',409);}
    body=source.body;
  }else{
    if(total>5*1024*1024)throw new DomainError('STREAMING_STORAGE_REQUIRED','Playback requires a streaming storage adapter',503);
    const full=await store.get(row.object_key,{versionId});
    if(!full||sha256Hex(full.body)!==row.sha256||full.body.length!==total)throw new DomainError('EVIDENCE_INTEGRITY_FAILURE','Stored source failed verification',409);
    body=Readable.from([range?full.body.subarray(range.start,range.end+1):full.body]);
  }
  const length=range?range.end-range.start+1:total;
  headers['Content-Length']=String(length);
  if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${total}`;
  return {body,contentType:row.content_type,evidenceId:row.id,sha256:row.sha256,byteSize:length,status:range?206:200,headers};
}
