import { surfaceMethodPin } from './method.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { authorizeProofAccess, loadProof } from '../domain/proof-access.js';
import { requireCommerceAccess } from '../domain/commerce-lifecycle.js';
import { appendAudit } from '../domain/audit.js';
import { SURFACE_METHOD, surfaceCapabilities, surfaceConfigFromEnv } from './config.js';
import type { SurfaceKind, SurfaceRecord, SurfaceSource, SurfaceCapture } from './types.js';
export function fail(code: string, message: string, status = 400): never {
  throw new DomainError(code, message, status);
}
export const digest = (x: unknown) => sha256Hex(canonicalize(x));
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SURFACE_INVALID_REQUEST', 'Expected an object');
  return value as Record<string, any>;
}
export function exact(value: Record<string, any>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('SURFACE_INVALID_REQUEST', 'Unknown fields, client scores and qualification claims are not accepted');
}
export const identifier = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_:.\/-]{1,200}$/.test(v);
export const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function config(deps: AppDependencies) {
  return deps.surface ?? surfaceConfigFromEnv();
}
export function enabled(deps: AppDependencies, kind: 'collection' | 'internalComparison') {
  if (!surfaceCapabilities(config(deps))[kind]) fail('SURFACE_DISABLED', 'Experimental surface capability is disabled', 409);
}
export async function access(db: Database, proofId: string, actor: string) {
  const p = await loadProof(db, proofId);
  if (p.status === 'FINALIZED' && p.workflow_type === 'COMMERCE_SALE') return requireCommerceAccess(db, proofId, actor);
  return (await authorizeProofAccess(db, proofId, actor)).role;
}
async function session(db: Database, proofId: string, actor: string, id: string | null) {
  if (id === null) return;
  const s = (await db.query<{
    id: string;
  }>("SELECT id FROM capture_sessions WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3 AND state<>'CANCELLED'", [id, proofId, actor])).rows[0];
  if (!s) fail('SURFACE_SESSION_MISMATCH', 'Capture session does not belong to this actor and Proof', 403);
}
export async function scope(db: Database, proofId: string) {
  const tenant = (await db.query<{
    tenant_id: string;
  }>('SELECT tenant_id FROM api_tenant_proofs WHERE proof_id=$1', [proofId])).rows[0];
  const seller = (await db.query<{
    user_id: string;
  }>("SELECT user_id FROM proof_participants WHERE proof_id=$1 AND role='SELLER'", [proofId])).rows[0];
  const parcel = (await db.query<{
    parcel_id: string;
  }>('SELECT parcel_id FROM proof_parcel_scopes WHERE proof_id=$1', [proofId])).rows[0];
  return {
    tenantScope: tenant?.tenant_id ?? `account:${seller?.user_id}`,
    packageInstanceId: parcel?.parcel_id ?? `proof-package:${proofId}`
  };
}
export async function appendExtension(deps: AppDependencies, tx: Database, proofId: string, subjectId: string, facts: Record<string, unknown>) {
  await loadProof(tx, proofId, true);
  const root = (await tx.query<{
    sha256: string;
  }>('SELECT sha256 FROM final_manifests WHERE proof_id=$1', [proofId])).rows[0];
  const previous = (await tx.query<{
    sequence: number;
    sha256: string;
  }>('SELECT sequence,sha256 FROM surface_extensions WHERE proof_id=$1 ORDER BY sequence DESC LIMIT 1', [proofId])).rows[0];
  const id = newId('surface_ext'),
    sequence = (previous?.sequence ?? 0) + 1,
    previousSha256 = previous?.sha256 ?? null,
    rootManifestSha256 = root?.sha256 ?? null,
    at = deps.clock.now().toISOString();
  const canonicalJson = canonicalize({
    schemaVersion: 'surface-extension/1',
    id,
    proofId,
    sequence,
    subjectId,
    previousSha256,
    rootManifestSha256,
    recordedAt: at,
    ...facts
  });
  const sha256 = sha256Hex(canonicalJson);
  const signature = (await deps.manifestSigning?.signer?.signManifest({
    proofId,
    manifestId: id,
    canonicalJson,
    sha256
  })) ?? null;
  await tx.query('INSERT INTO surface_extensions(id,proof_id,sequence,subject_id,canonical_json,sha256,previous_sha256,root_manifest_sha256,signature_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)', [id, proofId, sequence, subjectId, canonicalJson, sha256, previousSha256, rootManifestSha256, signature ? JSON.stringify(signature) : null, at]);
}
export async function createIntent(deps: AppDependencies, actor: string, proofId: string, input: unknown) {
  const v = object(input);
  exact(v, ['operation', 'requestDigest']);
  if (!['enrollment', 'observation', 'comparison'].includes(v.operation) || !hash(v.requestDigest)) fail('SURFACE_INVALID_INTENT', 'A command operation and canonical request SHA-256 are required');
  enabled(deps, v.operation === 'comparison' ? 'internalComparison' : 'collection');
  return deps.db.transaction(async tx => {
    await loadProof(tx, proofId, true);
    await access(tx, proofId, actor);
    const attempts = (await tx.query<{
      n: string;
    }>("SELECT COUNT(*) AS n FROM surface_intents WHERE proof_id=$1 AND actor_user_id=$2 AND created_at>$3", [proofId, actor, new Date(deps.clock.now().getTime() - 3600000).toISOString()])).rows[0];
    if (Number(attempts.n) >= 60) fail('SURFACE_RATE_LIMIT', 'Surface request limit reached', 429);
    const id = newId('surface_intent'),
      issued = deps.clock.now(),
      expires = new Date(issued.getTime() + 300000);
    await tx.query('INSERT INTO surface_intents(id,proof_id,actor_user_id,operation,request_sha256,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, proofId, actor, v.operation, v.requestDigest, issued.toISOString(), expires.toISOString()]);
    await appendAudit(tx, {
      proofId,
      actorUserId: actor,
      eventType: 'SURFACE_INTENT_ISSUED',
      eventData: {
        intentId: id,
        operation: v.operation,
        requestDigest: v.requestDigest
      },
      at: issued
    });
    return {
      intentId: id,
      issuedAt: issued.toISOString(),
      expiresAt: expires.toISOString(),
      assurance: 'REQUEST_BOUND_ONLY'
    };
  });
}
export async function source(db: Database, proofId: string, id: string): Promise<SurfaceSource> {
  let row = (await db.query<any>('SELECT id,actor_user_id AS submitted_by,sha256,object_key,object_version_id,content_type,byte_size,capture_session_id FROM surface_media WHERE id=$1 AND proof_id=$2 AND committed_at IS NOT NULL', [id, proofId])).rows[0];
  if (!row) row = (await db.query<any>("SELECT id,submitted_by,sha256,object_key,object_version_id,content_type,byte_size,capture_session_id FROM evidence WHERE id=$1 AND proof_id=$2 AND validation_status='COMMITTED'", [id, proofId])).rows[0];
  if (!row) row = (await db.query<any>('SELECT e.id,s.actor_user_id AS submitted_by,e.sha256,e.object_key,e.object_version_id,e.content_type,e.byte_size,e.capture_session_id FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE e.id=$1 AND s.proof_id=$2 AND e.committed_at IS NOT NULL', [id, proofId])).rows[0];
  if (!row || !hash(row.sha256)) fail('SURFACE_SOURCE_NOT_COMMITTED', 'Source is not committed to this Proof', 409);
  if (!['image/jpeg', 'image/png'].includes(row.content_type) || Number(row.byte_size) > 8388608) fail('SURFACE_SOURCE_UNSUPPORTED', 'Use a bounded original JPEG or PNG image', 422);
  return {
    sourceId: row.id,
    submittedBy: row.submitted_by,
    sha256: row.sha256,
    objectKey: row.object_key,
    objectVersionId: row.object_version_id ?? null,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    captureSessionId: row.capture_session_id ?? null,
    frameTimeMs: null
  };
}
export async function initializeMedia(deps: AppDependencies, actor: string, proofId: string, input: unknown, key: string) {
  enabled(deps, 'collection');
  const v = object(input);
  exact(v, ['captureSessionId', 'contentType', 'byteSize', 'sha256']);
  if (!identifier(key) || !(v.captureSessionId === null || identifier(v.captureSessionId)) || !['image/jpeg', 'image/png'].includes(v.contentType) || !Number.isSafeInteger(v.byteSize) || v.byteSize < 1 || v.byteSize > 8388608 || !hash(v.sha256)) fail('SURFACE_INVALID_MEDIA', 'Provide an idempotency key, bounded image, hash and nullable capture session');
  return deps.db.transaction(async tx => {
    await loadProof(tx, proofId, true);
    await access(tx, proofId, actor);
    await session(tx, proofId, actor, v.captureSessionId);
    const prior = (await tx.query<any>('SELECT * FROM surface_media WHERE proof_id=$1 AND actor_user_id=$2 AND idempotency_key=$3', [proofId, actor, key])).rows[0];
    if (prior && prior.request_sha256 !== digest(v)) fail('SURFACE_IDEMPOTENCY_CONFLICT', 'Idempotency key already records different media', 409);
    let id = prior?.id;
    if (!id) {
      const total = (await tx.query<{
        n: string;
        bytes: string;
      }>('SELECT COUNT(*) AS n,COALESCE(SUM(byte_size),0) AS bytes FROM surface_media WHERE proof_id=$1', [proofId])).rows[0];
      if (Number(total.n) >= 24 || Number(total.bytes) + v.byteSize > 32 * 1024 * 1024) fail('SURFACE_MEDIA_BUDGET', 'Optional surface media budget reached', 429);
      id = newId('surface_media');
      await tx.query('INSERT INTO surface_media(id,proof_id,actor_user_id,capture_session_id,idempotency_key,request_sha256,expected_sha256,byte_size,content_type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, proofId, actor, v.captureSessionId, key, digest(v), v.sha256, v.byteSize, v.contentType, deps.clock.now().toISOString()]);
    }
    return {
      sourceId: id,
      committed: Boolean(prior?.committed_at),
      upload: {
        method: 'PUT',
        url: `${deps.publicBaseUrl}/proofs/${encodeURIComponent(proofId)}/surfaces/media/${id}`,
        headers: {
          'Content-Type': v.contentType
        }
      }
    };
  });
}
export async function commitMedia(deps: AppDependencies, actor: string, proofId: string, id: string, bytes: Buffer) {
  enabled(deps, 'collection');
  return deps.db.transaction(async tx => {
    await loadProof(tx, proofId, true);
    await access(tx, proofId, actor);
    const row = (await tx.query<any>('SELECT * FROM surface_media WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3 FOR UPDATE', [id, proofId, actor])).rows[0];
    if (!row) fail('SURFACE_MEDIA_NOT_FOUND', 'Surface upload not found', 404);
    if (!Buffer.isBuffer(bytes) || bytes.length !== Number(row.byte_size) || sha256Hex(bytes) !== row.expected_sha256) fail('SURFACE_MEDIA_DIGEST_MISMATCH', 'Image bytes do not match the registered commitment', 422);
    if (row.committed_at) return {
      sourceId: id,
      sha256: row.sha256,
      committed: true
    };
    const staging = `evidence/${proofId}/${id}/object`;
    await deps.objectStore.put(staging, bytes, row.content_type);
    const committed = await deps.objectStore.commitUpload(staging, {
      sha256: row.expected_sha256,
      byteSize: Number(row.byte_size),
      contentType: row.content_type,
      maxBytes: 8388608
    });
    if (!committed) fail('SURFACE_SOURCE_UNAVAILABLE', 'Surface upload is unavailable', 409);
    const at = deps.clock.now();
    await tx.query('UPDATE surface_media SET object_key=$2,object_version_id=$3,sha256=$4,committed_at=$5 WHERE id=$1', [id, committed.key, committed.versionId ?? null, committed.sha256, at.toISOString()]);
    await appendExtension(deps, tx, proofId, id, {
      kind: 'source',
      sourceId: id,
      sourceSha256: committed.sha256,
      byteSize: committed.byteSize,
      contentType: committed.contentType
    });
    await appendAudit(tx, {
      proofId,
      actorUserId: actor,
      eventType: 'SURFACE_SOURCE_COMMITTED',
      eventData: {
        sourceId: id,
        sha256: committed.sha256
      },
      at
    });
    return {
      sourceId: id,
      sha256: committed.sha256,
      committed: true
    };
  });
}
function parseCapture(v: Record<string, any>, kind: SurfaceKind): SurfaceCapture {
  exact(v, ['schemaVersion', 'captureSessionId', 'shipmentLegId', 'captureMode', 'contextStage', 'captureProfileId', 'deviceMetadata', 'continuityEvents', 'sources', 'regions', ...(kind === 'observation' ? ['enrollmentId'] : [])]);
  if (v.schemaVersion !== 'surface-command/1' || !(v.captureSessionId === null || identifier(v.captureSessionId)) || !['OUTBOUND', 'RETURN'].includes(v.shipmentLegId) || !['live', 'offline', 'supplemental'].includes(v.captureMode) || !['before_opening', 'during_unpacking', 'after_opening', 'unknown'].includes(v.contextStage) || !identifier(v.captureProfileId) || !Array.isArray(v.sources) || v.sources.length < 1 || v.sources.length > 6 || !Array.isArray(v.regions) || v.regions.length > 24 || !Array.isArray(v.continuityEvents) || v.continuityEvents.length > 100 || Buffer.byteLength(canonicalize(v)) > 65536) fail('SURFACE_INVALID_CAPTURE', 'Unsupported capture schema or bounds');
  object(v.deviceMetadata);
  if (kind === 'enrollment' && !v.captureSessionId) fail('SURFACE_SESSION_REQUIRED', 'Enrollment must retain its ordinary packing capture session');
  if (kind === 'observation' && !identifier(v.enrollmentId)) fail('SURFACE_ENROLLMENT_REQUIRED', 'Choose the expected enrollment');
  const ids = new Set<string>();
  for (const s of v.sources) {
    object(s);
    exact(s, ['sourceId', 'sha256', 'frameTimeMs']);
    if (!identifier(s.sourceId) || !hash(s.sha256) || ids.has(s.sourceId) || !(s.frameTimeMs === null || Number.isFinite(s.frameTimeMs) && s.frameTimeMs >= 0 && s.frameTimeMs <= 86400000)) fail('SURFACE_INVALID_SOURCE', 'Invalid or duplicate source commitment');
    ids.add(s.sourceId);
  }
  const regions = new Set<string>();
  for (const r of v.regions) {
    object(r);
    exact(r, ['id', 'sourceId', 'group', 'polygon', 'process', 'trackId']);
    if (!identifier(r.id) || regions.has(r.id) || !ids.has(r.sourceId) || !['print', 'carton', 'context'].includes(r.group) || !['inkjet', 'laser', 'thermal_transfer', 'direct_thermal', 'substrate', 'unknown'].includes(r.process) || !(r.trackId === null || identifier(r.trackId)) || !Array.isArray(r.polygon) || r.polygon.length !== 4 || r.polygon.some((p: any) => !Array.isArray(p) || p.length !== 2 || p.some((n: any) => !Number.isFinite(n) || n < 0 || n > 32000))) fail('SURFACE_INVALID_REGION', 'Unsupported region map');
    regions.add(r.id);
  }
  return v as SurfaceCapture;
}
export async function recordCommand(deps: AppDependencies, actor: string, proofId: string, kind: SurfaceKind, input: unknown, key: string) {
  enabled(deps, kind === 'comparison' ? 'internalComparison' : 'collection');
  if (!identifier(key)) fail('SURFACE_IDEMPOTENCY_REQUIRED', 'A stable Idempotency-Key is required');
  const all = object(input),
    intentId = all.intentId;
  const v = {
    ...all
  };
  delete v.intentId;
  const requestDigest = digest(v);
  return deps.db.transaction(async tx => {
    await loadProof(tx, proofId, true);
    const role = await access(tx, proofId, actor);
    const prior = (await tx.query<SurfaceRecord>('SELECT * FROM surface_records WHERE proof_id=$1 AND actor_user_id=$2 AND kind=$3 AND idempotency_key=$4', [proofId, actor, kind, key])).rows[0];
    if (prior) {
      if (prior.request_sha256 !== requestDigest) fail('SURFACE_IDEMPOTENCY_CONFLICT', 'This key is bound to another surface request', 409);
      return recordView(tx, prior);
    }
    const intent = (await tx.query<any>('SELECT * FROM surface_intents WHERE id=$1 AND proof_id=$2 AND actor_user_id=$3 FOR UPDATE', [intentId, proofId, actor])).rows[0];
    if (!intent || intent.operation !== kind || intent.request_sha256 !== requestDigest || intent.consumed_record_id || new Date(intent.expires_at).getTime() <= deps.clock.now().getTime()) fail('SURFACE_INTENT_INVALID', 'Request intent is expired, consumed or bound to another command', 409);
    const binding = await scope(tx, proofId);
    let facts: Record<string, any>, enrollment: SurfaceRecord | undefined, observation: SurfaceRecord | undefined, leg: string;
    if (kind === 'comparison') {
      exact(v, ['schemaVersion', 'enrollmentId', 'observationId', 'requestedScope', 'supersedesComparisonId']);
      if (v.schemaVersion !== 'surface-command/1' || !identifier(v.enrollmentId) || !identifier(v.observationId) || !['label', 'carton', 'assembly'].includes(v.requestedScope)) fail('SURFACE_INVALID_COMPARISON', 'Choose enrollment, observation and explicit scope');
      enrollment = await scopedRecord(tx, proofId, v.enrollmentId, 'enrollment');
      observation = await scopedRecord(tx, proofId, v.observationId, 'observation');
      if (observation.enrollment_id !== enrollment.id || observation.shipment_leg_id !== enrollment.shipment_leg_id || observation.package_instance_id !== enrollment.package_instance_id || observation.tenant_scope !== enrollment.tenant_scope) fail('SURFACE_BINDING_MISMATCH', 'Observation is bound to another package or leg', 409);
      if (v.supersedesComparisonId != null) {
        const previous = await scopedRecord(tx, proofId, v.supersedesComparisonId, 'comparison');
        if (previous.enrollment_id !== enrollment.id || previous.observation_id !== observation.id) fail('SURFACE_SUPERSESSION_MISMATCH', 'Reanalysis must reference the same enrolled and observed sources', 409);
      }
      leg = enrollment.shipment_leg_id;
      facts = {
        ...v,
        enrollmentSha256: enrollment.sha256,
        observationSha256: observation.sha256
      };
      const count = (await tx.query<{
        n: string;
      }>("SELECT COUNT(*) AS n FROM surface_records WHERE proof_id=$1 AND kind='comparison'", [proofId])).rows[0];
      if (Number(count.n) >= 20) fail('SURFACE_COMPARISON_LIMIT', 'Experimental comparison limit reached', 429);
    } else {
      const capture = parseCapture(v, kind);
      await session(tx, proofId, actor, capture.captureSessionId);
      leg = capture.shipmentLegId;
      if (kind === 'enrollment') {
        const purpose = (await tx.query<{
          stage_id: string | null;
          stage_type: string | null;
        }>('SELECT c.stage_id,s.stage_type FROM capture_sessions c LEFT JOIN commerce_stages s ON s.id=c.stage_id WHERE c.id=$1', [capture.captureSessionId])).rows[0];
        if (leg === 'OUTBOUND' && purpose.stage_id !== null || leg === 'RETURN' && purpose.stage_type !== 'RETURN_PACKING') fail('SURFACE_LEG_SESSION_MISMATCH', 'Enrollment session must belong to the declared shipping leg', 409);
      }
      if (kind === 'enrollment' && (leg === 'OUTBOUND' && role !== 'SELLER' || leg === 'RETURN' && role !== 'BUYER')) fail('SURFACE_ENROLLMENT_NOT_AUTHORIZED', 'Only the sender for this leg may enroll', 403);
      if (kind === 'observation') {
        enrollment = await scopedRecord(tx, proofId, capture.enrollmentId!, 'enrollment');
        if (enrollment.shipment_leg_id !== leg || enrollment.package_instance_id !== binding.packageInstanceId || enrollment.tenant_scope !== binding.tenantScope) fail('SURFACE_BINDING_MISMATCH', 'Enrollment belongs to another package or leg', 409);
      }
      if (kind === 'enrollment' && (await tx.query("SELECT id FROM surface_records WHERE proof_id=$1 AND kind='enrollment' AND shipment_leg_id=$2", [proofId, leg])).rows[0]) fail('SURFACE_ENROLLMENT_LOCKED', 'This leg already has an immutable baseline', 409);
      const sources: SurfaceSource[] = [];
      for (const requested of capture.sources) {
        const original = await source(tx, proofId, requested.sourceId);
        if (original.submittedBy !== actor) fail('SURFACE_SOURCE_ACTOR_MISMATCH', 'A capture must use originals uploaded by its attributed actor', 403);
        if (kind === 'observation' && (JSON.parse(enrollment!.canonical_json).sourceDigests as SurfaceSource[]).some(s => s.sha256 === original.sha256)) fail('SURFACE_SOURCE_REPLAY', 'Observation must contain newly captured originals, not enrolled image bytes', 409);
        if (original.sha256 !== requested.sha256) fail('SURFACE_SOURCE_DIGEST_MISMATCH', 'Source commitment does not match stored bytes', 409);
        if (original.captureSessionId !== null && original.captureSessionId !== capture.captureSessionId) fail('SURFACE_SESSION_MISMATCH', 'Source belongs to another capture session', 409);
        sources.push({
          ...original,
          frameTimeMs: requested.frameTimeMs
        });
      }
      if (sources.reduce((n, s) => n + s.byteSize, 0) > 8388608) fail('SURFACE_MEDIA_BUDGET', 'A capture may retain at most 8 MiB selected originals', 422);
      let contextualVideoCommitment: Record<string, unknown> = {
        status: 'UNAVAILABLE',
        captureSessionId: capture.captureSessionId
      };
      if (capture.captureSessionId) {
        const video = (await tx.query<{
          id: string;
          sha256: string;
          object_version_id: string | null;
        }>(`SELECT id,sha256,object_version_id FROM evidence WHERE proof_id=$1 AND capture_session_id=$2 AND validation_status='COMMITTED'
          UNION ALL SELECT e.id,e.sha256,e.object_version_id FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id WHERE s.proof_id=$1 AND e.capture_session_id=$2 AND e.committed_at IS NOT NULL`, [proofId, capture.captureSessionId])).rows[0];
        if (video) contextualVideoCommitment = {
          status: 'SERVER_COMMITTED',
          captureSessionId: capture.captureSessionId,
          evidenceId: video.id,
          sha256: video.sha256,
          objectVersionId: video.object_version_id
        };
      }
      facts = {
        ...capture,
        contextualVideoCommitment,
        sourceDigests: sources,
        regionMap: capture.regions,
        requiredGroups: ['print', 'carton', 'context'],
        assurance: 'UNVERIFIED',
        captureTimeAssurance: capture.captureMode === 'offline' ? 'OFFLINE_DEVICE_REPORTED' : 'PARTICIPANT_REPORTED',
        platformAssurance: 'NOT_VERIFIED',
        contextStageAssurance: 'PARTICIPANT_REPORTED',
        enrollmentSha256: enrollment?.sha256 ?? null
      };
    }
    const method = await surfaceMethodPin(config(deps));
    const id = newId(`surface_${kind}`),
      at = deps.clock.now().toISOString();
    const canonicalJson = canonicalize({
      ...facts,
      id,
      proofId,
      kind,
      actorUserId: actor,
      actorRole: role,
      tenantScope: binding.tenantScope,
      packageInstanceId: binding.packageInstanceId,
      shipmentLegId: leg,
      createdAt: at,
      receivedAt: at,
      intentIssuedAt: new Date(intent.created_at).toISOString(),
      method,
      qualification: 'unqualified'
    });
    const sha256 = sha256Hex(canonicalJson);
    await tx.query('INSERT INTO surface_records(id,proof_id,tenant_scope,actor_user_id,kind,package_instance_id,shipment_leg_id,enrollment_id,observation_id,idempotency_key,request_sha256,canonical_json,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [id, proofId, binding.tenantScope, actor, kind, binding.packageInstanceId, leg, enrollment?.id ?? null, observation?.id ?? null, key, requestDigest, canonicalJson, sha256, at]);
    await tx.query('UPDATE surface_intents SET consumed_record_id=$2 WHERE id=$1', [intentId, id]);
    const jobId = newId('surface_job');
    await tx.query("INSERT INTO surface_jobs(id,proof_id,record_id,operation,identity_sha256,status,available_at,created_at) VALUES($1,$2,$3,$4,$5,'queued',$6,$6)", [jobId, proofId, id, kind === 'comparison' ? 'compare' : 'extract', digest({
      recordSha256: sha256,
      method
    }), at]);
    await appendExtension(deps, tx, proofId, id, {
      kind,
      recordId: id,
      recordSha256: sha256
    });
    await appendAudit(tx, {
      proofId,
      actorUserId: actor,
      eventType: 'SURFACE_RECORD_COMMITTED',
      eventData: {
        recordId: id,
        kind,
        sha256,
        jobId
      },
      at: deps.clock.now()
    });
    return recordView(tx, (await tx.query<SurfaceRecord>('SELECT * FROM surface_records WHERE id=$1', [id])).rows[0]);
  });
}
export async function scopedRecord(db: Database, proofId: string, id: string, kind?: SurfaceKind) {
  const record = (await db.query<SurfaceRecord>('SELECT * FROM surface_records WHERE proof_id=$1 AND id=$2', [proofId, id])).rows[0];
  if (!record || kind && record.kind !== kind) fail('SURFACE_RECORD_NOT_FOUND', 'Surface record not found on this Proof', 404);
  return record;
}
export async function recordView(db: Database, row: SurfaceRecord) {
  const facts = JSON.parse(row.canonical_json);
  const job = (await db.query<any>('SELECT id,status,error_code FROM surface_jobs WHERE record_id=$1', [row.id])).rows[0];
  const analysis = (await db.query<any>('SELECT canonical_json,sha256 FROM surface_analyses WHERE record_id=$1', [row.id])).rows[0];
  const result = analysis ? JSON.parse(analysis.canonical_json).result : null;
  const sources = (facts.sourceDigests ?? []).map(({
    objectKey: _,
    ...s
  }: any) => ({
    ...s,
    availability: 'not_checked'
  }));
  delete facts.sources;
  return {
    ...facts,
    sourceDigests: sources,
    sha256: row.sha256,
    jobId: job?.id ?? null,
    state: analysis ? 'unavailable' : 'analysis_pending',
    status: analysis ? result.status : job?.status === 'queued' ? 'requested' : job?.status ?? 'not_checked',
    errorCode: job?.error_code ?? null,
    result,
    analysisSha256: analysis?.sha256 ?? null
  };
}
export async function surfaceSummary(deps: AppDependencies, actor: string, proofId: string) {
  await access(deps.db, proofId, actor);
  const rows = (await deps.db.query<SurfaceRecord>('SELECT * FROM surface_records WHERE proof_id=$1 ORDER BY created_at,id', [proofId])).rows;
  const views = await Promise.all(rows.map(row => recordView(deps.db, row)));
  return {
    schemaVersion: 'surface-api/1',
    experimental: true,
    capabilities: surfaceCapabilities(config(deps)),
    enrollments: views.filter(v => v.kind === 'enrollment'),
    observations: views.filter(v => v.kind === 'observation'),
    comparisons: views.filter(v => v.kind === 'comparison')
  };
}
export async function surfaceExport(deps: AppDependencies, actor: string, proofId: string) {
  return deps.db.transaction(async tx => {
    await loadProof(tx, proofId, true);
    return surfaceExportSnapshot({
      ...deps,
      db: tx
    }, actor, proofId);
  });
}
async function surfaceExportSnapshot(deps: AppDependencies, actor: string, proofId: string) {
  await access(deps.db, proofId, actor);
  const root = (await deps.db.query<{
    canonical_json: string;
    sha256: string;
  }>('SELECT canonical_json,sha256 FROM final_manifests WHERE proof_id=$1', [proofId])).rows[0];
  const rows = (await deps.db.query<SurfaceRecord>('SELECT * FROM surface_records WHERE proof_id=$1 ORDER BY created_at,id', [proofId])).rows;
  const sourceMap = new Map<string, SurfaceSource>();
  for (const row of rows) for (const s of JSON.parse(row.canonical_json).sourceDigests ?? []) sourceMap.set(s.sourceId, s);
  for (const m of (await deps.db.query<{
    id: string;
  }>('SELECT id FROM surface_media WHERE proof_id=$1 AND committed_at IS NOT NULL', [proofId])).rows) if (!sourceMap.has(m.id)) sourceMap.set(m.id, await source(deps.db, proofId, m.id));
  const sources = [];
  for (const s of sourceMap.values()) {
    const metadata = await deps.objectStore.head?.(s.objectKey, {
      versionId: s.objectVersionId
    });
    const {
      objectKey: _,
      ...publicSource
    } = s;
    sources.push({
      ...publicSource,
      availability: deps.objectStore.head ? metadata ? 'available' : 'expired' : 'not_checked',
      mediaPath: null
    });
  }
  const extensions = (await deps.db.query<any>('SELECT * FROM surface_extensions WHERE proof_id=$1 ORDER BY sequence', [proofId])).rows.map(e => ({
    id: e.id,
    sequence: e.sequence,
    canonicalJson: e.canonical_json,
    sha256: e.sha256,
    previousSha256: e.previous_sha256,
    rootManifestSha256: e.root_manifest_sha256,
    signature: e.signature_json
  }));
  const analyses = (await deps.db.query<any>('SELECT id,canonical_json,sha256 FROM surface_analyses WHERE proof_id=$1 ORDER BY created_at,id', [proofId])).rows.map(a => ({
    id: a.id,
    canonicalJson: a.canonical_json,
    sha256: a.sha256,
    signature: null
  }));
  await appendAudit(deps.db, {
    proofId,
    actorUserId: actor,
    eventType: 'SURFACE_EXPORT_READ',
    eventData: {
      recordCount: rows.length,
      analysisCount: analyses.length
    },
    at: deps.clock.now()
  });
  return {
    schemaVersion: 'surface-export/1',
    proofId,
    exportedAt: deps.clock.now().toISOString(),
    root: root ? {
      canonicalJson: root.canonical_json,
      sha256: root.sha256
    } : null,
    records: rows.map(r => ({
      kind: r.kind,
      id: r.id,
      canonicalJson: r.canonical_json,
      sha256: r.sha256
    })),
    extensions,
    sources,
    analyses,
    limitations: ['Experimental, unqualified physical inference.', 'Original bytes are not embedded; mediaPath null means digest commitment only. Download each authorized original separately to replay.', 'Private templates and raw scores are withheld; artifact commitments are retained.', 'Unsigned extensions establish byte consistency only; no server signature is claimed.', 'Capture times, scene truth, closure and contents are not authenticated.', 'Snapshot completeness beyond the included extension head is unknown.']
  };
}
