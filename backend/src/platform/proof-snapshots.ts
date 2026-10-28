import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import type { ProofStatus } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import { createEventStreamCursor, type EventStreamConfig } from './event-stream.js';
import { auditOrganization, authorizePartnerProof, reauthorizePartner, strictBody, type PartnerActor } from './organizations.js';

const LIFETIME_MS = 60 * 60 * 1000;
const MAX_ROWS = 10000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_ROW_BYTES = 256 * 1024;
const MAX_BINDINGS = 20000;
const MAX_BINDINGS_PER_PROOF = 256;
const MAX_ACTIVE_PER_CREDENTIAL = 4;
export interface ProofStateSnapshotRow {
  schemaVersion: 'packproof.proof-state-summary/v1';
  proofId: string;
  transactionId: string;
  status: ProofStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  manifestSha256: string | null;
  externalBindings: Array<{ integrationAccountId: string; resourceType: string; externalId: string }>;
}
interface SnapshotHeader {
  id: string;
  boundary_position: string;
  event_cursor: string;
  page_size: number;
  row_count: number;
  created_at: Date | string;
  expires_at: Date | string;
}
interface PageCursor {
  v: 1;
  kind: 'proof-snapshot-page';
  snapshotId: string;
  tenantId: string;
  merchantId: string;
  environment: string;
  principalId: string;
  credentialId: string;
  delegationId: string | null;
  offset: number;
  pageSize: number;
  expiresAt: number;
}
function key(config: EventStreamConfig): Buffer {
  const bytes = Buffer.from(config.signingKey, 'base64');
  if (bytes.length !== 32) throw new DomainError('CURSOR_SIGNING_UNAVAILABLE', 'Cursor signing is not configured', 503);
  return bytes;
}
function signature(body: string, config: EventStreamConfig): Buffer {
  return createHmac('sha256', key(config)).update('proof-snapshot/v1:').update(body).digest();
}
function invalid(): never {
  throw new DomainError('INVALID_CURSOR', 'Use the page cursor issued for this snapshot and current credential', 400);
}
function expired(): never {
  throw new DomainError('SNAPSHOT_EXPIRED', 'Create a new Proof snapshot, reconcile its rows, then consume its eventCursor', 410);
}
function encode(cursor: PageCursor, config: EventStreamConfig): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return body + '.' + signature(body, config).toString('base64url');
}
function decode(value: unknown, actor: PartnerActor, header: SnapshotHeader, config: EventStreamConfig): PageCursor {
  if (typeof value !== 'string' || value.length > 2048) return invalid();
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return invalid();
  const actual = Buffer.from(parts[1], 'base64url'), expected = signature(parts[0], config);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid();
  let c: PageCursor;
  try { c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return invalid(); }
  if (!c || c.v !== 1 || c.kind !== 'proof-snapshot-page' || c.snapshotId !== header.id ||
    c.tenantId !== actor.tenantId || c.merchantId !== actor.merchantId || c.environment !== actor.environment ||
    c.principalId !== actor.principalId || c.credentialId !== actor.credentialId || c.delegationId !== actor.delegationGrantId ||
    c.pageSize !== header.page_size || c.expiresAt !== new Date(header.expires_at).getTime() ||
    !Number.isInteger(c.offset) || c.offset < 0 || c.offset > header.row_count) return invalid();
  return c;
}
async function authorize(db: Database, clock: Clock, actor: PartnerActor) {
  await reauthorizePartner(db, clock, actor, 'proofs:read');
  await reauthorizePartner(db, clock, actor, 'events:read');
}
function metadata(actor: PartnerActor, h: SnapshotHeader) {
  return {
    schemaVersion: 'packproof.proof-snapshot/v1' as const,
    rowSchema: 'packproof.proof-state-summary/v1' as const,
    snapshotId: h.id,
    merchantId: actor.merchantId,
    environment: actor.environment,
    rowCount: h.row_count,
    pageSize: h.page_size,
    createdAt: new Date(h.created_at).toISOString(),
    expiresAt: new Date(h.expires_at).toISOString(),
    eventCursor: h.event_cursor,
  };
}
async function checkBoundary(db: Database, actor: PartnerActor, h: SnapshotHeader) {
  const head = (await db.query<{ position: string; floor_position: string }>(
    'SELECT position::text,floor_position::text FROM api_event_stream_heads WHERE tenant_id=$1', [actor.tenantId])).rows[0];
  if (BigInt(h.boundary_position) < BigInt(head?.floor_position ?? '0') ||
    BigInt(h.boundary_position) > BigInt(head?.position ?? '0')) return expired();
}
function serializationFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    ['40001', '40P01'].includes(String(error.code));
}

