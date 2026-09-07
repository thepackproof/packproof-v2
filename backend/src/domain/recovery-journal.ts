import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { canonicalize } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { newId } from "../ids.js";
import { DomainError } from "./errors.js";
import type { ManifestSignature, ManifestSigner } from "./manifest-signing.js";
import { verifyManifestIntegrity } from "./manifest-signing.js";
import { assertPolicyAccessSafe, currentPolicySequence, requireDurablePolicySequence } from "./policy-recovery.js";

export type RecoveryKind = "EVIDENCE_COMMITTED" | "DECLARATION_COMMITTED" | "PROOF_FINALIZED" | "STAGE_FINALIZED" | "SUPPLEMENT_COMMITTED" | "RETENTION_CHANGED";
interface RecoveryRow {
  operation_id: string; sequence: number | string; proof_id: string; kind: RecoveryKind;
  request_sha256: string; canonical_json: string; sha256: string; previous_sha256: string | null;
  created_at: Date | string;
}
export interface PreservationReceipt {
  version: 1; operationId: string; eventSha256: string; envelopeSha256: string;
  objectKey: string; objectVersionId: string | null; preservedAt: string;
  signature: ManifestSignature;
}
export interface RecoveryStatus {
  operationId: string;
  status: "COMMITTED_PENDING_DURABILITY" | "PRESERVED" | "FAILED" | "LEGACY_UNCONFIRMED";
  receipt: PreservationReceipt | null;
  errorCode?: string;
}

/** Receipts require an independently protected conditional-create store. Plain put() is insufficient. */
export interface RecoveryJournalStore {
  putIfAbsent(key: string, bytes: Buffer, contentType: string): Promise<{ created: boolean }>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  head?(key: string): Promise<{ versionId?: string | null } | null>;
}
export interface RecoveryPublisher {
  store: RecoveryJournalStore;
  signer: ManifestSigner;
  trustedPublicKey: (keyId: string) => Promise<string | null>;
  writerGeneration: string;
  /** Set only after storage IAM/retention and journal signing authority have been verified. */
  protectedStoreVerified: boolean;
}

function normalized(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }

