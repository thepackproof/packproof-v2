/** Opt-in signing of immutable, independently preserved recovery facts. */
import { randomUUID } from 'node:crypto';
import { base64url, flattenedVerify, importSPKI } from 'jose';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { appendAudit } from '../domain/audit.js';
import { buildProofRecoverySnapshot, enqueueRecoveryEvent, getRecoveryStatus, verifyRecoveryEnvelope, type PreservationReceipt, type RecoveryPublisher } from '../domain/recovery-journal.js';
import { ENVELOPE_TYPE, COVERAGE_PROFILE, jcsBytes, sha256, prepareEnvelope, validateCoverage, validateEnvelope, type CoverageArtifact, type EnvelopeJws, type ExactObject, type IntegrityCoverage, type RecordType } from './envelope-profile.js';

type Row = Record<string, any>;
export interface ProtectedReceipt {
  object: ExactObject; sha256: string; byteSize: number;
  mode: 'COMPLIANCE'; retainUntil: string; verifiedAt: string;
}
/** Implementations must stream-check exact versions and read actual retention.
 * No claimed receipt, latest media lookup or bucket default is sufficient. */
export interface EnvelopeStore {
  find(bucket: string, key: string, maxBytes: number): Promise<{ body: Buffer; object: ExactObject } | null>;
  preserve(bucket: string, key: string, bytes: Buffer, retainUntil: string): Promise<ProtectedReceipt>;
  verify(artifact: { storage: ExactObject; sha256: string; byteSize: number }, retainUntil: string): Promise<ProtectedReceipt>;
}
interface FrozenManifest { path: string; canonicalJson: string; sha256: string; recordType: RecordType; recordId: string; }
export interface EnvelopeRequest {
  profile: 'packproof.envelope-job.v1'; proofId: string; recordType: RecordType; recordId: string;
  manifestSchema: string; manifestPath: string; manifestSha256: string;
  issuer: string; keyId: string; artifactBucket: string; retainUntil: string;
  source: { operationId: string; eventSha256: string; receipt: PreservationReceipt };
  manifests: FrozenManifest[]; originals: CoverageArtifact[];
}
export interface EnvelopeBundle {
  profile: 'packproof.envelope-bundle.v1'; operationId: string; requestSha256: string;
  jws: EnvelopeJws; coverage: IntegrityCoverage; receipts: ProtectedReceipt[];
}
interface JobRow { operation_id: string; proof_id: string; request_json: string; request_sha256: string; attempts: number; }
export interface EnvelopeWorker {
  writerGeneration: string; store: EnvelopeStore;
  sourceJournal: { store: Pick<RecoveryPublisher['store'], 'get'>; trustedPublicKey: (keyId: string, signedAt?: string) => Promise<string | null> };
  /** Hosted scheduling rechecks the accepted caller and cohort between external calls. */
  authorizeRequest?: (db: Database, operationId: string, request: EnvelopeRequest) => Promise<void>;
  /** Independently pinned, issuer-bound key history; reject compromised/expired keys here. */
  trustedPublicKey: (issuer: string, keyId: string, issuedAt: string) => Promise<string | null>;
  sign: (keyId: string, envelopeBytes: Uint8Array) => Promise<EnvelopeJws>;
}
const check = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };
const same = (a: unknown, b: unknown) => jcsBytes(a).equals(jcsBytes(b));
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const requestOperation = (operationId: string) => `envelope-request:${operationId}`;
const resultOperation = (operationId: string) => `envelope-signed:${operationId}`;
export const envelopeBundleKey = (operationId: string) => `integrity/v1/envelopes/${operationId}.json`;
export const envelopeOperationId = (request: EnvelopeRequest) => sha256(jcsBytes({ profile: request.profile, proofId: request.proofId, recordType: request.recordType, recordId: request.recordId, manifestSchema: request.manifestSchema, manifestSha256: request.manifestSha256 }));