/** Call with the root Database, not from an outer idempotency transaction:
 * SET TRANSACTION must precede every query. These disposable read projections
 * never mutate a Proof; retrying creation may create another bounded snapshot.
 * Every relevant source mutation must emit its existing outbox event atomically.
 */
export async function createPartnerProofSnapshot(db: Database, clock: Clock, actor: PartnerActor,
  config: EventStreamConfig, input: unknown = {}) {
  key(config);
  const body = strictBody(input, ['pageSize']);
  const pageSize = body.pageSize ?? 50;
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw new DomainError('INVALID_LIMIT', 'pageSize must be an integer from 1 to 100', 400);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const header = await db.transaction(async tx => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await tx.query("SET LOCAL statement_timeout = '15s'");
        await tx.query("SET LOCAL lock_timeout = '5s'");
        await authorize(tx, clock, actor);
        const createdAt = clock.now(), expiresAt = new Date(createdAt.getTime() + LIFETIME_MS);
        // Cleanup touches only this credential's expired, disposable snapshots.
        await tx.query('DELETE FROM api_proof_snapshots WHERE credential_id=$1 AND expires_at<=$2',
          [actor.credentialId, createdAt.toISOString()]);
        const slot = (await tx.query<{ slot: number }>(
          'SELECT n AS slot FROM generate_series(1,$2::integer) AS n WHERE NOT EXISTS (SELECT 1 FROM api_proof_snapshots s WHERE s.credential_id=$1 AND s.slot=n) ORDER BY n LIMIT 1',
          [actor.credentialId, MAX_ACTIVE_PER_CREDENTIAL])).rows[0]?.slot;
        if (slot == null) throw new DomainError('SNAPSHOT_LIMIT', 'Release or wait for an existing snapshot to expire before creating another', 429);
        const highWater = (await tx.query<{ position: string }>(
          'SELECT position::text FROM api_event_stream_heads WHERE tenant_id=$1', [actor.tenantId])).rows[0]?.position ?? '0';
        const count = (await tx.query<{ count: number }>(
          'SELECT COUNT(*)::integer AS count FROM (SELECT 1 FROM platform_proof_ownership WHERE merchant_id=$1 AND environment=$2 LIMIT $3) AS bounded',
          [actor.merchantId, actor.environment, MAX_ROWS + 1])).rows[0].count;
        if (count > MAX_ROWS) throw new DomainError('SNAPSHOT_TOO_LARGE', 'This pilot snapshot supports at most 10000 Proofs; request a reviewed larger reconciliation budget', 413);
        // Bound scalar scanning and JSON aggregation before constructing any
        // potentially large per-Proof binding arrays. LIMIT also bounds the
        // oversized case; a failed preflight rolls back the disposable job.
        const bindings = (await tx.query<{ proof_id: string; binding_count: number; byte_budget: string }>(
          'SELECT proof_id,COUNT(*)::integer AS binding_count,SUM(6::bigint*(octet_length(integration_account_id)::bigint+octet_length(resource_type)::bigint+octet_length(external_id)::bigint)+128)::text AS byte_budget FROM (' +
          'SELECT b.proof_id,b.integration_account_id,b.resource_type,b.external_id FROM platform_external_bindings b ' +
          'JOIN platform_proof_ownership o ON o.proof_id=b.proof_id AND o.merchant_id=$1 AND o.environment=$2 ' +
          'WHERE b.merchant_id=$1 AND b.environment=$2 LIMIT $3) AS bounded GROUP BY proof_id',
          [actor.merchantId, actor.environment, MAX_BINDINGS + 1])).rows;
        const bindingCount = bindings.reduce((sum, row) => sum + row.binding_count, 0);
        // Six bytes per source byte bounds JSON string escaping; 128 bytes per
        // binding and 1024 per core summary conservatively cover fixed fields.
        const byteBudget = bindings.reduce((sum, row) => sum + BigInt(row.byte_budget), BigInt(count) * 1024n);
        if (bindingCount > MAX_BINDINGS || byteBudget > BigInt(MAX_SNAPSHOT_BYTES) ||
          bindings.some(row => row.binding_count > MAX_BINDINGS_PER_PROOF || BigInt(row.byte_budget) + 1024n > BigInt(MAX_ROW_BYTES)))
          throw new DomainError('SNAPSHOT_TOO_LARGE', 'Snapshot exceeds the pilot reconciliation work or byte budget', 413);
        const h: SnapshotHeader = {
          id: newId('snapshot'), boundary_position: highWater,
          event_cursor: createEventStreamCursor(actor, highWater, expiresAt.getTime(), config),
          row_count: count, page_size: pageSize, created_at: createdAt, expires_at: expiresAt,
        };
        // The slot uniqueness constraint is also the hard concurrent quota.
        // PostgreSQL can report 40001 when a competing snapshot wins the slot.
        const inserted = await tx.query(
          'INSERT INTO api_proof_snapshots(id,tenant_id,merchant_id,environment,principal_id,credential_id,delegation_id,slot,boundary_position,event_cursor,page_size,row_count,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11,$12,$13,$14) ON CONFLICT(credential_id,slot) DO NOTHING RETURNING id',
          [h.id, actor.tenantId, actor.merchantId, actor.environment, actor.principalId, actor.credentialId,
            actor.delegationGrantId, slot, highWater, h.event_cursor, pageSize, count, createdAt.toISOString(), expiresAt.toISOString()]);
        if (!inserted.rows[0]) throw Object.assign(new Error('Snapshot slot changed'), { code: '40001' });
        const materialized = await tx.query(
          "INSERT INTO api_proof_snapshot_rows(snapshot_id,ordinal,proof_id,row_data) " +
          "SELECT $1,ROW_NUMBER() OVER (ORDER BY p.id)::integer,p.id,jsonb_build_object(" +
          "'schemaVersion','packproof.proof-state-summary/v1','proofId',p.id,'transactionId',p.transaction_id," +
          "'status',p.status,'version',p.version,'createdAt',p.created_at,'updatedAt',p.updated_at,'finalizedAt',p.finalized_at," +
          "'manifestSha256',m.sha256,'externalBindings',COALESCE((SELECT jsonb_agg(jsonb_build_object(" +
          "'integrationAccountId',b.integration_account_id,'resourceType',b.resource_type,'externalId',b.external_id) " +
          "ORDER BY b.integration_account_id,b.resource_type,b.external_id) FROM platform_external_bindings b " +
          "WHERE b.proof_id=p.id AND b.merchant_id=$2 AND b.environment=$3),'[]'::jsonb)) " +
          "FROM platform_proof_ownership o JOIN proofs p ON p.id=o.proof_id JOIN api_tenant_proofs t ON t.proof_id=p.id AND t.tenant_id=$4 LEFT JOIN final_manifests m ON m.proof_id=p.id " +
          "WHERE o.merchant_id=$2 AND o.environment=$3",
          [h.id, actor.merchantId, actor.environment, actor.tenantId]);
        if (materialized.rowCount !== count) throw new DomainError('SNAPSHOT_INCOMPLETE', 'The snapshot could not be materialized atomically', 409);
        const size = (await tx.query<{bytes: string; max_row_bytes: number}>(
          'SELECT COALESCE(SUM(octet_length(row_data::text)),0)::text AS bytes,COALESCE(MAX(octet_length(row_data::text)),0)::integer AS max_row_bytes FROM api_proof_snapshot_rows WHERE snapshot_id=$1',
          [h.id])).rows[0];
        if (BigInt(size.bytes) > BigInt(MAX_SNAPSHOT_BYTES) || size.max_row_bytes > MAX_ROW_BYTES)
          throw new DomainError('SNAPSHOT_TOO_LARGE', 'Snapshot exceeds the pilot budget of 16 MiB total or 256 KiB per Proof summary', 413);
        await auditOrganization(tx, clock, {actor, requestId: actor.requestId, operation: 'PROOF_SNAPSHOT_CREATED', resourceId: h.id});
        return h;
      });
      await authorize(db, clock, actor);
      return metadata(actor, header);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error &&
        ['57014', '55P03'].includes(String(error.code)))
        throw new DomainError('SNAPSHOT_BUSY', 'Snapshot work exceeded its bounded time budget; retry later', 503);
      if (!serializationFailure(error)) throw error;
      if (attempt === 2) throw new DomainError('SNAPSHOT_BUSY', 'Concurrent snapshot work prevented creation; retry with bounded backoff', 409);
    }
  }
  throw new DomainError('SNAPSHOT_BUSY', 'Retry snapshot creation', 409);
}

