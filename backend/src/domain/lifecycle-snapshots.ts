import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { appendAudit } from "./audit.js";
import { requireCommerceAccess, type CommerceStageType } from "./commerce-lifecycle.js";
import { loadProof, requireParticipant } from "./proof-access.js";
import { requireManifestSignatureAlgorithm, type ManifestSignature, type ManifestSigner } from "./manifest-signing.js";
import type { ProofSupplementView, SupplementKind } from "./proof-supplements.js";

export const LIFECYCLE_SNAPSHOT_LIMITS = { supplements: 256, stages: 3, snapshotsPerProof: 512, sourceBytes: 16 * 1024 * 1024 } as const;
export interface LifecycleSnapshotInput {
  operationId: string;
  purpose?: "REVIEW" | "CLAIM" | "ARCHIVE";
}
export interface LifecycleSnapshotPayload {
  version: 1;
  domain: "PACKPROOF_LIFECYCLE_SNAPSHOT";
  snapshotId: string;
  proofId: string;
  transactionId: string;
  tenantId: string | null;
  actorUserId: string;
  purpose: "REVIEW" | "CLAIM" | "ARCHIVE";
  createdAt: string;
  cutoffAt: string;
  scope: "SEALED_COMMERCE_LIFECYCLE";
  root: { manifestId: string; sha256: string };
  supplements: Array<{ supplementId: string; sequence: number; sha256: string; previousSha256: string }>;
  stages: Array<{ stageId: string; type: CommerceStageType; sha256: string; finalizedAt: string }>;
  watermark: { supplementSequence: number; supplementSha256: string };
  limitations: {
    completeness: "RECEIVED_SNAPSHOT_ONLY";
    freshness: "UNKNOWN_OFFLINE";
    currentRevocationKnowledge: "UNAVAILABLE_OFFLINE";
    excluded: ["UNSEALED_STAGES", "UNSEALED_OBSERVATIONS", "EVIDENCE_BYTES"];
  };
}
export interface LifecycleRootView {
  manifestId: string; proofId: string; canonicalJson: string; sha256: string; signature?: ManifestSignature;
}
export interface LifecycleStageView {
  stageId: string; proofId: string; type: CommerceStageType; canonicalJson: string; sha256: string; finalizedAt: string;
}
export interface LifecycleSnapshotView {
  snapshotId: string;
  proofId: string;
  canonicalJson: string;
  sha256: string;
  signature: ManifestSignature;
  root: LifecycleRootView;
  supplements: ProofSupplementView[];
  stages: LifecycleStageView[];
}
interface SnapshotRow {
  id: string; proof_id: string; actor_user_id: string; operation_id: string;
  request_sha256: string; canonical_json: string; sha256: string; signature_json: ManifestSignature;
}
interface RootRow {
  id: string; proof_id: string; canonical_json: string; sha256: string;
  signature_algorithm: string | null; signature_base64: string | null; signing_key_id: string | null; signed_at: Date | string | null;
}
interface SupplementRow {
  id: string; proof_id: string; sequence: number; kind: SupplementKind; canonical_json: string; sha256: string;
  previous_sha256: string; core_manifest_sha256: string; signature_json: ManifestSignature; created_at: Date | string;
}
interface StageRow {
  id: string; proof_id: string; stage_type: CommerceStageType; canonical_json: string; sha256: string; finalized_at: Date | string;
}
interface InventoryRow {
  kind: "ROOT" | "SUPPLEMENT" | "STAGE"; id: string; sha256: string; byte_size: number;
  sequence: number | null; previous_sha256: string | null; stage_type: CommerceStageType | null; finalized_at: Date | string | null;
}
function integrityFailure(): never {
  throw new DomainError("LIFECYCLE_SNAPSHOT_INTEGRITY", "The sealed lifecycle records do not match their recorded integrity references", 409);
}
function historyLimit(): never {
  throw new DomainError("LIFECYCLE_SNAPSHOT_LIMIT", "This lifecycle exceeds the supported snapshot size; no partial snapshot was created", 413);
}

