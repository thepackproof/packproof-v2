import { base64url } from 'jose';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { requireParticipant } from '../domain/proof-access.js';
import { guardAuthorizedStream } from '../domain/authorized-stream.js';
import { strictBody } from '../platform/organizations.js';
import { requireHumanActor } from '../platform/organization-access.js';
import { envelopeBundleKey, envelopeOperationId, enqueueEnvelopeFromRecovery, envelopeJobStatus, requestFromFrozenEvent,
  verifyEnvelopeBundle, verifyEnvelopeSource, validateEnvelopeReceipt,
  type EnvelopeRequest, type EnvelopeStore, type EnvelopeWorker, type ProtectedReceipt } from './envelope-jobs.js';
import { jcsBytes, sha256, type ExactObject } from './envelope-profile.js';
import { streamEnvelopePackage } from './envelope-package.js';

export interface EnvelopeReader {
  readExact(object: ExactObject, maximumBytes: number): Promise<{ body: Buffer; versionId: string }>;
  openExact(object: ExactObject): Promise<{ body: AsyncIterable<Uint8Array>; versionId: string }>;
  verify: EnvelopeStore['verify'];
}
export interface EnvelopeAccessRuntime {
  assertReady(): void;
  cohort: { merchantIds: readonly string[]; environment: string; cutoverAt: string };
  admission: { evidenceBucket: string; artifactBucket: string; issuer: string; keyId: string; retainUntil: string; writerGeneration: string };
  reader: EnvelopeReader;
  sourceJournal: EnvelopeWorker['sourceJournal'];
  trustedPublicKey: EnvelopeWorker['trustedPublicKey'];
}
type RequestRow = { operation_id: string; proof_id: string; record_type: string; record_id: string; manifest_sha256: string; request_json: string; request_sha256: string };
const unavailable = () => new DomainError('ENVELOPE_UNAVAILABLE', 'This integrity envelope is unavailable.', 404);
const integrityFailure = () => new DomainError('ENVELOPE_INTEGRITY_FAILURE', 'The stored integrity envelope could not be verified.', 409);
/** Existing ZIP transport is capped at 220 MiB. Reserve 20 MiB for bounded
 * coverage/JWS metadata and ZIP headers before any artifact is read or signed. */
