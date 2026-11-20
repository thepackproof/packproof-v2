import type { Database } from '../db/database.js';
import { attachMedia, affectedMediaReferences } from './order-artifact.js';
import type { Clock } from '../clock.js';
import type { AppDependencies } from '../app.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { strictBody, type PartnerActor } from '../platform/organizations.js';
import { importPartnerOrder } from '../platform/partner-proofs.js';
import { appendAudit } from '../domain/audit.js';
import type { Installation } from './agent-enrollments.js';
import { activeScope, boundedText, digest, positive, installationOperation } from './order-workspace.js';
import { normalizedRecord, refKey, projectOrders, type Root, type StoredEvent, type OrderRecord } from './order-projection.js';
type Deps = Pick<AppDependencies, 'db' | 'clock' | 'objectStore' | 'devAuth'>;
interface Origin {
  organization: string;
  environment: 'sandbox' | 'live';
  operator: string;
  location: string | null;
  account: string;
  operation: string;
}
export function originFor(i: Installation): Origin {
  return {
    organization: i.organization_id,
    environment: i.environment,
    operator: i.operator_membership_id,
    location: i.location_id,
    account: i.integration_account_id,
    operation: installationOperation(i)
  };
}
export async function lockOperation(db: Database, operation: string) {
  await db.query('SELECT pg_advisory_xact_lock(1347438181,hashtext($1))', [operation]);
}
export async function preserveOrderOriginal(deps: Deps, organization: string, sha: string, bytes: Buffer, mediaType: string) {
  const key = `evidence/${organization}/order-originals/committed/sha256-${sha}`;
  if (!deps.objectStore.putIfAbsent) throw new DomainError('IMPORT_ORIGINAL_UNVERIFIED', 'Immutable original storage is unavailable.', 503);
  await deps.objectStore.putIfAbsent(key, bytes, mediaType);
  const found = await deps.objectStore.digest(key);
  if (!found || found.sha256 !== sha || found.byteSize !== bytes.length || !found.versionId || !deps.devAuth && found.versionId === 'null') throw new DomainError('IMPORT_ORIGINAL_UNVERIFIED', 'The stored original could not be verified. Retain the local copy and retry.', 503);
  return {
    key,
    version: found.versionId
  };
}
function capture(input: unknown) {
  const b = strictBody(input, ['scopeDigest', 'sourceId', 'generation', 'profileVersion', 'observationId', 'fileName', 'mediaType', 'originalSha256', 'originalBase64', 'records', 'issues', 'firstSeenAt']);
  const firstSeenAt = b.firstSeenAt == null ? null : boundedText(b.firstSeenAt, 'collector first-seen time', 64);
  if (firstSeenAt && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)$/.test(firstSeenAt) || !Number.isFinite(Date.parse(firstSeenAt))))
    throw new DomainError('INVALID_REQUEST', 'The collector first-seen time needs an explicit time zone.', 400);
  if (typeof b.originalBase64 !== 'string' || b.originalBase64.length > 4 * 1024 * 1024 || !Array.isArray(b.records) || b.records.length > 512) throw new DomainError('SOURCE_LIMIT', 'Use a bounded source file and record batch.', 413);
  const bytes = Buffer.from(b.originalBase64, 'base64'),
    sha = digest(b.originalSha256);
  if (bytes.toString('base64') !== b.originalBase64 || sha256Hex(bytes) !== sha) throw new DomainError('ORIGINAL_HASH_MISMATCH', 'The original bytes do not match their checksum.', 422);
  const fileName = boundedText(b.fileName, 'file name', 255);
  if (/[\\/]/.test(fileName)) throw new DomainError('INVALID_REQUEST', 'Provide the original base name.', 400);
  if (b.issues != null && (!Array.isArray(b.issues) || b.issues.length > 64)) throw new DomainError('INVALID_REQUEST', 'Use bounded source issues.', 400);
  const issues = (b.issues ?? []) as unknown[];
  return {
    scopeDigest: digest(b.scopeDigest),
    sourceId: boundedText(b.sourceId, 'source'),
    generation: positive(b.generation),
    profileVersion: boundedText(b.profileVersion, 'profile'),
    observationId: boundedText(b.observationId, 'observation'),
    fileName,
    mediaType: boundedText(b.mediaType, 'media type', 128),
    sha,
    bytes,
    firstSeenAt,
    records: b.records.map(normalizedRecord),
    issues: issues.map(s => boundedText(s, 'issue', 512))
  };
}
export async function ensureOrderRoot(db: Database, clock: Clock, a: PartnerActor, o: Origin, sourceId: string, event: OrderRecord, existingProofId?: string, native = false) {
  if (event.kind !== 'order' || event.entity.type !== 'order') return;
  const key = refKey(event.entity),
    found = (await db.query<Root>('SELECT * FROM record_order_roots WHERE operation_key=$1 AND root_key=$2', [o.operation, key])).rows[0];
  if (found) {
    if (found.source_id !== sourceId) throw new DomainError('PROFILE_AMBIGUOUS', 'Two origin sources claim this order namespace. Review their source identities.', 409);
    return;
  }
  const externalId = native ? event.entity.id : 'connect-order-' + sha256Hex(canonicalize([o.operation, event.entity]));
  const proofId = existingProofId ?? (await importPartnerOrder(db, clock, a, {
    integrationAccountId: o.account,
    operatorMembershipId: o.operator,
    externalId,
    transaction: {
      itemTitle: `Order ${event.entity.id}`.slice(0, 200)
    }
  })).proofId;
  await db.query(`INSERT INTO record_order_roots(proof_id,operation_key,root_key,source_id,organization_id,environment,operator_membership_id,location_id,order_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [proofId, o.operation, key, sourceId, o.organization, o.environment, o.operator, o.location, event.entity.id]);
  await db.query(`INSERT INTO record_state(proof_id,organization_id,environment,reference,location_id,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [proofId, o.organization, o.environment, event.entity.id, o.location, clock.now().toISOString()]);
}
export async function insertOrderEvent(db: Database, operation: string, source: string, receipt: string, record: OrderRecord) {
  const id = newId('order_event'),
    signature = sha256Hex(canonicalize({
      ...record,
      locator: undefined,
      fieldLineage: undefined
    }));
  const inserted = (await db.query<{
    id: string;
  }>('INSERT INTO record_order_events(id,operation_key,source_id,event_id,source_version,receipt_id,payload_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING RETURNING id', [id, operation, source, record.eventId, record.version, receipt, signature, JSON.stringify(record)])).rows[0];
  if (!inserted) {
    const old = (await db.query<{
      id: string;
      payload_digest: string;
    }>('SELECT id,payload_digest FROM record_order_events WHERE operation_key=$1 AND source_id=$2 AND event_id=$3 AND source_version=$4', [operation, source, record.eventId, record.version])).rows[0];
    if (old.payload_digest !== signature) {
      // Keep both independently captured claims. A conflicting version must never
      // change the canonical record until a reviewer resolves its identity.
      const held = 'order_conflict_' + sha256Hex(canonicalize([operation, source, receipt, record.eventId, record.version, signature]));
      await db.query('INSERT INTO record_order_events(id,operation_key,source_id,event_id,source_version,receipt_id,payload_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING', [held, operation, source, '@conflict:' + held, record.version, receipt, signature, JSON.stringify(record)]);
      await db.query('INSERT INTO record_order_link_state(event_id,operation_key,proof_ids,unresolved,updated_at) SELECT $1,$2,ARRAY[]::text[],true,received_at FROM record_order_receipts WHERE id=$3 ON CONFLICT DO NOTHING', [held, operation, receipt]);
      return held;
    }
    return old.id;
  }
  const refs = [record.entity, ...record.references].map(refKey);
  await db.query('INSERT INTO record_order_event_refs(operation_key,ref_key,event_id) SELECT $1,k,$3 FROM unnest($2::text[]) k ON CONFLICT DO NOTHING', [operation, refs, id]);
  return id;
}
/** Indexed, bounded expansion around changed identities, including other versions
 * of the same event so a corrected link also revises its previous order. */
export async function orderComponent(db: Database, operation: string, initialKeys: string[]) {
  const keys = new Set<string>(),
    seen = new Map<string, StoredEvent>();
  let frontier = [...new Set(initialKeys)];
  while (frontier.length) {
    for (const k of frontier) keys.add(k);
    const rows = (await db.query<StoredEvent>(`WITH touched AS (
    SELECT DISTINCT e.source_id,e.event_id FROM record_order_event_refs x JOIN record_order_events e ON e.id=x.event_id
    WHERE x.operation_key=$1 AND x.ref_key=ANY($2::text[])
    UNION SELECT e.source_id,e.event_id FROM record_order_roots root JOIN record_order_decisions d ON d.proof_id=root.proof_id
    JOIN record_order_events e ON e.id=d.event_id WHERE root.operation_key=$1 AND root.root_key=ANY($2::text[])
   ) SELECT e.id,e.source_id,e.record,e.receipt_id,r.original_sha256,r.file_name,r.profile_version,r.received_at,r.first_seen_at,
     d.id decision_id,d.proof_id decision_proof,ARRAY(SELECT root.root_key FROM record_order_decisions previous JOIN record_order_roots root ON root.proof_id=previous.proof_id WHERE previous.event_id=e.id) decision_keys FROM touched t JOIN record_order_events e ON e.operation_key=$1 AND e.source_id=t.source_id AND e.event_id=t.event_id
     JOIN record_order_receipts r ON r.id=e.receipt_id LEFT JOIN LATERAL (SELECT id,proof_id FROM record_order_decisions d
     WHERE d.event_id=e.id AND NOT EXISTS(SELECT 1 FROM record_order_decisions x WHERE x.supersedes_id=d.id) LIMIT 1) d ON true LIMIT 4001`, [operation, frontier])).rows;
    if (rows.length > 4000) throw new DomainError('SOURCE_LIMIT', 'This linked order group requires a larger review or a more specific identifier.', 422);
    const next = new Set<string>();
    for (const e of rows) {
      if (seen.has(e.id)) continue;
      const d = e as StoredEvent & {
        decision_id: string | null;
        decision_proof: string | null;
        decision_keys: string[];
      };
      for (const key of d.decision_keys) if (!keys.has(key)) next.add(key);
      if (d.decision_id) e.override = d.decision_proof;
      seen.set(e.id, e);
      for (const ref of [e.record.entity, ...e.record.references]) {
        const k = refKey(ref);
        if (!keys.has(k)) next.add(k);
      }
    }
    if (seen.size > 4000) throw new DomainError('SOURCE_LIMIT', 'This linked group exceeds the bounded projection size.', 422);
    frontier = [...next];
  }
  const roots = (await db.query<Root>('SELECT proof_id,source_id,root_key,order_reference FROM record_order_roots WHERE operation_key=$1 AND root_key=ANY($2::text[])', [operation, [...keys]])).rows;
  return {
    roots,
    events: [...seen.values()]
  };
}
export async function publish(db: Database, clock: Clock, operation: string, projection: ReturnType<typeof projectOrders>['projections'][number], actorId: string) {
  const proof = await attachMedia(db, operation, projection);
  const content = sha256Hex(canonicalize(proof)),
    prior = (await db.query<{
      content_digest: string;
      revision: number;
    }>('SELECT revision,content_digest FROM record_order_revisions WHERE proof_id=$1 ORDER BY revision DESC LIMIT 1', [proof.proofId])).rows[0];
  if (prior?.content_digest === content) return {
    proofId: proof.proofId,
    revision: prior.revision
  };
  // All publishers acquire this last lock and retain it until commit. Sequence
  // allocation order is therefore commit order even across concurrent operations.
  await db.query('SELECT pg_advisory_xact_lock(1347438181,0)');
  const revision = (prior?.revision ?? 0) + 1,
    updatedAt = clock.now().toISOString(),
    view = {
      ...proof,
      revision,
      updatedAt,
      integrity: 'source_reported'
    };
  await db.query('INSERT INTO record_order_revisions(proof_id,revision,committed_at,view,content_digest) VALUES($1,$2,$3,$4::jsonb,$5)', [proof.proofId, revision, updatedAt, JSON.stringify(view), content]);
  const audit = await appendAudit(db, {
    proofId: proof.proofId,
    actorUserId: actorId,
    eventType: 'ORDER_PROOF_REVISION_COMMITTED',
    eventData: {
      revision,
      contentSha256: content
    },
    at: clock.now()
  });
  await db.query('INSERT INTO proof_outbox(id,proof_id,audit_id,event_type,created_at) VALUES($1,$2,$3,$4,$5)', [audit + ':record.updated', proof.proofId, audit, 'record.updated', updatedAt]);
  await db.query('UPDATE record_state SET revision=revision+1,updated_at=$2 WHERE proof_id=$1', [proof.proofId, updatedAt]);
  return {
    proofId: proof.proofId,
    revision
  };
}
export async function commitOrderGroup(db: Database, clock: Clock, operation: string, group: Awaited<ReturnType<typeof orderComponent>>, actorId: string) {
  const {
      projections,
      members
    } = projectOrders(group.events, group.roots),
    proofs = [];
  for (const e of group.events) {
    const ids = members.get(e.id) ?? [];
    await db.query(`INSERT INTO record_order_link_state(event_id,operation_key,proof_ids,unresolved,updated_at) VALUES($1,$2,$3::text[],$4,$5)
    ON CONFLICT(event_id) DO UPDATE SET proof_ids=EXCLUDED.proof_ids,unresolved=EXCLUDED.unresolved,updated_at=EXCLUDED.updated_at
    WHERE record_order_link_state.proof_ids IS DISTINCT FROM EXCLUDED.proof_ids OR record_order_link_state.unresolved<>EXCLUDED.unresolved`, [e.id, operation, ids, !ids.length, clock.now().toISOString()]);
  }
  for (const proof of projections) proofs.push(await publish(db, clock, operation, proof, actorId));
  return {
    members,
    proofs
  };
}
export async function ingestOrderFile(deps: Deps, db: Database, a: PartnerActor, i: Installation, input: unknown, transport: 'folder' | 'api' = 'folder') {
  const x = capture(input),
    session = await activeScope(db, i, x.scopeDigest),
    o = originFor(i);
  const source = session.scope.sources.find(s => s.id === x.sourceId && s.generation === x.generation && s.profileVersion === x.profileVersion);
  if (!source || source.transport !== transport) throw new DomainError('AUTH_REQUIRED', 'Approve this source generation and profile before sending records.', 403);
  if (transport === 'api' && x.records.some(r => r.entity.type === 'order' && r.entity.namespace !== source.sourceNamespace)) throw new DomainError('AUTH_REQUIRED', 'Use the namespace approved for this API order source.', 403);
  const facilities = [...new Set(x.records.map(r => r.facilityId).filter((id): id is string => !!id))];
  if (facilities.length) {
    if (i.location_id && facilities.some(id => id !== i.location_id)) throw new DomainError('LOCATION_NOT_AUTHORIZED', 'This computer is authorized for a different facility.', 403);
    const available = await db.query(`SELECT l.id FROM record_locations l JOIN platform_memberships m ON m.id=$2 AND m.organization_id=l.organization_id
   WHERE l.organization_id=$1 AND l.id=ANY($3::text[]) AND m.revoked_at IS NULL
   AND (NOT m.location_scoped OR EXISTS(SELECT 1 FROM record_membership_locations g WHERE g.membership_id=m.id AND g.organization_id=m.organization_id AND g.location_id=l.id)) FOR SHARE OF l,m`, [i.organization_id, i.operator_membership_id, facilities]);
    if (available.rows.length !== facilities.length) throw new DomainError('LOCATION_NOT_AUTHORIZED', 'One or more facilities are outside this operation.', 403);
  }
  // A location-bound grant supplies the facility when its source did not report one.
  for (const record of x.records) record.facilityId ??= i.location_id;
  const role: Record<string, string> = {
    order: 'order',
    picking: 'picking',
    packing: 'packing',
    label: 'shipping',
    handoff: 'handoff',
    delivery: 'delivery',
    return: 'returns'
  };
  if (x.records.some(r => role[r.kind] && !source.roles.includes(role[r.kind]) || r.kind === 'evidence' && !source.roles.some(v => ['packing', 'evidence', 'shipping', 'handoff', 'delivery', 'returns'].includes(v)))) throw new DomainError('AUTH_REQUIRED', 'This source role is outside the approved scope.', 403);
  await lockOperation(db, o.operation);
  const hash = sha256Hex(canonicalize({
    source: x.sourceId,
    generation: x.generation,
    profile: x.profileVersion,
    original: x.sha,
    file: x.fileName,
    media: x.mediaType,
    records: x.records,
    issues: x.issues
  }));
  const old = (await db.query<{
    id: string;
    payload_digest: string;
  }>('SELECT id,payload_digest FROM record_order_receipts WHERE operation_key=$1 AND source_id=$2 AND generation=$3 AND observation_id=$4', [o.operation, x.sourceId, x.generation, x.observationId])).rows[0];
  if (old && old.payload_digest !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This observation identity was already used for different content.', 409);
  const receiptId = old?.id ?? newId('order_receipt');
  if (!old) {
    const stored = await preserveOrderOriginal(deps, o.organization, x.sha, x.bytes, x.mediaType);
    await db.query(`INSERT INTO record_order_receipts(id,operation_key,source_id,generation,observation_id,payload_digest,original_sha256,object_key,object_version,file_name,media_type,profile_version,issues,received_at,session_id,first_seen_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`, [receiptId, o.operation, x.sourceId, x.generation, x.observationId, hash, x.sha, stored.key, stored.version, x.fileName, x.mediaType, x.profileVersion, JSON.stringify(x.issues), deps.clock.now().toISOString(), session.id, x.firstSeenAt]);
  }
  const ids: string[] = [];
  for (const r of x.records) {
    const id = await insertOrderEvent(db, o.operation, x.sourceId, receiptId, r);
    ids.push(id);
    if (!id.startsWith('order_conflict_')) await ensureOrderRoot(db, deps.clock, a, o, x.sourceId, r, undefined, transport === 'api');
  }
  const mediaKeys = await affectedMediaReferences(db, o.operation, x.sourceId, x.sha);
  const group = await orderComponent(db, o.operation, [...mediaKeys, ...x.records.flatMap(r => [r.entity, ...r.references].map(refKey))]);
  const {
    members,
    proofs
  } = await commitOrderGroup(db, deps.clock, o.operation, group, a.actorUserId);
  const pending = x.issues.length > 0 || !ids.length && !proofs.length || ids.some(id => !members.get(id)?.length);
  return {
    receiptId,
    state: pending ? 'pending' : 'accepted',
    proofs,
    originalSha256: x.sha,
    issues: x.issues,
    ...(ids.some(id => id.startsWith('order_conflict_')) ? {
      code: 'REVISION_CONFLICT'
    } : {})
  };
}
