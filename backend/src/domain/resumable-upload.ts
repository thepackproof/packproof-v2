import { loadCaptureSession, assertCaptureRecoverable } from "./capture-sessions.js";
import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import type { ObjectStore } from "../s3/object-store.js";
import { sha256Hex } from "../hash.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { MEDIA_MAX_BYTES, requestByteLength, reserveMediaIngress, finishMediaIngress, verifyMediaSignature } from "./media-admission.js";
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
      await tx.query("UPDATE evidence_upload_admissions SET state='DISCARDED' WHERE evidence_id=$1",[row.id]);
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
export const MAX_UPLOAD_PARTS = Math.ceil(MEDIA_MAX_BYTES / UPLOAD_PART_BYTES);
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
    throw new DomainError("INVALID_UPLOAD_PART", "Use up to 48 parts, each at most 5 MiB", 400);
  const digest = sha256Hex(bytes);
  return db.transaction(async (tx) => {
    const evidence = await pendingEvidence(tx, userId, proofId, evidenceId, true);
    if (evidence.capture_session_id) assertCaptureRecoverable(await loadCaptureSession(tx,userId,proofId,evidence.capture_session_id),clock);
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
    const admission=(await tx.query<{reserved_bytes:number|string;declared_bytes:number|string|null}>("SELECT reserved_bytes,declared_bytes FROM evidence_upload_admissions WHERE evidence_id=$1",[evidenceId])).rows[0];
    const ceiling=Number(admission?.declared_bytes??admission?.reserved_bytes??MEDIA_MAX_BYTES);
    if((partNumber-1)*UPLOAD_PART_BYTES+bytes.length>ceiling)throw new DomainError("UPLOAD_TOO_LARGE","Part exceeds its recording reservation",413);
    const key = `${evidence.object_key}.parts/${partNumber}-${digest}`;
    await store.put(key, bytes, "application/octet-stream");
    const metadata=await store.head?.(key);
    await tx.query(
      "INSERT INTO evidence_upload_parts(evidence_id,part_number,object_key,sha256,byte_size,created_at,object_version_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [evidenceId, partNumber, key, digest, bytes.length, clock.now().toISOString(),metadata?.versionId??null],
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
    totalBytes > MEDIA_MAX_BYTES
  )
    throw new DomainError("INVALID_UPLOAD_SIZE", "Recording exceeds the 250 MB upload limit", 400);
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
    const admission=(await tx.query<{declared_bytes:number|string|null;reserved_bytes:number|string;state:string;expires_at:Date|string}>("SELECT * FROM evidence_upload_admissions WHERE evidence_id=$1 FOR UPDATE",[evidenceId])).rows[0];
    if(admission && (totalBytes>Number(admission.reserved_bytes) || admission.declared_bytes!==null && totalBytes!==Number(admission.declared_bytes))) throw new DomainError("UPLOAD_SIZE_MISMATCH","Recording size differs from its reservation",409);
    if(admission && (['DISCARDED','EXPIRED','COMMITTED'].includes(admission.state)||new Date(admission.expires_at).getTime()<=Date.now()))throw new DomainError("UPLOAD_CONTRACT_EXPIRED","This upload reservation is closed",409);
    const hash=createHash('sha256');
    async function* verifiedParts() {
      for(const part of rows) {
        const data=store.getStream?await store.getStream(part.object_key,{versionId:(part as typeof part & {object_version_id?:string|null}).object_version_id}):null;
        if(data) {
          const partHash=createHash('sha256');let length=0;
          for await(const chunk of data.body){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>part.byte_size)throw new DomainError('UPLOAD_PART_CORRUPT','Stored upload part exceeded its declared size',409);partHash.update(bytes);hash.update(bytes);yield bytes;}
          if(length!==Number(part.byte_size)||partHash.digest('hex')!==part.sha256)throw new DomainError('UPLOAD_PART_CORRUPT','Stored upload part failed verification',409);
        } else {
          const stored=await store.get(part.object_key);
          if(!stored||stored.body.length!==Number(part.byte_size)||sha256Hex(stored.body)!==part.sha256)throw new DomainError('UPLOAD_PART_CORRUPT','Stored upload part failed verification',409);
          hash.update(stored.body);yield stored.body;
        }
      }
    }
    let versionId:string|null|undefined;
    if(store.putStream)versionId=(await store.putStream(evidence.object_key,verifyMediaSignature(Readable.from(verifiedParts()),evidence.content_type),evidence.content_type,totalBytes)).versionId;
    else { // Small in-memory test-adapter compatibility, never production runtime.
      if(totalBytes>UPLOAD_PART_BYTES)throw new DomainError('STREAMING_STORAGE_REQUIRED','Resumable completion requires streaming storage',503);
      const chunks:Buffer[]=[];for await(const bytes of verifiedParts())chunks.push(bytes);await store.put(evidence.object_key,Buffer.concat(chunks),evidence.content_type);
    }
    if(admission)await tx.query("UPDATE evidence_upload_admissions SET state='RECEIVED',staging_version_id=$2,lease_token=NULL,lease_until=NULL WHERE evidence_id=$1",[evidenceId,versionId??null]);
    return {evidenceId,byteSize:totalBytes,sha256:hash.digest('hex'),readyToCommit:true};
  });
}

/** HTTP ingress is reserved before a bounded part body is read or buffered. */
export async function receiveAdmittedUploadPart(db:Database,clock:Clock,store:ObjectStore,userId:string,proofId:string,evidenceId:string,partNumber:number,req:IncomingMessage) {
  await pendingEvidence(db,userId,proofId,evidenceId);
  if(!Number.isInteger(partNumber)||partNumber<1||partNumber>MAX_UPLOAD_PARTS)throw new DomainError('INVALID_UPLOAD_PART','Invalid upload part number',400);
  const byteSize=requestByteLength(req,UPLOAD_PART_BYTES);
  const lease=await reserveMediaIngress(db,clock,{evidenceId,actorUserId:userId,byteSize,wholeObject:false});
  try {
    const chunks:Buffer[]=[];let total=0;
    req.setTimeout(120000,()=>req.destroy(new Error('Part upload timed out')));
    for await(const chunk of req){const bytes=Buffer.from(chunk);total+=bytes.length;if(total>byteSize)throw new DomainError('UPLOAD_TOO_LARGE','Part exceeds its reserved limit',413);chunks.push(bytes);}
    if(total!==byteSize)throw new DomainError('UPLOAD_INCOMPLETE','Part ended before its declared length',409);
    return await storeUploadPart(db,clock,store,userId,proofId,evidenceId,partNumber,Buffer.concat(chunks));
  } finally {await finishMediaIngress(db,clock,{...lease,received:false});}
}
