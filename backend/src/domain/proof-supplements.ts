import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import { loadProof } from "./proof-access.js";
import { requireCommerceAccess } from "./commerce-lifecycle.js";
import { enqueueRecoveryEvent, buildProofRecoverySnapshot } from "./recovery-journal.js";
import { verifyManifestIntegrity, type ManifestSignature, type ManifestSigner } from "./manifest-signing.js";

export type SupplementKind = "CORRECTION" | "RECIPIENT_RESPONSE" | "PARCEL" | "CARRIER_UPDATE" | "RETURN";
export interface SupplementInput {
  operationId: string;
  kind: SupplementKind;
  facts: Record<string, unknown>;
  sourceReference?: string | null;
  supersedesSupplementId?: string | null;
}
export interface ProofSupplementView {
  supplementId: string; proofId: string; sequence: number; kind: SupplementKind;
  canonicalJson: string; sha256: string; previousSha256: string; coreManifestSha256: string;
  signature: ManifestSignature; createdAt: string;
}
interface SupplementRow {
  id: string; proof_id: string; sequence: number; operation_id: string; kind: SupplementKind;
  canonical_json: string; sha256: string; previous_sha256: string; core_manifest_sha256: string;
  signature_json: ManifestSignature; created_at: Date | string;
}
function view(row: SupplementRow): ProofSupplementView {
  return { supplementId: row.id, proofId: row.proof_id, sequence: row.sequence, kind: row.kind, canonicalJson: row.canonical_json, sha256: row.sha256, previousSha256: row.previous_sha256, coreManifestSha256: row.core_manifest_sha256, signature: row.signature_json, createdAt: new Date(row.created_at).toISOString() };
}
function validate(input: SupplementInput) {
  if (!input || typeof input.operationId !== "string" || !/^[A-Za-z0-9:_-]{8,200}$/.test(input.operationId)) throw new DomainError("INVALID_SUPPLEMENT", "Provide a stable supplement operation identifier", 400);
  if (!["CORRECTION", "RECIPIENT_RESPONSE", "PARCEL", "CARRIER_UPDATE", "RETURN"].includes(input.kind)) throw new DomainError("INVALID_SUPPLEMENT", "Unsupported supplement kind", 400);
  if (!input.facts || typeof input.facts !== "object" || Array.isArray(input.facts) || Buffer.byteLength(canonicalize(input.facts)) > 65536) throw new DomainError("INVALID_SUPPLEMENT", "Supplement facts must be an object no larger than 64 KB", 400);
  for (const value of [input.sourceReference, input.supersedesSupplementId]) if (value != null && (typeof value !== "string" || value.length > 256)) throw new DomainError("INVALID_SUPPLEMENT", "Invalid supplement reference", 400);
}

/** Participant contributions are attributed statements, never verified provider observations. */
export async function appendProofSupplement(db: Database, clock: Clock, signer: ManifestSigner | undefined, actorUserId: string, proofId: string, input: SupplementInput) {
  validate(input);
  if (!signer) throw new DomainError("MANIFEST_SIGNING_UNAVAILABLE", "Supplement signing is temporarily unavailable", 503);
  if (input.kind !== "CORRECTION" && input.kind !== "RECIPIENT_RESPONSE") throw new DomainError("SUPPLEMENT_NOT_AUTHORIZED", "This kind of supplement requires its authorized workflow", 403);
  return db.transaction(async tx => {
    const role = await requireCommerceAccess(tx, proofId, actorUserId);
    if (input.kind === "RECIPIENT_RESPONSE" && role !== "BUYER") throw new DomainError("SUPPLEMENT_NOT_AUTHORIZED", "Only the invited recipient can contribute a recipient response", 403);
    return appendProofSupplementInTransaction(tx, clock, signer, actorUserId, proofId, input);
  });
}