/** Called inside the same transaction as the accepted domain mutation. */
export async function enqueueRecoveryEvent(db: Database, clock: Clock, input: {
  operationId: string; kind: RecoveryKind; proofId: string; actorUserId: string | null; payload: unknown;
}): Promise<RecoveryStatus> {
  // Global ordering also covers policy changes between separate Proofs. Publication preserves this order.
  await db.query("SELECT pg_advisory_xact_lock(1347438146, 36)");
  const fence = (await db.query<{ writes_enabled: boolean }>("SELECT writes_enabled FROM recovery_writer_fence WHERE singleton=1")).rows[0];
  if (!fence?.writes_enabled) throw new DomainError("RECOVERY_WRITERS_FENCED", "Preservation writes are paused for recovery", 503);
  const facts = normalized(input);
  const requestSha = sha256Hex(canonicalize(facts));
  const existing = (await db.query<RecoveryRow>("SELECT * FROM recovery_events WHERE operation_id=$1", [input.operationId])).rows[0];
  if (existing) {
    if (existing.request_sha256 !== requestSha) throw new DomainError("RECOVERY_OPERATION_CONFLICT", "This operation already records different facts", 409);
    return getRecoveryStatus(db, input.operationId);
  }
  const prior = (await db.query<{ sha256: string }>("SELECT sha256 FROM recovery_events ORDER BY sequence DESC LIMIT 1")).rows[0];
  const at = clock.now().toISOString();
  const sequence = String((await db.query<{ value: string | number }>("SELECT nextval(pg_get_serial_sequence('recovery_events','sequence')) AS value")).rows[0].value);
  const policySequence = await currentPolicySequence(db);
  const canonical = canonicalize({ version: 1, domain: "PACKPROOF_COMMITTED_RECOVERY_EVENT", acceptance: "COMMITTED", ...input, payload: normalized(input.payload), sequence, policySequence, previousSha256: prior?.sha256 ?? null, committedAt: at });
  await db.query(`INSERT INTO recovery_events(operation_id,proof_id,kind,request_sha256,canonical_json,sha256,previous_sha256,created_at,sequence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.operationId, input.proofId, input.kind, requestSha, canonical, sha256Hex(canonical), prior?.sha256 ?? null, at, sequence]);
  await db.query("INSERT INTO recovery_delivery(operation_id,next_attempt_at) VALUES($1,$2)", [input.operationId, at]);
  return getRecoveryStatus(db, input.operationId);
}

/** Frozen reconstructable facts, rather than IDs requiring a possibly lost database row.
 * Credentials are deliberately excluded; authentication and organization journals are a separate restore gate.
 */
export async function buildProofRecoverySnapshot(db: Database, proofId: string) {
  const proof = (await db.query("SELECT * FROM proofs WHERE id=$1", [proofId])).rows[0];
  if (!proof) throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
  const transactionId = proof.transaction_id;
  const rows: Record<string, unknown> = { proofs: [proof] };
  for (const table of ["proof_participants", "evidence", "attestations", "attestation_challenges", "capture_sessions", "audit_events", "final_manifests", "proof_external_references", "proof_retention_holds", "proof_deletion_requests", "proof_supplements", "commerce_receivers", "commerce_stages", "proof_retention_assignments", "proof_disposition_state", "proof_assets", "proof_asset_external_refs", "custody_observations", "custody_transfers", "continuity_evaluations", "shipment_events", "capture_shipping_labels", "proof_parcel_scopes", "capture_label_observations"]) {
    rows[table] = (await db.query(`SELECT * FROM ${table} WHERE proof_id=$1`, [proofId])).rows;
  }
  rows.commerce_stage_evidence = (await db.query("SELECT e.* FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE s.proof_id=$1", [proofId])).rows;
  for (const table of ["observation_assets", "observation_evidence", "observation_external_refs"]) rows[table] = (await db.query(`SELECT j.* FROM ${table} j JOIN custody_observations o ON o.id=j.observation_id WHERE o.proof_id=$1`, [proofId])).rows;
  for (const table of ["transactions", "transaction_shipping", "transaction_items", "transaction_integration_identities"]) {
    rows[table] = (await db.query(`SELECT * FROM ${table} WHERE ${table === "transactions" ? "id" : "transaction_id"}=$1`, [transactionId])).rows;
  }
  rows.users = (await db.query("SELECT * FROM users WHERE id IN (SELECT user_id FROM proof_participants WHERE proof_id=$1) OR id IN (SELECT created_by FROM transactions WHERE id=$2) OR id IN (SELECT user_id FROM commerce_receivers WHERE proof_id=$1)", [proofId, transactionId])).rows;
  return { schemaVersion: 1, rows: normalized(rows), policyJournalReference:{sequence:await currentPolicySequence(db),requiresIndependentReplay:true}, coverage: { coreEvidence: true, organizationPolicies: false, authIdentities: false, completeAccessRevocations: false, restoreRequiresClosedTraffic: true } };
}

export async function getRecoveryStatus(db: Database, operationId: string): Promise<RecoveryStatus> {
  const row = (await db.query<{ state: string; receipt_json: PreservationReceipt | null; error_code: string | null }>("SELECT state,receipt_json,error_code FROM recovery_delivery WHERE operation_id=$1", [operationId])).rows[0];
  return { operationId, status: !row ? "LEGACY_UNCONFIRMED" : row.state === "DURABLE" && row.receipt_json ? "PRESERVED" : row.state === "DEAD_LETTER" ? "FAILED" : "COMMITTED_PENDING_DURABILITY", receipt: row?.receipt_json ?? null, ...(row?.error_code ? { errorCode: row.error_code } : {}) };
}

export async function getProofRecoveryStatus(db: Database, userId: string, proofId: string) {
  await assertPolicyAccessSafe(db);
  const participant = await db.query("SELECT 1 FROM proof_participants WHERE proof_id=$1 AND user_id=$2", [proofId, userId]);
  if (!participant.rows[0] && !(await db.query("SELECT 1 FROM commerce_receivers WHERE proof_id=$1 AND user_id=$2 AND accepted_at IS NOT NULL", [proofId,userId])).rows[0]) throw new DomainError("PARTICIPANT_NOT_AUTHORIZED", "This record is unavailable to this account", 403);
  const evidence = (await db.query<{ id: string; capture_session_id: string | null }>("SELECT id,capture_session_id FROM evidence WHERE proof_id=$1 AND validation_status='COMMITTED' ORDER BY committed_at,id", [proofId])).rows;
  const declarations = (await db.query<{ id: string }>("SELECT id FROM attestations WHERE proof_id=$1 ORDER BY created_at,id", [proofId])).rows;
  const stageEvidence = (await db.query<{ id: string; stage_id: string; capture_session_id: string | null }>("SELECT e.id,e.stage_id,e.capture_session_id FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE s.proof_id=$1 AND e.committed_at IS NOT NULL", [proofId])).rows;
  const stages = (await db.query<{id:string}>("SELECT id FROM commerce_stages WHERE proof_id=$1 AND finalized_at IS NOT NULL", [proofId])).rows;
  return {
    proofId,
    evidence: [...await Promise.all(evidence.map(async row => ({ evidenceId: row.id, captureSessionId: row.capture_session_id, ...await getRecoveryStatus(db, `evidence:${row.id}`) }))), ...await Promise.all(stageEvidence.map(async row => ({ evidenceId: row.id, stageId: row.stage_id, captureSessionId: row.capture_session_id, ...await getRecoveryStatus(db, `stage-evidence:${row.id}`) })))],
    declarations: await Promise.all(declarations.map(async row => ({ attestationId: row.id, ...await getRecoveryStatus(db, `declaration:${row.id}`) }))),
    finalization: await getRecoveryStatus(db, `finalize:${proofId}`),
    stages: await Promise.all(stages.map(async row => ({stageId:row.id,...await getRecoveryStatus(db,`stage-finalize:${row.id}`)}))),
    assurance: "Receipts cover the recorded evidence envelope. Complete disaster recovery remains conditional on the tested access-policy and account recovery boundary.",
  };
}

export async function requireDurableOperation(db: Database, operationId: string) {
  const status = await getRecoveryStatus(db, operationId);
  if (status.status !== "PRESERVED") throw new DomainError("PRESERVATION_PENDING", "Recording received. Preservation is still in progress; retry without retaking it", 409);
}

interface Envelope { version: 1; domain: string; eventCanonicalJson: string; eventSha256: string; publishedAt: string; signature: ManifestSignature; }

function finalizationAudit(envelope: Envelope, proofId: string, operationId: string, manifest: Record<string, unknown>) {
  const facts = JSON.parse(envelope.eventCanonicalJson) as {actorUserId:string|null};
  return { id: `aud_recovery_${sha256Hex(operationId)}`, proof_id: proofId, actor_user_id: facts.actorUserId,
    event_type: "PROOF_FINALIZED", event_version: 1, event_data: {manifestId:manifest.id,sha256:manifest.sha256,preservationOperationId:operationId}, created_at: envelope.publishedAt };
}

export async function verifyRecoveryEnvelope(body: Buffer, publisher: Pick<RecoveryPublisher, "trustedPublicKey">, expectedEventSha256?: string): Promise<Envelope> {
  let envelope: Envelope;
  try { envelope = JSON.parse(body.toString("utf8")) as Envelope; } catch { throw new DomainError("RECOVERY_ENVELOPE_CONFLICT", "Recovery envelope is invalid", 503); }
  if (envelope.version !== 1 || envelope.domain !== "PACKPROOF_SIGNED_RECOVERY_ENVELOPE" || !envelope.signature || (expectedEventSha256 && envelope.eventSha256 !== expectedEventSha256)) throw new DomainError("RECOVERY_ENVELOPE_CONFLICT", "Recovery envelope conflicts with accepted facts", 503);
  const signed = canonicalize({ version: envelope.version, domain: envelope.domain, eventCanonicalJson: envelope.eventCanonicalJson, eventSha256: envelope.eventSha256, publishedAt: envelope.publishedAt });
  const valid = verifyManifestIntegrity({ canonicalJson: signed, expectedSha256: sha256Hex(signed), signature: envelope.signature, publicKeyPem: await publisher.trustedPublicKey(envelope.signature.keyId) });
  if (!valid.signatureValid || sha256Hex(envelope.eventCanonicalJson) !== envelope.eventSha256) throw new DomainError("RECOVERY_ENVELOPE_CONFLICT", "Recovery journal authenticity check failed", 503);
  const event = JSON.parse(envelope.eventCanonicalJson) as { version: number; acceptance: string; domain: string };
  if (event.version !== 1 || event.acceptance !== "COMMITTED" || event.domain !== "PACKPROOF_COMMITTED_RECOVERY_EVENT") throw new DomainError("RECOVERY_ENVELOPE_CONFLICT", "Only committed recovery facts can be replayed", 503);
  return envelope;
}

/** One ordered leased job per call; schedule independently of request traffic. */
export async function processRecoveryOutbox(db: Database, clock: Clock, publisher: RecoveryPublisher): Promise<{ processed: number; state?: string }> {
  if (!publisher.protectedStoreVerified) throw new DomainError("RECOVERY_STORE_NOT_VERIFIED", "Recovery storage protection has not been verified", 503);
  const token = newId("lease");
  const claim = await db.transaction(async tx => {
    const candidate = (await tx.query<RecoveryRow & { state: string; attempts: number; next_attempt_at: Date | string; lease_until: Date | string | null }>(`SELECT e.*,d.state,d.attempts,d.next_attempt_at,d.lease_until FROM recovery_events e JOIN recovery_delivery d USING(operation_id) WHERE d.state <> 'DURABLE' ORDER BY e.sequence LIMIT 1 FOR UPDATE OF d`)).rows[0];
    if (!candidate || candidate.state === "DEAD_LETTER" || new Date(candidate.next_attempt_at) > clock.now() || (candidate.state === "LEASED" && candidate.lease_until && new Date(candidate.lease_until) > clock.now())) return null;
    await tx.query("UPDATE recovery_delivery SET state='LEASED',lease_token=$2,lease_until=$3,attempts=attempts+1 WHERE operation_id=$1", [candidate.operation_id, token, new Date(clock.now().getTime() + 60000).toISOString()]);
    return candidate;
  });
  if (!claim) return { processed: 0 };
  try {
    const result = await db.transaction(async tx => {
      // Lock protects DB fence changes during publication. An independent restore fence is still an operational prerequisite.
      const fence = (await tx.query<{ generation: string; writes_enabled: boolean }>("SELECT * FROM recovery_writer_fence WHERE singleton=1 FOR UPDATE")).rows[0];
      if (!fence?.writes_enabled || fence.generation !== publisher.writerGeneration) throw new DomainError("RECOVERY_WRITER_FENCED", "This recovery writer is no longer current", 503);
      const delivery = (await tx.query<{ lease_token: string; state: string }>("SELECT lease_token,state FROM recovery_delivery WHERE operation_id=$1 FOR UPDATE", [claim.operation_id])).rows[0];
      if (delivery?.lease_token !== token || delivery.state !== "LEASED") return { processed: 0 };
      await requireDurablePolicySequence(tx,(JSON.parse(claim.canonical_json) as {policySequence?:string|null}).policySequence);
      const objectKey = `recovery/v1/${sha256Hex(claim.operation_id)}.json`;
      let stored = await publisher.store.get(objectKey);
      if (!stored) {
        const facts = { version: 1 as const, domain: "PACKPROOF_SIGNED_RECOVERY_ENVELOPE", eventCanonicalJson: claim.canonical_json, eventSha256: claim.sha256, publishedAt: clock.now().toISOString() };
        const canonical = canonicalize(facts);
        const signature = await publisher.signer.signManifest({ proofId: claim.proof_id, manifestId: claim.operation_id, canonicalJson: canonical, sha256: sha256Hex(canonical) });
        const bytes = Buffer.from(canonicalize({ ...facts, signature }));
        await publisher.store.putIfAbsent(objectKey, bytes, "application/json");
        stored = await publisher.store.get(objectKey);
      }
      if (!stored) throw new DomainError("RECOVERY_OBJECT_UNAVAILABLE", "Recovery envelope is not readable after publication", 503);
      const envelope = await verifyRecoveryEnvelope(stored.body, publisher, claim.sha256);
      const head = publisher.store.head ? await publisher.store.head(objectKey) : null;
      const receipt: PreservationReceipt = { version: 1, operationId: claim.operation_id, eventSha256: claim.sha256, envelopeSha256: sha256Hex(stored.body), objectKey, objectVersionId: head?.versionId ?? null, preservedAt: envelope.publishedAt, signature: envelope.signature };
      await tx.query("UPDATE recovery_delivery SET state='DURABLE',receipt_json=$2,delivered_at=$3,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE operation_id=$1", [claim.operation_id, JSON.stringify(receipt), clock.now().toISOString()]);
      if (claim.kind === "PROOF_FINALIZED") {
        const changed = await tx.query(`UPDATE proofs SET status='FINALIZED',manifest_id=m.id,finalized_at=m.created_at,updated_at=$2 FROM final_manifests m WHERE proofs.id=$1 AND m.proof_id=proofs.id AND proofs.status <> 'FINALIZED' RETURNING proofs.id`, [claim.proof_id, envelope.publishedAt]);
        if(changed.rows[0]) {
          const manifest=(await tx.query("SELECT * FROM final_manifests WHERE proof_id=$1",[claim.proof_id])).rows[0];
          const audit=finalizationAudit(envelope,claim.proof_id,claim.operation_id,manifest);
          await tx.query("INSERT INTO audit_events(id,proof_id,actor_user_id,event_type,event_version,event_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING",[audit.id,audit.proof_id,audit.actor_user_id,audit.event_type,audit.event_version,JSON.stringify(audit.event_data),audit.created_at]);
        }
      }
      return { processed: 1, state: "DURABLE" };
    });
    return result;
  } catch (error) {
    const code = error instanceof DomainError ? error.code : "RECOVERY_DEPENDENCY_UNAVAILABLE";
    const waitingForPolicy = code === "POLICY_DURABILITY_PENDING";
    const dead = code === "RECOVERY_ENVELOPE_CONFLICT" || (!waitingForPolicy && claim.attempts + 1 >= 8);
    const retryAt = new Date(clock.now().getTime() + Math.min(300000, 1000 * 2 ** claim.attempts) + Math.floor(Math.random() * 1000));
    await db.query("UPDATE recovery_delivery SET state=$3,next_attempt_at=$4,error_code=$5,lease_token=NULL,lease_until=NULL WHERE operation_id=$1 AND lease_token=$2", [claim.operation_id, token, dead ? "DEAD_LETTER" : "PENDING", retryAt.toISOString(), code]);
    if(waitingForPolicy)await db.query("UPDATE recovery_delivery SET attempts=GREATEST(0,attempts-1) WHERE operation_id=$1",[claim.operation_id]);
    return { processed: 1, state: dead ? "DEAD_LETTER" : "PENDING" };
  }
}

/** Administrative replay must keep the original immutable accepted event. */
export async function retryRecoveryDelivery(db: Database, clock: Clock, operationId: string) {
  await db.query("UPDATE recovery_delivery SET state='PENDING',attempts=0,next_attempt_at=$2,error_code=NULL,lease_token=NULL,lease_until=NULL WHERE operation_id=$1 AND state='DEAD_LETTER'", [operationId, clock.now().toISOString()]);
}

/** Authenticated, ordered replay preparation. It never opens restored traffic or silently invents missing policy/account coverage. */
export async function buildRecoveryReplayPlan(input: {
  envelopes: Buffer[];
  trustedPublicKey: RecoveryPublisher["trustedPublicKey"];
  backupBoundaryHead: string | null;
}) {
  const verified = await Promise.all(input.envelopes.map(async body => {
    const envelope = await verifyRecoveryEnvelope(body, input);
    const event = JSON.parse(envelope.eventCanonicalJson) as {
      operationId: string; proofId: string; sequence: string; previousSha256: string | null; kind: RecoveryKind;
      payload: {schemaVersion: number; rows: Record<string, Array<Record<string, unknown>>>; coverage: Record<string, boolean>};
    };
    if (!/^[1-9][0-9]*$/.test(event.sequence) || !event.payload || event.payload.schemaVersion !== 1 || !event.payload.rows) throw new DomainError("RECOVERY_REPLAY_UNSUPPORTED", "Recovery event does not contain a supported reconstructable snapshot", 409);
    return { envelope, event, envelopeSha256: sha256Hex(body) };
  }));
  verified.sort((a, b) => BigInt(a.event.sequence) < BigInt(b.event.sequence) ? -1 : BigInt(a.event.sequence) > BigInt(b.event.sequence) ? 1 : 0);
  const operations = new Map<string, string>();
  const snapshots = new Map<string, { rows: Record<string, Array<Record<string, unknown>>>; coverage: Record<string, boolean> }>();
  const acceptedReceipts = [];
  let head = input.backupBoundaryHead;
  let priorSequence = 0n;
  for (const row of verified) {
    const duplicate = operations.get(row.event.operationId);
    if (duplicate === row.envelope.eventSha256) continue;
    if (duplicate || row.event.previousSha256 !== head || BigInt(row.event.sequence) <= priorSequence) throw new DomainError("RECOVERY_REPLAY_CHAIN_GAP", "Recovery journal has a gap or conflicting operation; restored traffic must remain closed", 409);
    operations.set(row.event.operationId, row.envelope.eventSha256);
    head = row.envelope.eventSha256;
    priorSequence = BigInt(row.event.sequence);
    const snapshot = JSON.parse(JSON.stringify(row.event.payload)) as typeof row.event.payload;
    if (row.event.kind === "PROOF_FINALIZED") {
      const manifest = snapshot.rows.final_manifests?.find(value => value.proof_id === row.event.proofId);
      const proof = snapshot.rows.proofs?.find(value => value.id === row.event.proofId);
      if (!manifest || !proof) throw new DomainError("RECOVERY_REPLAY_MISSING_DEPENDENCY", "Finalization recovery is missing its frozen manifest", 409);
      if(proof.status !== "FINALIZED") {
        snapshot.rows.audit_events.push(finalizationAudit(row.envelope,row.event.proofId,row.event.operationId,manifest));
        proof.updated_at = row.envelope.publishedAt;
      }
      Object.assign(proof, { status: "FINALIZED", manifest_id: manifest.id, finalized_at: manifest.created_at });
    }
    snapshots.set(row.event.proofId, { rows: snapshot.rows, coverage: snapshot.coverage });
    acceptedReceipts.push({ operationId: row.event.operationId, eventSha256: row.envelope.eventSha256, envelopeSha256: row.envelopeSha256, preservedAt: row.envelope.publishedAt });
  }
  return {
    schemaVersion: 1,
    finalHead: head,
    acceptedReceipts,
    proofs: [...snapshots].map(([proofId, snapshot]) => ({ proofId, ...snapshot })),
    trafficMayOpen: false,
    remainingGates: ["Independent old-writer fence", "Account and organization policy journal replay", "Access revocation and deletion disposition coverage", "Exact-version media digest/decryption reconciliation", "Measured isolated restore drill and operator approval"],
  };
}