/** Uses only the accepted snapshot, never current evidence/manifest tables. */
export function requestFromFrozenEvent(event: Row, input: {
  sourceReceipt: PreservationReceipt; evidenceBucket: string; artifactBucket: string;
  issuer: string; keyId: string; retainUntil: string;
}): EnvelopeRequest {
  const recordType: RecordType = event.kind === 'PROOF_FINALIZED' ? 'CORE' : event.kind === 'STAGE_FINALIZED' ? 'STAGE' : event.kind === 'SUPPLEMENT_COMMITTED' ? 'SUPPLEMENT' : (() => { throw Error('ENVELOPE_SOURCE_KIND'); })();
  check(safeId(event.proofId) && event.version === 1 && event.acceptance === 'COMMITTED' && event.domain === 'PACKPROOF_COMMITTED_RECOVERY_EVENT', 'ENVELOPE_SOURCE_IDENTITY');
  const rows = event.payload?.rows;
  check(rows && rows.proofs?.length === 1 && rows.proofs[0].id === event.proofId, 'ENVELOPE_SOURCE_SCOPE');
  const core = rows.final_manifests;
  check(Array.isArray(core) && core.length === 1, 'ENVELOPE_CORE_REQUIRED');
  const manifests: FrozenManifest[] = [];
  const originals = new Map<string, CoverageArtifact>();
  const append = (row: Row, type: RecordType) => {
    check(safeId(row.id) && row.proof_id === event.proofId && typeof row.canonical_json === 'string' && sha256(row.canonical_json) === row.sha256, 'ENVELOPE_FROZEN_RECORD_INVALID');
    const parsed = JSON.parse(row.canonical_json);
    check(parsed.proofId === event.proofId, 'ENVELOPE_SOURCE_SCOPE');
    check(type === 'CORE' ? parsed.manifestVersion === 1 : type === 'STAGE' ? parsed.schema === 'packproof.commerce-stage.v1' && parsed.stageId === row.id : parsed.domain === 'PACKPROOF_PROOF_SUPPLEMENT' && parsed.version === 1 && parsed.supplementId === row.id, 'ENVELOPE_MANIFEST_SCHEMA');
    manifests.push({ path: `manifests/${type.toLowerCase()}/${row.id}.json`, canonicalJson: row.canonical_json, sha256: row.sha256, recordType: type, recordId: row.id });
    if (type !== 'SUPPLEMENT') {
      check(Array.isArray(parsed.evidence) && parsed.evidence.length > 0, 'ENVELOPE_MEDIA_REQUIRED');
      for (const media of parsed.evidence) {
        check(safeId(media.evidenceId), 'ENVELOPE_MEDIA_ID');
        const artifact: CoverageArtifact = { path: `originals/${media.evidenceId}`, kind: 'ORIGINAL', sha256: media.sha256, byteSize: media.byteSize, required: true, storage: { bucket: input.evidenceBucket, key: media.objectKey, versionId: media.objectVersionId }, sourcePath: null };
        const prior = originals.get(artifact.path);
        check(!prior || same(prior, artifact), 'ENVELOPE_MEDIA_CONFLICT');
        originals.set(artifact.path, artifact);
      }
    }
  };
  append(core[0], 'CORE');
  if (recordType !== 'CORE') {
    for (const row of (rows.commerce_stages ?? []).filter((r: Row) => r.finalized_at != null).sort((a: Row, b: Row) => a.id.localeCompare(b.id))) append(row, 'STAGE');
    for (const row of (rows.proof_supplements ?? []).sort((a: Row, b: Row) => Number(a.sequence) - Number(b.sequence))) append(row, 'SUPPLEMENT');
  }
  const root = manifests.find(m => m.recordType === recordType && event.operationId === (recordType === 'CORE' ? `finalize:${event.proofId}` : recordType === 'STAGE' ? `stage-finalize:${m.recordId}` : `supplement:${m.recordId}`));
  check(root, 'ENVELOPE_SOURCE_OPERATION');
  const request: EnvelopeRequest = { profile: 'packproof.envelope-job.v1', proofId: event.proofId, recordType, recordId: root!.recordId,
    manifestSchema: recordType === 'CORE' ? 'packproof.manifest.v1' : recordType === 'STAGE' ? 'packproof.commerce-stage.v1' : 'packproof.proof-supplement.v1',
    manifestPath: root!.path, manifestSha256: root!.sha256, issuer: input.issuer, keyId: input.keyId, artifactBucket: input.artifactBucket, retainUntil: input.retainUntil,
    source: { operationId: event.operationId, eventSha256: input.sourceReceipt.eventSha256, receipt: input.sourceReceipt }, manifests, originals: [...originals.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  check(input.sourceReceipt.operationId === event.operationId && input.sourceReceipt.objectVersionId && input.sourceReceipt.objectVersionId !== 'null', 'ENVELOPE_SOURCE_RECEIPT_REQUIRED');
  check(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.artifactBucket) && /^[A-Za-z0-9_:/.-]{1,200}$/.test(input.keyId), 'ENVELOPE_CONFIGURATION');
  check(new Date(input.retainUntil).toISOString() === input.retainUntil, 'ENVELOPE_RETENTION_REQUIRED');
  // Temporary manifest references validate the complete shape before any write;
  // only real preserve() receipts enter the final coverage.
  const coverage = coverageFor(request, manifests.map(m => ({ object: { bucket: input.artifactBucket, key: manifestKey(m), versionId: 'validation-only' }, sha256: m.sha256, byteSize: Buffer.byteLength(m.canonicalJson), mode: 'COMPLIANCE', retainUntil: input.retainUntil, verifiedAt: input.retainUntil })));
  prepareEnvelope({ proofId: request.proofId, recordType, recordId: request.recordId, manifestSchema: request.manifestSchema, manifestPath: root!.path, manifestSha256: root!.sha256, issuer: input.issuer, issuedAt: input.retainUntil, coverage, manifestBytes: Buffer.from(root!.canonicalJson) });
  check(jcsBytes(request).length <= 8 * 1024 * 1024, 'ENVELOPE_REQUEST_TOO_LARGE');
  return request;
}
const manifestKey = (m: FrozenManifest) => `integrity/v1/manifests/${m.sha256}.json`;
function coverageFor(request: EnvelopeRequest, receipts: ProtectedReceipt[]): IntegrityCoverage {
  const artifacts: CoverageArtifact[] = request.manifests.map((m, i) => ({ path: m.path, kind: 'MANIFEST', sha256: m.sha256, byteSize: Buffer.byteLength(m.canonicalJson), required: true, storage: receipts[i].object, sourcePath: null }));
  const coverage: IntegrityCoverage = { profile: COVERAGE_PROFILE, proofId: request.proofId, recordType: request.recordType, recordId: request.recordId, artifacts: [...artifacts, ...request.originals], stages: request.manifests.filter(m => m.recordType === 'STAGE').map(m => ({ stageId: m.recordId, manifestPath: m.path, manifestSha256: m.sha256 })), omissions: [] };
  validateCoverage(coverage); return coverage;
}
async function lockFence(tx: Database, generation: string) {
  // Same order as core recovery publication, including result snapshot enqueue.
  await tx.query('SELECT pg_advisory_xact_lock(1347438146, 36)');
  const row = (await tx.query<{ writes_enabled: boolean; generation: string }>('SELECT * FROM recovery_writer_fence WHERE singleton=1 FOR UPDATE')).rows[0];
  check(row?.writes_enabled && row.generation === generation, 'ENVELOPE_WRITER_FENCED');
}
/** Internal admission only: caller must explicitly select an authorized cohort.
 * The source's core transaction already atomically recorded its recovery outbox. */
export async function enqueueEnvelopeFromRecovery(db: Database, clock: Clock, input: {
  sourceOperationId: string; evidenceBucket: string; artifactBucket: string; issuer: string; keyId: string; retainUntil: string; writerGeneration: string;
  actorUserId?: string;
}) {
  return db.transaction(async tx => {
    await lockFence(tx, input.writerGeneration);
    const source = (await tx.query<{ canonical_json: string; sha256: string; receipt_json: PreservationReceipt }>(`SELECT e.canonical_json,e.sha256,d.receipt_json FROM recovery_events e JOIN recovery_delivery d USING(operation_id) WHERE e.operation_id=$1 AND d.state='DURABLE'`, [input.sourceOperationId])).rows[0];
    check(source && sha256(source.canonical_json) === source.sha256 && source.receipt_json?.eventSha256 === source.sha256, 'ENVELOPE_SOURCE_NOT_DURABLE');
    check(Date.parse(input.retainUntil) > clock.now().getTime(), 'ENVELOPE_RETENTION_EXPIRED');
    const request = requestFromFrozenEvent(JSON.parse(source.canonical_json), { ...input, sourceReceipt: source.receipt_json });
    const operationId = envelopeOperationId(request);
    const requestJson = jcsBytes(request).toString(), requestSha = sha256(requestJson);
    const prior = (await tx.query<{ request_sha256: string }>('SELECT request_sha256 FROM integrity_envelope_jobs WHERE operation_id=$1', [operationId])).rows[0];
    if (prior) { check(prior.request_sha256 === requestSha, 'ENVELOPE_OPERATION_CONFLICT'); return { operationId, replayed: true }; }
    await tx.query(`INSERT INTO integrity_envelope_jobs(operation_id,proof_id,record_type,record_id,manifest_sha256,request_json,request_sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [operationId, request.proofId, request.recordType, request.recordId, request.manifestSha256, requestJson, requestSha, clock.now().toISOString()]);
    await tx.query('INSERT INTO integrity_envelope_delivery(operation_id,next_attempt_at) VALUES($1,$2)', [operationId, clock.now().toISOString()]);
    await appendAudit(tx,{proofId:request.proofId,actorUserId:input.actorUserId??null,eventType:'ENVELOPE_SIGNING_REQUESTED',eventData:{operationId,sourceOperationId:request.source.operationId,manifestSha256:request.manifestSha256},at:clock.now()});
    await enqueueRecoveryEvent(tx, clock, { operationId: requestOperation(operationId), kind: 'ENVELOPE_REQUESTED', proofId: request.proofId, actorUserId: input.actorUserId??null, payload: await buildProofRecoverySnapshot(tx, request.proofId) });
    return { operationId, replayed: false };
  });
}
export function validateEnvelopeReceipt(receipt: ProtectedReceipt, artifact: { storage: ExactObject; sha256: string; byteSize: number }, until: string) {
  check(receipt && same(receipt.object, artifact.storage) && receipt.sha256 === artifact.sha256 && receipt.byteSize === artifact.byteSize && receipt.mode === 'COMPLIANCE' && Date.parse(receipt.retainUntil) >= Date.parse(until) && Number.isFinite(Date.parse(receipt.verifiedAt)), 'ENVELOPE_PROTECTION_MISMATCH');
}
export async function verifyEnvelopeSource(request: EnvelopeRequest, worker: Pick<EnvelopeWorker, 'sourceJournal'>) {
  const receipt = request.source.receipt;
  const saved = await worker.sourceJournal.store.get(receipt.objectKey, { versionId: receipt.objectVersionId! });
  check(saved && sha256(saved.body) === receipt.envelopeSha256, 'ENVELOPE_SOURCE_VERSION_UNAVAILABLE');
  // Use the publication time inside the signed payload, not mutable signature metadata.
  const sourceSignedAt = JSON.parse(saved!.body.toString('utf8')).publishedAt;
  const envelope = await verifyRecoveryEnvelope(saved!.body, { trustedPublicKey: id => worker.sourceJournal.trustedPublicKey(id, sourceSignedAt) }, request.source.eventSha256);
  const event = JSON.parse(envelope.eventCanonicalJson);
  const rebuilt = requestFromFrozenEvent(event, { sourceReceipt: receipt, evidenceBucket: request.originals[0]?.storage.bucket ?? '', artifactBucket: request.artifactBucket, issuer: request.issuer, keyId: request.keyId, retainUntil: request.retainUntil });
  check(same(rebuilt, request), 'ENVELOPE_SOURCE_BINDING_MISMATCH');
}
/** Validates a stored first result, including independently resolved key and every
 * exact manifest/media version. Reused after lost responses and during restore. */
export async function verifyEnvelopeBundle(request: EnvelopeRequest, operationId: string, requestSha256: string, bytes: Buffer, worker: Pick<EnvelopeWorker, 'trustedPublicKey'> & { store: Pick<EnvelopeStore, 'verify'> }, beforeArtifact?: () => Promise<void>): Promise<EnvelopeBundle> {
  check(bytes.length <= 12 * 1024 * 1024, 'ENVELOPE_BUNDLE_TOO_LARGE');
  const bundle: EnvelopeBundle = JSON.parse(bytes.toString('utf8'));
  check(jcsBytes(bundle).equals(bytes) && Object.keys(bundle).sort().join(',') === 'coverage,jws,operationId,profile,receipts,requestSha256' && bundle.profile === 'packproof.envelope-bundle.v1' && bundle.operationId === operationId && bundle.requestSha256 === requestSha256, 'ENVELOPE_BUNDLE_CONFLICT');
  validateCoverage(bundle.coverage);
  check(Array.isArray(bundle.receipts) && bundle.receipts.length === bundle.coverage.artifacts.length, 'ENVELOPE_RECEIPT_COVERAGE');
  check(Object.keys(bundle.jws).sort().join(',') === 'payload,protected,signature', 'ENVELOPE_JWS_FIELDS');
  const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64url.decode(bundle.jws.payload)));
  validateEnvelope(envelope);
  const pem = await worker.trustedPublicKey(request.issuer, request.keyId, envelope.issuedAt);
  check(pem, 'ENVELOPE_UNTRUSTED_KEY');
  const verified = await flattenedVerify(bundle.jws, await importSPKI(pem!, 'ES256'), { algorithms: ['ES256'] });
  check(same(verified.protectedHeader, { alg: 'ES256', kid: request.keyId, typ: ENVELOPE_TYPE }) && base64url.encode(jcsBytes(verified.protectedHeader)) === bundle.jws.protected, 'ENVELOPE_KEY_BINDING');
  const frozen = request.manifests.find(m => m.path === request.manifestPath)!;
  const prepared = prepareEnvelope({ proofId: request.proofId, recordId: request.recordId, recordType: request.recordType, manifestPath: request.manifestPath, manifestSchema: request.manifestSchema, manifestSha256: request.manifestSha256, issuer: request.issuer, issuedAt: envelope.issuedAt, manifestBytes: Buffer.from(frozen.canonicalJson), coverage: bundle.coverage });
  check(Buffer.from(verified.payload).equals(prepared.envelopeBytes), 'ENVELOPE_PAYLOAD_BINDING');
  const manifests = bundle.coverage.artifacts.slice(0, request.manifests.length);
  request.manifests.forEach((m, i) => check(manifests[i]?.storage.bucket === request.artifactBucket && manifests[i]?.storage.key === manifestKey(m), 'ENVELOPE_MANIFEST_LOCATION'));
  check(same(coverageFor(request, bundle.receipts.slice(0, request.manifests.length)), bundle.coverage), 'ENVELOPE_COVERAGE_BINDING');
  for (let i = 0; i < bundle.coverage.artifacts.length; i++) {
    await beforeArtifact?.();
    const artifact = bundle.coverage.artifacts[i];
    validateEnvelopeReceipt(bundle.receipts[i], artifact, request.retainUntil);
    validateEnvelopeReceipt(await worker.store.verify(artifact, request.retainUntil), artifact, request.retainUntil);
  }
  return bundle;
}
export async function processEnvelopeJob(db: Database, clock: Clock, worker: EnvelopeWorker): Promise<{ processed: number; state?: string }> {
  const token = randomUUID(), now = clock.now();
  const job = await db.transaction(async tx => {
    await lockFence(tx, worker.writerGeneration);
    const row = (await tx.query<JobRow>(`SELECT j.*,d.attempts FROM integrity_envelope_jobs j JOIN integrity_envelope_delivery d USING(operation_id) JOIN recovery_delivery r ON r.operation_id='envelope-request:'||j.operation_id WHERE r.state='DURABLE' AND (d.state='PENDING' OR (d.state='LEASED' AND d.lease_until<=$1)) AND d.next_attempt_at<=$1 ORDER BY j.created_at,j.operation_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [now.toISOString()])).rows[0];
    if (!row) return null;
    await tx.query("UPDATE integrity_envelope_delivery SET state='LEASED',lease_token=$2,lease_until=$3,attempts=attempts+1 WHERE operation_id=$1", [row.operation_id, token, new Date(now.getTime() + 120000).toISOString()]);
    return row;
  });
  if (!job) return { processed: 0 };
  let request: EnvelopeRequest;
  const renew = () => db.transaction(async tx => {
    await lockFence(tx,worker.writerGeneration);
    await worker.authorizeRequest?.(tx, job.operation_id, request);
    const at=clock.now();
    const updated=await tx.query("UPDATE integrity_envelope_delivery SET lease_until=$4 WHERE operation_id=$1 AND lease_token=$2 AND state='LEASED' AND lease_until>$3",[job.operation_id,token,at.toISOString(),new Date(at.getTime()+120000).toISOString()]);
    check(updated.rowCount===1,'ENVELOPE_LEASE_LOST');
  });
  try {
    check(sha256(job.request_json) === job.request_sha256, 'ENVELOPE_REQUEST_CORRUPT');
    request = JSON.parse(job.request_json);
    check(Date.parse(request.retainUntil) > clock.now().getTime(), 'ENVELOPE_RETENTION_EXPIRED');
    // All storage and KMS calls occur between transactions. The final CAS checks
    // the lease and writer generation again, so an old worker cannot acknowledge.
    await renew();
    await verifyEnvelopeSource(request, worker);
    await renew();
    const key = envelopeBundleKey(job.operation_id);
    let stored = await worker.store.find(request.artifactBucket, key, 12 * 1024 * 1024);
    if (!stored) {
      const receipts: ProtectedReceipt[] = [];
      for (const manifest of request.manifests) { await renew(); receipts.push(await worker.store.preserve(request.artifactBucket, manifestKey(manifest), Buffer.from(manifest.canonicalJson), request.retainUntil)); }
      for (const artifact of request.originals) { await renew(); receipts.push(await worker.store.verify(artifact, request.retainUntil)); }
      const coverage = coverageFor(request, receipts);
      for (let i = 0; i < coverage.artifacts.length; i++) validateEnvelopeReceipt(receipts[i], coverage.artifacts[i], request.retainUntil);
      const manifest = request.manifests.find(m => m.path === request.manifestPath)!;
      const prepared = prepareEnvelope({ proofId: request.proofId, recordId: request.recordId, recordType: request.recordType, manifestSchema: request.manifestSchema, manifestPath: request.manifestPath, manifestSha256: request.manifestSha256, issuer: request.issuer, issuedAt: clock.now().toISOString(), manifestBytes: Buffer.from(manifest.canonicalJson), coverage });
      check(await worker.trustedPublicKey(request.issuer, request.keyId, prepared.envelope.issuedAt), 'ENVELOPE_UNTRUSTED_KEY');
      await renew();
      const jws = await worker.sign(request.keyId, prepared.envelopeBytes);
      const candidate: EnvelopeBundle = { profile: 'packproof.envelope-bundle.v1', operationId: job.operation_id, requestSha256: job.request_sha256, jws, coverage, receipts };
      // Verify before permanent publication. Conditional create chooses one result
      // if leases overlap; every contender reads and verifies that same object.
      await verifyEnvelopeBundle(request, job.operation_id, job.request_sha256, jcsBytes(candidate), worker, renew);
      await renew();
      await worker.store.preserve(request.artifactBucket, key, jcsBytes(candidate), request.retainUntil);
      stored = await worker.store.find(request.artifactBucket, key, 12 * 1024 * 1024);
    }
    check(stored && stored.object.bucket === request.artifactBucket && stored.object.key === key, 'ENVELOPE_RESULT_UNAVAILABLE');
    await verifyEnvelopeBundle(request, job.operation_id, job.request_sha256, stored!.body, worker, renew);
    const artifact = { storage: stored!.object, sha256: sha256(stored!.body), byteSize: stored!.body.length };
    const receipt = await worker.store.verify(artifact, request.retainUntil);
    validateEnvelopeReceipt(receipt, artifact, request.retainUntil);
    return await db.transaction(async tx => {
      await lockFence(tx, worker.writerGeneration);
      const lease = (await tx.query<{ lease_token: string; state: string; lease_until: Date | string }>('SELECT state,lease_token,lease_until FROM integrity_envelope_delivery WHERE operation_id=$1 FOR UPDATE', [job.operation_id])).rows[0];
      if (lease?.state !== 'LEASED' || lease.lease_token !== token || new Date(lease.lease_until).getTime() <= clock.now().getTime()) return { processed: 0, state: 'LEASE_LOST' };
      await worker.authorizeRequest?.(tx, job.operation_id, request);
      await tx.query('INSERT INTO integrity_envelope_results(operation_id,proof_id,bundle_json,bundle_sha256,receipt_json,accepted_at) VALUES($1,$2,$3,$4,$5,$6)', [job.operation_id, job.proof_id, stored!.body.toString(), artifact.sha256, JSON.stringify(receipt), clock.now().toISOString()]);
      await tx.query("UPDATE integrity_envelope_delivery SET state='ACCEPTED',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE operation_id=$1", [job.operation_id]);
      await appendAudit(tx,{proofId:job.proof_id,actorUserId:null,eventType:'ENVELOPE_SIGNATURE_ACCEPTED',eventData:{operationId:job.operation_id,bundleSha256:artifact.sha256},at:clock.now()});
      await enqueueRecoveryEvent(tx, clock, { operationId: resultOperation(job.operation_id), kind: 'ENVELOPE_SIGNED', proofId: job.proof_id, actorUserId: null, payload: await buildProofRecoverySnapshot(tx, job.proof_id) });
      return { processed: 1, state: 'SIGNED_PENDING_DURABILITY' };
    });
  } catch (error) {
    const code = error instanceof Error && /^ENVELOPE_[A-Z_]+$/.test(error.message) ? error.message : 'ENVELOPE_DEPENDENCY_UNAVAILABLE';
    const terminal = /CONFLICT|CORRUPT|MISMATCH|BINDING|UNTRUSTED|EXPIRED|INVALID|REVOKED/.test(code) || job.attempts >= 7;
    const state = terminal ? 'DEAD_LETTER' : 'PENDING';
    // Releasing only our lease is safe even after the generation was fenced.
    const updated = await db.query("UPDATE integrity_envelope_delivery SET state=$3,error_code=$4,lease_token=NULL,lease_until=NULL,next_attempt_at=$5 WHERE operation_id=$1 AND lease_token=$2 AND state='LEASED'", [job.operation_id, token, state, code, new Date(clock.now().getTime() + Math.min(60000, 1000 * 2 ** job.attempts)).toISOString()]);
    return { processed: code==='ENVELOPE_LEASE_LOST'?0:updated.rowCount, state: updated.rowCount && code!=='ENVELOPE_LEASE_LOST' ? state : 'LEASE_LOST' };
  }
}
/** Internal status; expose only behind the existing current Proof access check. */
export async function envelopeJobStatus(db: Database, operationId: string) {
  const row = (await db.query<{ state: string; error_code: string | null }>('SELECT state,error_code FROM integrity_envelope_delivery WHERE operation_id=$1', [operationId])).rows[0];
  if (!row) return { state: 'NOT_REQUESTED' };
  if (row.state === 'ACCEPTED') return { state: (await getRecoveryStatus(db, resultOperation(operationId))).status === 'PRESERVED' ? 'READY' : 'SIGNED_PENDING_DURABILITY' };
  return { state: row.state === 'DEAD_LETTER' ? 'FAILED' : 'PENDING', errorCode: row.error_code };
}