export function assertEnvelopeRequestBudget(request: Pick<EnvelopeRequest, 'manifests' | 'originals'>) {
  let remaining = 200 * 1024 * 1024;
  for (const size of [...request.manifests.map(m => Buffer.byteLength(m.canonicalJson)), ...request.originals.map(a => a.byteSize)]) {
    if (!Number.isSafeInteger(size) || size < 0 || size > remaining)
      throw new DomainError('ENVELOPE_PACKAGE_TOO_LARGE', 'This record exceeds the supported integrity package size.', 413);
    remaining -= size;
  }
}
function assertRuntimeReady(runtime: EnvelopeAccessRuntime) {
  try { runtime.assertReady(); }
  catch { throw new DomainError('ENVELOPE_DEPLOYMENT_UNAVAILABLE', 'Integrity envelope service verification needs review.', 503); }
}
function enabled(runtime?: EnvelopeAccessRuntime): EnvelopeAccessRuntime {
  if (!runtime) throw new DomainError('ENVELOPES_DISABLED', 'Integrity envelopes have not been enabled.', 503);
  assertRuntimeReady(runtime); return runtime;
}
async function authorize(db: Database, actor: string, proofId: string, runtime: EnvelopeAccessRuntime) {
  assertRuntimeReady(runtime);
  await requireParticipant(db, proofId, actor);
  const owned = (await db.query<{ merchant_id: string; environment: string }>(`SELECT p.merchant_id,p.environment FROM platform_proof_ownership p
    JOIN platform_organizations o ON o.id=p.merchant_id WHERE p.proof_id=$1 AND o.enabled=true FOR SHARE OF o`, [proofId])).rows[0];
  if (!owned || owned.environment !== runtime.cohort.environment || !runtime.cohort.merchantIds.includes(owned.merchant_id)) throw unavailable();
}
function decode(row: RequestRow): EnvelopeRequest {
  const request: EnvelopeRequest = JSON.parse(row.request_json);
  if (sha256(row.request_json) !== row.request_sha256 || !jcsBytes(request).equals(Buffer.from(row.request_json)) || envelopeOperationId(request) !== row.operation_id || request.proofId !== row.proof_id || request.recordType !== row.record_type || request.recordId !== row.record_id || request.manifestSha256 !== row.manifest_sha256) throw integrityFailure();
  assertEnvelopeRequestBudget(request);
  return request;
}
async function currentJob(db: Database, actor: string, proofId: string, operationId: string, runtime: EnvelopeAccessRuntime) {
  await authorize(db, actor, proofId, runtime);
  if (!/^[a-f0-9]{64}$/.test(operationId)) throw unavailable();
  const row = (await db.query<RequestRow>('SELECT * FROM integrity_envelope_jobs WHERE operation_id=$1 AND proof_id=$2', [operationId, proofId])).rows[0];
  if (!row) throw unavailable();
  const status = await envelopeJobStatus(db, operationId);
  if (status.state === 'NOT_REQUESTED') throw integrityFailure();
  return { row, request: decode(row), status };
}
export async function requestProofEnvelope(db: Database, clock: Clock, actor: string, proofId: string, input: unknown, configured?: EnvelopeAccessRuntime) {
  const runtime = enabled(configured), body = strictBody(input, ['recordType', 'recordId']);
  if (!['CORE', 'STAGE', 'SUPPLEMENT'].includes(String(body.recordType)) || typeof body.recordId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(body.recordId))
    throw new DomainError('ENVELOPE_INPUT_INVALID', 'Select a frozen CORE, STAGE or SUPPLEMENT record.', 400);
  const sourceOperationId = body.recordType === 'CORE' ? `finalize:${proofId}` : body.recordType === 'STAGE' ? `stage-finalize:${body.recordId}` : `supplement:${body.recordId}`;
  const result = await db.transaction(async tx => {
    // Match the recovery writer's lock order before taking current authorization locks.
    await tx.query('SELECT pg_advisory_xact_lock(1347438146, 36)');
    await authorize(tx, actor, proofId, runtime);
    await requireHumanActor(tx, actor);
    const source = (await tx.query<{ canonical_json: string; sha256: string; receipt_json: any }>(`SELECT e.canonical_json,e.sha256,d.receipt_json FROM recovery_events e
      JOIN recovery_delivery d USING(operation_id) WHERE e.operation_id=$1 AND e.proof_id=$2 AND e.created_at >= $3 AND d.state='DURABLE'`, [sourceOperationId, proofId, runtime.cohort.cutoverAt])).rows[0];
    if (!source) throw new DomainError('ENVELOPE_SOURCE_UNAVAILABLE', 'A preserved record within the enabled cutover is required.', 409);
    if (sha256(source.canonical_json) !== source.sha256 || source.receipt_json?.eventSha256 !== source.sha256) throw integrityFailure();
    const frozen = requestFromFrozenEvent(JSON.parse(source.canonical_json), { ...runtime.admission, sourceReceipt: source.receipt_json });
    if (frozen.proofId !== proofId || frozen.recordType !== body.recordType || frozen.recordId !== body.recordId) throw unavailable();
    assertEnvelopeRequestBudget(frozen);
    const queued = await enqueueEnvelopeFromRecovery(tx, clock, { ...runtime.admission, sourceOperationId, actorUserId: actor });
    return { ...queued, proofId, recordType: frozen.recordType, recordId: frozen.recordId, ...(await envelopeJobStatus(tx, queued.operationId)) };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'ENVELOPE_OPERATION_CONFLICT') throw new DomainError('ENVELOPE_OPERATION_CONFLICT', 'This frozen record already has a request under a different preservation policy.', 409);
    throw error;
  });
  await authorize(db, actor, proofId, runtime); // Replays cannot bypass a completed revocation.
  return result;
}
export async function getProofEnvelope(db: Database, actor: string, proofId: string, operationId: string, configured?: EnvelopeAccessRuntime) {
  const runtime = enabled(configured);
  const { row, status } = await currentJob(db, actor, proofId, operationId, runtime);
  await authorize(db, actor, proofId, runtime);
  return { operationId, proofId, recordType: row.record_type, recordId: row.record_id, manifestSha256: row.manifest_sha256, ...status };
}
/** Accepted caller identity is read from the immutable request recovery event.
 * Hosted admission currently accepts first-party humans; partner credentials may
 * read/export under their current delegated scope but cannot enqueue new signing.
 */
