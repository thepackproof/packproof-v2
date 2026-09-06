import type { Database } from '../db/database.js';
import type { ObjectStore } from '../s3/object-store.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from './errors.js';
import { requireCommerceAccess } from './commerce-lifecycle.js';

export interface SharedProofSource {
  id: string;
  evidence_type: string;
  content_type: string;
  sha256: string;
  committed_at: Date | string;
  stage_id: string | null;
}

/** The same committed sources for every live shared link to this Proof. */
export async function listSharedProofSources(db: Database, proofId: string): Promise<SharedProofSource[]> {
  const root = await db.query<SharedProofSource>(
    `SELECT id, evidence_type, content_type, sha256, committed_at, NULL::TEXT AS stage_id FROM evidence
      WHERE proof_id=$1 AND validation_status='COMMITTED'`, [proofId],
  );
  const stages = await db.query<SharedProofSource>(
    `SELECT e.id, s.stage_type AS evidence_type, e.content_type, e.sha256, e.committed_at, s.id AS stage_id
       FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id
      WHERE s.proof_id=$1 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL`, [proofId],
  );
  return [...root.rows, ...stages.rows].sort((a, b) =>
    new Date(a.committed_at).getTime() - new Date(b.committed_at).getTime() || a.id.localeCompare(b.id));
}

/** A stage source needs the same participant authorization and byte verification as the original. */
export async function readSharedStageSource(
  db: Database, store: ObjectStore, actorUserId: string, proofId: string, evidenceId: string,
) {
  await requireCommerceAccess(db, proofId, actorUserId);
  const row = (await db.query<{ object_key: string; content_type: string; sha256: string; byte_size: number | string }>(
    `SELECT e.object_key, e.content_type, e.sha256, e.byte_size
       FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id
      WHERE e.id=$1 AND s.proof_id=$2 AND e.committed_at IS NOT NULL AND e.discarded_at IS NULL`,
    [evidenceId, proofId],
  )).rows[0];
  if (!row) throw new DomainError('EVIDENCE_NOT_FOUND', 'Recording not found', 404);
  const object = await store.get(row.object_key);
  if (!object) throw new DomainError('EVIDENCE_NOT_FOUND', 'Recording is unavailable', 404);
  if (sha256Hex(object.body) !== row.sha256 || object.body.length !== Number(row.byte_size))
    throw new DomainError('EVIDENCE_INTEGRITY_FAILURE', 'Stored recording does not match its committed digest', 409);
  return { body: object.body, contentType: row.content_type, evidenceId };
}