/** Materialize only the immutable inventory named by the signed snapshot. Never query a newer head. */
async function materialize(db: Database, row: SnapshotRow): Promise<LifecycleSnapshotView> {
  if (sha256Hex(row.canonical_json) !== row.sha256) integrityFailure();
  const payload = JSON.parse(row.canonical_json) as LifecycleSnapshotPayload;
  if (payload.domain !== "PACKPROOF_LIFECYCLE_SNAPSHOT" || payload.version !== 1 || payload.proofId !== row.proof_id || payload.snapshotId !== row.id) integrityFailure();
  if (payload.supplements.length > LIFECYCLE_SNAPSHOT_LIMITS.supplements || payload.stages.length > LIFECYCLE_SNAPSHOT_LIMITS.stages) historyLimit();
  const root = (await db.query<RootRow>("SELECT * FROM final_manifests WHERE proof_id=$1 AND id=$2", [row.proof_id, payload.root.manifestId])).rows[0];
  if (!root || root.sha256 !== payload.root.sha256 || sha256Hex(root.canonical_json) !== root.sha256) integrityFailure();
  const supplements = (await db.query<SupplementRow>("SELECT * FROM proof_supplements WHERE proof_id=$1 AND id=ANY($2::text[]) ORDER BY sequence", [row.proof_id, payload.supplements.map(s => s.supplementId)])).rows;
  const stages = (await db.query<StageRow>("SELECT * FROM commerce_stages WHERE proof_id=$1 AND id=ANY($2::text[]) AND finalized_at IS NOT NULL ORDER BY finalized_at,id", [row.proof_id, payload.stages.map(s => s.stageId)])).rows;
  if (supplements.length !== payload.supplements.length || stages.length !== payload.stages.length) integrityFailure();
  let previous = root.sha256;
  let sourceBytes = Buffer.byteLength(root.canonical_json);
  const supplementViews = supplements.map((s, index): ProofSupplementView => {
    const ref = payload.supplements[index];
    if (s.id !== ref.supplementId || s.sequence !== index + 1 || s.sequence !== ref.sequence || s.sha256 !== ref.sha256 || s.previous_sha256 !== previous || s.previous_sha256 !== ref.previousSha256 || s.core_manifest_sha256 !== root.sha256 || sha256Hex(s.canonical_json) !== s.sha256) integrityFailure();
    previous = s.sha256;
    sourceBytes += Buffer.byteLength(s.canonical_json);
    return { supplementId: s.id, proofId: s.proof_id, sequence: s.sequence, kind: s.kind, canonicalJson: s.canonical_json, sha256: s.sha256, previousSha256: s.previous_sha256, coreManifestSha256: s.core_manifest_sha256, signature: s.signature_json, createdAt: new Date(s.created_at).toISOString() };
  });
  if (payload.watermark.supplementSequence !== supplements.length || payload.watermark.supplementSha256 !== previous) integrityFailure();
  const stageViews = stages.map((s, index): LifecycleStageView => {
    const ref = payload.stages[index];
    const finalizedAt = new Date(s.finalized_at).toISOString();
    if (s.id !== ref.stageId || s.stage_type !== ref.type || s.sha256 !== ref.sha256 || finalizedAt !== ref.finalizedAt || sha256Hex(s.canonical_json) !== s.sha256) integrityFailure();
    sourceBytes += Buffer.byteLength(s.canonical_json);
    return { stageId: s.id, proofId: s.proof_id, type: s.stage_type, canonicalJson: s.canonical_json, sha256: s.sha256, finalizedAt };
  });
  if (sourceBytes > LIFECYCLE_SNAPSHOT_LIMITS.sourceBytes) historyLimit();
  return {
    snapshotId: row.id, proofId: row.proof_id, canonicalJson: row.canonical_json, sha256: row.sha256, signature: row.signature_json,
    root: { manifestId: root.id, proofId: root.proof_id, canonicalJson: root.canonical_json, sha256: root.sha256,
      ...(root.signature_base64 ? { signature: { algorithm: requireManifestSignatureAlgorithm(root.signature_algorithm), keyId: root.signing_key_id!, signatureBase64: root.signature_base64, signedAt: new Date(root.signed_at!).toISOString() } } : {}) },
    supplements: supplementViews, stages: stageViews,
  };
}