async function loadHeader(db: Database, actor: PartnerActor, snapshotId: string): Promise<SnapshotHeader> {
  const h = (await db.query<SnapshotHeader>(
    'SELECT id,boundary_position::text,event_cursor,page_size,row_count,created_at,expires_at FROM api_proof_snapshots WHERE id=$1 AND tenant_id=$2 AND merchant_id=$3 AND environment=$4 AND principal_id=$5 AND credential_id=$6 AND delegation_id IS NOT DISTINCT FROM $7',
    [snapshotId, actor.tenantId, actor.merchantId, actor.environment, actor.principalId, actor.credentialId, actor.delegationGrantId])).rows[0];
  if (!h) throw new DomainError('SNAPSHOT_NOT_FOUND', 'Snapshot not found for the current authorization', 404);
  return h;
}

/** Pages contain fixed canonical-state summaries, not media capabilities or a
 * replacement canonical Proof format. GET each authorized Proof, then consume
 * eventCursor; deduplicate logical event IDs. No HTTP-spanning transaction exists.
 */
export async function readPartnerProofSnapshot(db: Database, clock: Clock, actor: PartnerActor,
  snapshotId: string, config: EventStreamConfig, input: { after?: unknown } = {}) {
  key(config);
  const page = await db.transaction(async tx => {
    await authorize(tx, clock, actor);
    const h = await loadHeader(tx, actor, snapshotId);
    const expiry = new Date(h.expires_at).getTime();
    if (expiry <= clock.now().getTime()) return expired();
    // A key rotation invalidates old boundary cursors, including a first page
    // requested without a page cursor. Restart instead of returning a bad cutover.
    if (h.event_cursor !== createEventStreamCursor(actor, h.boundary_position, expiry, config)) return expired();
    await checkBoundary(tx, actor, h);
    const offset = input.after == null ? 0 : decode(input.after, actor, h, config).offset;
    const found = (await tx.query<{ ordinal: number; proof_id: string; row_data: ProofStateSnapshotRow }>(
      'SELECT ordinal,proof_id,row_data FROM api_proof_snapshot_rows WHERE snapshot_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT $3',
      [h.id, offset, h.page_size])).rows;
    if (found.length !== Math.min(h.page_size, h.row_count - offset))
      throw new DomainError('SNAPSHOT_INCOMPLETE', 'Snapshot data is unavailable; create a new snapshot and reconcile again', 409);
    for (const row of found) await authorizePartnerProof(tx, clock, actor, row.proof_id, 'proofs:read');
    const nextOffset = found.at(-1)?.ordinal ?? offset, hasMore = nextOffset < h.row_count;
    const nextCursor = hasMore ? encode({
      v: 1, kind: 'proof-snapshot-page', snapshotId: h.id, tenantId: actor.tenantId, merchantId: actor.merchantId,
      environment: actor.environment, principalId: actor.principalId, credentialId: actor.credentialId,
      delegationId: actor.delegationGrantId, offset: nextOffset, pageSize: h.page_size, expiresAt: expiry,
    }, config) : null;
    return { ...metadata(actor, h), proofs: found.map(r => r.row_data), hasMore, nextCursor };
  });
  // Match the partner API's current-authority rule even after a racing commit.
  await authorize(db, clock, actor);
  for (const row of page.proofs) await authorizePartnerProof(db, clock, actor, row.proofId, 'proofs:read');
  return page;
}

/** Explicitly release only this actor's disposable projection to free a slot. */
export async function releasePartnerProofSnapshot(db: Database, clock: Clock, actor: PartnerActor, snapshotId: string) {
  await db.transaction(async tx => {
    await authorize(tx, clock, actor);
    await loadHeader(tx, actor, snapshotId);
    await tx.query('DELETE FROM api_proof_snapshots WHERE id=$1', [snapshotId]);
  });
  await authorize(db, clock, actor);
  return { snapshotId, released: true };
}