export async function assertEnvelopeRequestAuthority(db: Database, runtime: EnvelopeAccessRuntime, operationId: string, request: EnvelopeRequest) {
  runtime.assertReady();
  const row = (await db.query<{ canonical_json: string; sha256: string }>("SELECT canonical_json,sha256 FROM recovery_events WHERE operation_id=$1 AND proof_id=$2 AND kind='ENVELOPE_REQUESTED'", [`envelope-request:${operationId}`, request.proofId])).rows[0];
  if (!row || sha256(row.canonical_json) !== row.sha256) throw Error('ENVELOPE_REQUEST_CORRUPT');
  const event = JSON.parse(row.canonical_json);
  if (event.operationId !== `envelope-request:${operationId}` || event.proofId !== request.proofId || typeof event.actorUserId !== 'string') throw Error('ENVELOPE_AUTHORIZATION_REVOKED');
  try { await requireHumanActor(db, event.actorUserId); await authorize(db, event.actorUserId, request.proofId, runtime); }
  catch (error) {
    if (error instanceof DomainError && error.httpStatus < 500) throw Error('ENVELOPE_AUTHORIZATION_REVOKED');
    throw error;
  }
}
export async function exportProofEnvelope(db: Database, actor: string, proofId: string, operationId: string, configured?: EnvelopeAccessRuntime) {
  const runtime = enabled(configured);
  const checkAccess = () => authorize(db, actor, proofId, runtime);
  const { row, request, status } = await currentJob(db, actor, proofId, operationId, runtime);
  if (status.state !== 'READY') throw new DomainError('ENVELOPE_NOT_READY', 'Download is available after the signed result is preserved.', 409);
  const result = (await db.query<{ bundle_json: string; bundle_sha256: string; receipt_json: ProtectedReceipt }>('SELECT bundle_json,bundle_sha256,receipt_json FROM integrity_envelope_results WHERE operation_id=$1 AND proof_id=$2', [operationId, proofId])).rows[0];
  if (!result || sha256(result.bundle_json) !== result.bundle_sha256) throw integrityFailure();
  const receipt = result.receipt_json;
  if (receipt?.object?.bucket !== request.artifactBucket || receipt.object.key !== envelopeBundleKey(operationId)) throw integrityFailure();
  const artifact = { storage: receipt.object, sha256: result.bundle_sha256, byteSize: Buffer.byteLength(result.bundle_json) };
  validateEnvelopeReceipt(receipt, artifact, request.retainUntil);
  await checkAccess();
  const stored = await runtime.reader.readExact(receipt.object, 12 * 1024 * 1024);
  if (stored.versionId !== receipt.object.versionId || !stored.body.equals(Buffer.from(result.bundle_json))) throw integrityFailure();
  validateEnvelopeReceipt(await runtime.reader.verify(artifact, request.retainUntil), artifact, request.retainUntil);
  await verifyEnvelopeSource(request, runtime);
  const bundle = await verifyEnvelopeBundle(request, operationId, row.request_sha256, stored.body, { store: runtime.reader, trustedPublicKey: runtime.trustedPublicKey }, checkAccess);
  const issuedAt = JSON.parse(Buffer.from(base64url.decode(bundle.jws.payload)).toString('utf8')).issuedAt;
  const pem = await runtime.trustedPublicKey(request.issuer, request.keyId, issuedAt);
  if (!pem) throw integrityFailure();
  const assertCurrentAccess = async () => {
    await checkAccess();
    // Key compromise during a slow response must prevent a complete archive too.
    if (await runtime.trustedPublicKey(request.issuer, request.keyId, issuedAt) !== pem) throw integrityFailure();
  };
  const stream = await streamEnvelopePackage({ jws: bundle.jws, coverage: bundle.coverage, trustedKeyId: request.keyId, trustedPublicKeyPem: pem,
    openExactObject: object => runtime.reader.openExact(object), assertCurrentAccess });
  return guardAuthorizedStream(stream, assertCurrentAccess);
}
