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
      throw new DomainError(
        "INVALID_PROOF_TRANSITION",
        "Proof is not ready for evidence",
        422,
      );
    }

    const existing = await tx.query<EvidenceRow>(
      `SELECT * FROM evidence WHERE proof_id = $1 AND idempotency_key = $2`,
      [proofId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.validation_status === "COMMITTED") {
        throw new DomainError(
          "EVIDENCE_ALREADY_COMMITTED",
          "Committed evidence cannot receive another upload authorization",
          409,
        );
      }
      const upload = await objectStore.createUploadTarget({
        key: row.object_key,
        contentType: row.content_type,
      });
      return toUploadView(row, upload);
    }

    const evidenceId = newId("evd");
    const objectKey = objectKeyFor(proofId, evidenceId);
    const now = clock.now().toISOString();

    try {
      await tx.query(
        `INSERT INTO evidence (
           id, proof_id, submitted_by, object_key, content_type, created_at,
           validation_status, evidence_type, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8)`,
        [
          evidenceId,
          proofId,
          actorUserId,
          objectKey,
          contentType,
          now,
          evidenceType,
          input.idempotencyKey,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await tx.query<EvidenceRow>(
          `SELECT * FROM evidence WHERE proof_id = $1 AND idempotency_key = $2`,
          [proofId, input.idempotencyKey],
        );
        if (raced.rows[0]) {
          if (raced.rows[0].validation_status === "COMMITTED") {
            throw new DomainError(
              "EVIDENCE_ALREADY_COMMITTED",
              "Committed evidence cannot receive another upload authorization",
              409,
            );
          }
          const upload = await objectStore.createUploadTarget({
            key: raced.rows[0].object_key,
            contentType: raced.rows[0].content_type,
          });
          return toUploadView(raced.rows[0], upload);
        }
      }
      throw error;
    }

    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "EVIDENCE_UPLOAD_CREATED",
      eventData: { evidenceId, objectKey, evidenceType },
      at: clock.now(),
    });

    const upload = await objectStore.createUploadTarget({
      key: objectKey,
      contentType,
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
    return loadEvidenceForCommit(tx, actorUserId, proofId, evidenceId);
  });
  if (prepared.committed) {
    return prepared.committed;
  }

  const committedObject = await objectStore.commitUpload(prepared.objectKey);
  if (!committedObject) {
    throw new DomainError(
      "EVIDENCE_OBJECT_MISSING",
      "Uploaded object was not found",
      409,
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

  return db.transaction(async (tx) => {
    const current = await loadEvidenceForCommit(tx, actorUserId, proofId, evidenceId);
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
              validation_status = 'COMMITTED'
        WHERE id = $1 AND committed_at IS NULL`,
      [
        evidenceId,
        committedObject.key,
        committedObject.sha256,
        committedObject.byteSize,
        now,
      ],
    );

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
      },
      at: clock.now(),
    });

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
  actorUserId: string,
  proofId: string,
  evidenceId: string,
): Promise<
  | { committed: EvidenceCommitView; objectKey?: never; contentType?: never; proofStatus?: never }
  | { committed: null; objectKey: string; contentType: string; proofStatus: string }
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
  if (!allowed.includes(participant.role as "SELLER" | "BUYER") || evidence.submitted_by !== actorUserId) {
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

  assertNotFinalized(proof);
  if (proof.status !== "READY_FOR_EVIDENCE" && proof.status !== "EVIDENCE_COMMITTED") {
    throw new DomainError(
      "INVALID_PROOF_TRANSITION",
      "Proof is not ready for evidence commitment",
      422,
    );
  }

  return {
    committed: null,
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
  const stored = await objectStore.get(row.object_key);
  if (!stored) {
    throw new DomainError("EVIDENCE_NOT_FOUND", "Evidence is not available", 404);
  }
  return {
    body: stored.body,
    contentType: stored.contentType || row.content_type,
    evidenceId: row.id,
  };
}