/**
 * Full-record participant profile, matching the canonical archive's access.
 * Receiver-only grants do not authorize this disclosure. Existing scoped claim
 * exports remain a separate authorization path.
 * Freeze an inventory without touching the legacy serializer or sealed rows.
 */
export async function createLifecycleSnapshot(db: Database, clock: Clock, signer: ManifestSigner | undefined, actorUserId: string, proofId: string, input: LifecycleSnapshotInput): Promise<LifecycleSnapshotView> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "operationId" && key !== "purpose") || typeof input.operationId !== "string" || !/^[A-Za-z0-9:_-]{8,200}$/.test(input.operationId) || (input.purpose !== undefined && !["REVIEW", "CLAIM", "ARCHIVE"].includes(input.purpose))) {
    throw new DomainError("INVALID_LIFECYCLE_SNAPSHOT", "Provide a stable snapshot operation identifier and a supported purpose", 400);
  }
  const purpose = input.purpose ?? "REVIEW";
  const requestDigest = sha256Hex(canonicalize({ version: 1, proofId, actorUserId, purpose }));
  return db.transaction(async tx => {
    await requireParticipant(tx, proofId, actorUserId);
    await requireCommerceAccess(tx, proofId, actorUserId);
    // Supplement writers use this same proof lock. Do not acquire stage row
    // locks here: existing stage finalization locks stage then proof.
    const proof = await loadProof(tx, proofId, true);
    const prior = (await tx.query<SnapshotRow>("SELECT * FROM lifecycle_snapshots WHERE proof_id=$1 AND actor_user_id=$2 AND operation_id=$3", [proofId, actorUserId, input.operationId])).rows[0];
    if (prior) {
      if (prior.request_sha256 !== requestDigest) throw new DomainError("LIFECYCLE_SNAPSHOT_OPERATION_CONFLICT", "This snapshot operation was already used for a different request", 409);
      return materialize(tx, prior);
    }
    if (!signer) throw new DomainError("MANIFEST_SIGNING_UNAVAILABLE", "Snapshot signing is temporarily unavailable", 503);
    const count = (await tx.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM lifecycle_snapshots WHERE proof_id=$1", [proofId])).rows[0];
    if (Number(count.count) >= LIFECYCLE_SNAPSHOT_LIMITS.snapshotsPerProof) historyLimit();
    const cutoffAt = clock.now().toISOString();
    // One MVCC statement selects all references. Stage finalizations that race
    // this query either enter this inventory in full or a subsequent snapshot.
    // No client timestamp is treated as a ledger ordering authority.
    const inventory = (await tx.query<InventoryRow>(`
      SELECT 'ROOT' AS kind,id,sha256,octet_length(canonical_json) AS byte_size,NULL::integer AS sequence,NULL::text AS previous_sha256,NULL::text AS stage_type,NULL::timestamptz AS finalized_at
      FROM final_manifests WHERE proof_id=$1
      UNION ALL
      SELECT 'SUPPLEMENT',id,sha256,octet_length(canonical_json),sequence,previous_sha256,NULL,NULL
      FROM (SELECT * FROM proof_supplements WHERE proof_id=$1 AND created_at<=$2 ORDER BY sequence LIMIT $3) s
      UNION ALL
      SELECT 'STAGE',id,sha256,octet_length(canonical_json),NULL,NULL,stage_type,finalized_at
      FROM (SELECT * FROM commerce_stages WHERE proof_id=$1 AND finalized_at<=$2 ORDER BY finalized_at,id LIMIT $4) s`,
      [proofId, cutoffAt, LIFECYCLE_SNAPSHOT_LIMITS.supplements + 1, LIFECYCLE_SNAPSHOT_LIMITS.stages + 1])).rows;
    const root = inventory.find(r => r.kind === "ROOT");
    if (!root) throw new DomainError("MANIFEST_NOT_FOUND", "The original sealed manifest is unavailable", 409);
    const supplements = inventory.filter(r => r.kind === "SUPPLEMENT").sort((a, b) => a.sequence! - b.sequence!);
    const stages = inventory.filter(r => r.kind === "STAGE").sort((a, b) => new Date(a.finalized_at!).valueOf() - new Date(b.finalized_at!).valueOf() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (supplements.length > LIFECYCLE_SNAPSHOT_LIMITS.supplements || stages.length > LIFECYCLE_SNAPSHOT_LIMITS.stages || inventory.reduce((bytes, r) => bytes + Number(r.byte_size), 0) > LIFECYCLE_SNAPSHOT_LIMITS.sourceBytes) historyLimit();
    const binding = (await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM api_tenant_proofs WHERE proof_id=$1", [proofId])).rows[0];
    const id = newId("life");
    const head = supplements.at(-1);
    const payload: LifecycleSnapshotPayload = {
      version: 1, domain: "PACKPROOF_LIFECYCLE_SNAPSHOT", snapshotId: id, proofId, transactionId: proof.transaction_id, tenantId: binding?.tenant_id ?? null,
      actorUserId, purpose, createdAt: cutoffAt, cutoffAt, scope: "SEALED_COMMERCE_LIFECYCLE",
      root: { manifestId: root.id, sha256: root.sha256 },
      supplements: supplements.map(s => ({ supplementId: s.id, sequence: s.sequence!, sha256: s.sha256, previousSha256: s.previous_sha256! })),
      stages: stages.map(s => ({ stageId: s.id, type: s.stage_type!, sha256: s.sha256, finalizedAt: new Date(s.finalized_at!).toISOString() })),
      watermark: { supplementSequence: head?.sequence ?? 0, supplementSha256: head?.sha256 ?? root.sha256 },
      limitations: { completeness: "RECEIVED_SNAPSHOT_ONLY", freshness: "UNKNOWN_OFFLINE", currentRevocationKnowledge: "UNAVAILABLE_OFFLINE", excluded: ["UNSEALED_STAGES", "UNSEALED_OBSERVATIONS", "EVIDENCE_BYTES"] },
    };
    const canonicalJson = canonicalize(payload), sha256 = sha256Hex(canonicalJson);
    const signature = await signer.signManifest({ proofId, manifestId: id, canonicalJson, sha256 });
    const row: SnapshotRow = { id, proof_id: proofId, actor_user_id: actorUserId, operation_id: input.operationId, request_sha256: requestDigest, canonical_json: canonicalJson, sha256, signature_json: signature };
    const result = await materialize(tx, row);
    await tx.query("INSERT INTO lifecycle_snapshots(id,proof_id,actor_user_id,operation_id,request_sha256,canonical_json,sha256,signature_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, proofId, actorUserId, input.operationId, requestDigest, canonicalJson, sha256, JSON.stringify(signature), cutoffAt]);
    await appendAudit(tx, { proofId, actorUserId, eventType: "LIFECYCLE_SNAPSHOT_CREATED", eventData: { snapshotId: id, sha256, watermark: payload.watermark }, at: new Date(cutoffAt) });
    return result;
  });
}

export async function getLifecycleSnapshot(db: Database, actorUserId: string, proofId: string, snapshotId: string): Promise<LifecycleSnapshotView> {
  await requireParticipant(db, proofId, actorUserId);
  await requireCommerceAccess(db, proofId, actorUserId);
  const row = (await db.query<SnapshotRow>("SELECT * FROM lifecycle_snapshots WHERE proof_id=$1 AND id=$2", [proofId, snapshotId])).rows[0];
  if (!row) throw new DomainError("LIFECYCLE_SNAPSHOT_NOT_FOUND", "Lifecycle snapshot not found", 404);
  return materialize(db, row);
}