/** Internal integration/workflow seam. Caller must verify origin and authorization before calling. */
export async function appendProofSupplementInTransaction(tx: Database, clock: Clock, signer: ManifestSigner, actorUserId: string | null, proofId: string, input: SupplementInput): Promise<ProofSupplementView> {
  validate(input);
  const proof = await loadProof(tx, proofId, true);
  if (proof.status !== "FINALIZED") throw new DomainError("SUPPLEMENT_NOT_READY", "Finalize the original Proof before appending a supplement", 409);
  const scopedOperationId = `${actorUserId ?? "system"}:${input.operationId}`;
  const priorOperation = (await tx.query<SupplementRow>("SELECT * FROM proof_supplements WHERE proof_id=$1 AND operation_id=$2", [proofId, scopedOperationId])).rows[0];
  const request = { kind: input.kind, facts: input.facts, sourceReference: input.sourceReference ?? null, supersedesSupplementId: input.supersedesSupplementId ?? null, actorUserId };
  if (priorOperation) {
    const prior = JSON.parse(priorOperation.canonical_json) as Record<string, unknown>;
    const priorRequest = { kind: prior.kind, facts: prior.facts, sourceReference: prior.sourceReference, supersedesSupplementId: prior.supersedesSupplementId, actorUserId: prior.actorUserId };
    if (priorOperation.proof_id !== proofId || canonicalize(priorRequest) !== canonicalize(request)) throw new DomainError("SUPPLEMENT_OPERATION_CONFLICT", "This operation already records different facts", 409);
    return view(priorOperation);
  }
  if (input.supersedesSupplementId) {
    if (input.kind !== "CORRECTION") throw new DomainError("INVALID_SUPPLEMENT", "Only a correction may supersede an earlier assertion", 400);
    const old = (await tx.query<SupplementRow>("SELECT * FROM proof_supplements WHERE proof_id=$1 AND id=$2", [proofId, input.supersedesSupplementId])).rows[0];
    if (!old || JSON.parse(old.canonical_json).actorUserId !== actorUserId) throw new DomainError("SUPPLEMENT_NOT_AUTHORIZED", "A correction can only supersede your own attributed assertion on this Proof", 403);
  }
  const manifest = (await tx.query<{ sha256: string }>("SELECT sha256 FROM final_manifests WHERE proof_id=$1", [proofId])).rows[0];
  if (!manifest) throw new DomainError("MANIFEST_NOT_FOUND", "Original manifest is unavailable", 409);
  const previous = (await tx.query<{ sequence: number; sha256: string }>("SELECT sequence,sha256 FROM proof_supplements WHERE proof_id=$1 ORDER BY sequence DESC LIMIT 1", [proofId])).rows[0];
  const id = newId("sup");
  const sequence = (previous?.sequence ?? 0) + 1;
  const previousSha = previous?.sha256 ?? manifest.sha256;
  const at = clock.now().toISOString();
  const canonical = canonicalize({ version: 1, domain: "PACKPROOF_PROOF_SUPPLEMENT", supplementId: id, proofId, sequence, operationId: input.operationId, ...request, attribution: actorUserId ? "PARTICIPANT_SUPPLIED" : "AUTHORIZED_WORKFLOW", previousSha256: previousSha, coreManifestSha256: manifest.sha256, recordedAt: at });
  const digest = sha256Hex(canonical);
  const signature = await signer.signManifest({ proofId, manifestId: id, canonicalJson: canonical, sha256: digest });
  const row: SupplementRow = { id, proof_id: proofId, sequence, operation_id: scopedOperationId, kind: input.kind, canonical_json: canonical, sha256: digest, previous_sha256: previousSha, core_manifest_sha256: manifest.sha256, signature_json: signature, created_at: at };
  await tx.query(`INSERT INTO proof_supplements(id,proof_id,sequence,operation_id,kind,canonical_json,sha256,previous_sha256,core_manifest_sha256,signature_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, proofId, sequence, scopedOperationId, input.kind, canonical, digest, previousSha, manifest.sha256, JSON.stringify(signature), at]);
  await tx.query(`INSERT INTO proof_supplement_heads(proof_id,sequence,sha256) VALUES($1,$2,$3) ON CONFLICT(proof_id) DO UPDATE SET sequence=$2,sha256=$3`, [proofId, sequence, digest]);
  await enqueueRecoveryEvent(tx, clock, { operationId: `supplement:${id}`, kind: "SUPPLEMENT_COMMITTED", proofId, actorUserId, payload: await buildProofRecoverySnapshot(tx, proofId) });
  return view(row);
}

/** Scoped caller must authorize before reading; exported for authorized disclosure builders. */
export async function getProofSupplementSnapshot(db: Database, proofId: string) {
  const supplements = (await db.query<SupplementRow>("SELECT * FROM proof_supplements WHERE proof_id=$1 ORDER BY sequence", [proofId])).rows.map(view);
  const manifest = (await db.query<{ sha256: string }>("SELECT sha256 FROM final_manifests WHERE proof_id=$1", [proofId])).rows[0];
  return { coreManifestSha256: manifest?.sha256 ?? null, sequence: supplements.at(-1)?.sequence ?? 0, sha256: supplements.at(-1)?.sha256 ?? manifest?.sha256 ?? null, supplements, snapshotLimit: "This is a dated snapshot. Offline verification cannot establish that no later supplements exist." };
}

export function verifyProofSupplementSnapshot(input: {
  proofId: string; coreManifestSha256: string; supplements: ProofSupplementView[];
  trustedPublicKeys: Record<string, string>; trustSnapshotAt: string;
}) {
  let previous = input.coreManifestSha256;
  const issues: string[] = [];
  input.supplements.forEach((row, index) => {
    let facts: Record<string, unknown> = {};
    try { facts = JSON.parse(row.canonicalJson); } catch { issues.push(`INVALID_CANONICAL_JSON:${index + 1}`); }
    if (facts.version !== 1 || facts.domain !== "PACKPROOF_PROOF_SUPPLEMENT") issues.push(`UNSUPPORTED_SUPPLEMENT:${index + 1}`);
    if (row.proofId !== input.proofId || facts.proofId !== input.proofId || row.sequence !== index + 1 || facts.sequence !== row.sequence || row.previousSha256 !== previous || facts.previousSha256 !== previous || row.coreManifestSha256 !== input.coreManifestSha256 || facts.coreManifestSha256 !== input.coreManifestSha256) issues.push(`CHAIN_DISCONTINUITY:${index + 1}`);
    const verification = verifyManifestIntegrity({ canonicalJson: row.canonicalJson, expectedSha256: row.sha256, signature: row.signature, publicKeyPem: input.trustedPublicKeys[row.signature.keyId] });
    if (!verification.digestValid || !verification.signatureValid) issues.push(`INTEGRITY_OR_TRUST_UNCONFIRMED:${index + 1}`);
    previous = row.sha256;
  });
  return { valid: issues.length === 0, issues, sequence: input.supplements.length, headSha256: previous, trustSnapshotAt: input.trustSnapshotAt, currentRevocationKnowledge: "UNAVAILABLE_OFFLINE", completeness: "RECEIVED_SNAPSHOT_ONLY" };
}
