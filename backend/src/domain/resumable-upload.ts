import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import type { ObjectStore } from "../s3/object-store.js";
import { sha256Hex } from "../hash.js";
import { DomainError } from "./errors.js";
import { requireParticipant, loadProof } from "./proof-access.js";
import type { EvidenceRow } from "./types.js";
import { appendAudit } from "./audit.js";

export async function discardPendingUpload(
  db: Database,
  clock: Clock,
  userId: string,
  proofId: string,
  idempotencyKey: string,
) {
  if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 200)
    throw new DomainError("INVALID_REQUEST", "Upload key is required", 400);
  return db.transaction(async (tx) => {
    await loadProof(tx, proofId, true);
    await requireParticipant(tx, proofId, userId);
    const result = await tx.query<EvidenceRow>(
      "SELECT * FROM evidence WHERE proof_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [proofId, idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return { discarded: true };
    if (row.submitted_by !== userId)
      throw new DomainError(
        "PARTICIPANT_NOT_AUTHORIZED",
        "This upload belongs to another participant",
        403,
      );
    if (row.validation_status === "COMMITTED")
      throw new DomainError(
        "EVIDENCE_ALREADY_COMMITTED",
        "Committed evidence cannot be discarded",
        409,
      );
    if (row.validation_status !== "REJECTED") {
      await tx.query("UPDATE evidence SET validation_status='REJECTED' WHERE id=$1", [row.id]);
      await appendAudit(tx, {
        proofId,
        actorUserId: userId,
        eventType: "EVIDENCE_UPLOAD_DISCARDED",
        eventData: { evidenceId: row.id },
        at: clock.now(),
      });
    }
    return { discarded: true };
  });
}

export const UPLOAD_PART_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_PARTS = 40;
async function pendingEvidence(
  db: Database,
  userId: string,
  proofId: string,
  evidenceId: string,
  lock = false,
) {
  const proof = await loadProof(db, proofId, lock);
  await requireParticipant(db, proofId, userId);
  const found = await db.query<EvidenceRow>(
    `SELECT * FROM evidence WHERE id=$1 AND proof_id=$2${lock ? " FOR UPDATE" : ""}`,
    [evidenceId, proofId],
  );
  const evidence = found.rows[0];
  if (!evidence || evidence.submitted_by !== userId)
    throw new DomainError("EVIDENCE_NOT_FOUND", "Upload not found", 404);
  if (proof.status === "FINALIZED" || evidence.validation_status !== "PENDING")
    throw new DomainError("EVIDENCE_ALREADY_COMMITTED", "This upload is closed", 409);
  return evidence;
}
export async function listUploadParts(
  db: Database,
  userId: string,
  proofId: string,
  evidenceId: string,
) {
  await pendingEvidence(db, userId, proofId, evidenceId);
  return {
    partSize: UPLOAD_PART_BYTES,
    maxParts: MAX_UPLOAD_PARTS,
    parts: (
      await db.query(
        `SELECT part_number AS "partNumber",byte_size AS "byteSize",sha256 FROM evidence_upload_parts WHERE evidence_id=$1 ORDER BY part_number`,
        [evidenceId],
      )
    ).rows,
  };
}
export async function storeUploadPart(
  db: Database,
  clock: Clock,
  store: ObjectStore,
  userId: string,
  proofId: string,
  evidenceId: string,
  partNumber: number,
  bytes: Buffer,
) {
  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > MAX_UPLOAD_PARTS ||
    !bytes.length ||
    bytes.length > UPLOAD_PART_BYTES
  )
    throw new DomainError("INVALID_UPLOAD_PART", "Use up to 40 parts, each at most 5 MiB", 400);
  const digest = sha256Hex(bytes);
  return db.transaction(async (tx) => {
    const evidence = await pendingEvidence(tx, userId, proofId, evidenceId, true);
    const existing = await tx.query<{ sha256: string }>(
      "SELECT sha256 FROM evidence_upload_parts WHERE evidence_id=$1 AND part_number=$2",
      [evidenceId, partNumber],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].sha256 !== digest)
        throw new DomainError(
          "UPLOAD_PART_CONFLICT",
          "This part number already contains different bytes",
          409,
        );
      return {
        partNumber,
        sha256: digest,
        byteSize: bytes.length,
        replayed: true,
      };
    }
    const key = `${evidence.object_key}.parts/${partNumber}-${digest}`;
    await store.put(key, bytes, "application/octet-stream");
    await tx.query(
      "INSERT INTO evidence_upload_parts(evidence_id,part_number,object_key,sha256,byte_size,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [evidenceId, partNumber, key, digest, bytes.length, clock.now().toISOString()],
    );
    return {
      partNumber,
      sha256: digest,
      byteSize: bytes.length,
      replayed: false,
    };
  });
}
export async function completeUploadParts(
  db: Database,
  store: ObjectStore,
  userId: string,
  proofId: string,
  evidenceId: string,
  totalBytes: number,
) {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 1 ||
    totalBytes > MAX_UPLOAD_PARTS * UPLOAD_PART_BYTES
  )
    throw new DomainError("INVALID_UPLOAD_SIZE", "Recording exceeds the 200 MiB upload limit", 400);
  return db.transaction(async (tx) => {
    const evidence = await pendingEvidence(tx, userId, proofId, evidenceId, true);
    const count = Math.ceil(totalBytes / UPLOAD_PART_BYTES);
    const rows = (
      await tx.query<{
        part_number: number;
        object_key: string;
        sha256: string;
        byte_size: number;
      }>("SELECT * FROM evidence_upload_parts WHERE evidence_id=$1 ORDER BY part_number", [
        evidenceId,
      ])
    ).rows;
    if (
      rows.length !== count ||
      rows.some(
        (r, i) =>
          r.part_number !== i + 1 ||
          r.byte_size !== Math.min(UPLOAD_PART_BYTES, totalBytes - i * UPLOAD_PART_BYTES),
      )
    )
      throw new DomainError(
        "UPLOAD_INCOMPLETE",
        "One or more recording parts are missing or have the wrong size",
        409,
      );
    const parts: Buffer[] = [];
    for (const part of rows) {
      const data = await store.get(part.object_key);
      if (!data || data.body.length !== part.byte_size || sha256Hex(data.body) !== part.sha256)
        throw new DomainError("UPLOAD_PART_CORRUPT", "Stored upload part failed verification", 409);
      parts.push(data.body);
    }
    const body = Buffer.concat(parts);
    await store.put(evidence.object_key, body, evidence.content_type);
    return {
      evidenceId,
      byteSize: totalBytes,
      sha256: sha256Hex(body),
      readyToCommit: true,
    };
  });
}
