import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { strictBody } from '../platform/organizations.js';
import type { Installation } from './agent-enrollments.js';
import { activeScope, boundedText, digest, positive, installationOperation } from './order-workspace.js';
const invalid = () => new DomainError('DERIVATIVE_LIMIT', 'Provide bounded derived fields, page or region lineage, and issues.', 422);
function entries(value: unknown, max: number, allowNull: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > max) throw invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, v] of Object.entries(value)) {
    if (!key || key.length > 180 || ['__proto__', 'constructor', 'prototype'].includes(key) || !(allowNull && (v === null || typeof v === 'boolean') || typeof v === 'string' && v.length <= 16384)) throw invalid();
    result[key] = v;
  }
  return result;
}
/** Derived output is attached only to its verified original receipt. As a
 * reader result it has no entity references and cannot create an order link. */
export async function storeDerivation(db: Database, i: Installation, input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input)) > 1048576) throw invalid();
  const b = strictBody(input, ['scopeDigest', 'sourceId', 'generation', 'observationId', 'originalSha256', 'readerVersion', 'format', 'rows', 'issues']);
  const session = await activeScope(db, i, digest(b.scopeDigest)),
    operation = installationOperation(i);
  const sourceId = boundedText(b.sourceId, 'source'),
    generation = positive(b.generation),
    observation = boundedText(b.observationId, 'observation'),
    sha = digest(b.originalSha256),
    version = boundedText(b.readerVersion, 'reader version');
  if (!session.scope.sources.some(s => s.id === sourceId && s.generation === generation)) throw new DomainError('AUTH_REQUIRED', 'Review this source generation before submitting its derived reading.', 403);
  const orig = (await db.query<{
    id: string;
  }>('SELECT id FROM record_order_receipts WHERE operation_key=$1 AND source_id=$2 AND generation=$3 AND observation_id=$4 AND original_sha256=$5', [operation, sourceId, generation, observation, sha])).rows[0];
  if (!orig) throw new DomainError('ORIGINAL_NOT_FOUND', 'Submit the original before sending its derived reading.', 409);
  if (!Array.isArray(b.rows) || b.rows.length > 200 || !Array.isArray(b.issues) || b.issues.length > 64) throw invalid();
  const rows = b.rows.map(row => {
    const r = strictBody(row, ['location', 'fields', 'lineage']);
    return {
      location: boundedText(r.location, 'source region', 1600),
      fields: entries(r.fields, 96, true),
      lineage: entries(r.lineage, 160, false)
    };
  });
  const record = {
    schema: 'packproof.order-media-reading/v1',
    format: boundedText(b.format, 'reader format'),
    readerVersion: version,
    rows,
    issues: b.issues.map(v => boundedText(v, 'reader issue', 1024))
  };
  const eventId = '@derivation:' + sha256Hex(canonicalize([orig.id, version])),
    payload = sha256Hex(canonicalize(record));
  const id = newId('order_derivation');
  await db.query('INSERT INTO record_order_events(id,operation_key,source_id,event_id,source_version,receipt_id,payload_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING', [id, operation, sourceId, eventId, version, orig.id, payload, JSON.stringify(record)]);
  const saved = (await db.query<{
    id: string;
    payload_digest: string;
  }>('SELECT id,payload_digest FROM record_order_events WHERE operation_key=$1 AND source_id=$2 AND event_id=$3 AND source_version=$4', [operation, sourceId, eventId, version])).rows[0];
  if (saved.payload_digest !== payload) throw new DomainError('REVISION_CONFLICT', 'This original already has different results from the same reader version.', 409);
  return {
    derivativeId: saved.id,
    receiptId: orig.id,
    originalSha256: sha,
    rowCount: rows.length,
    state: 'accepted'
  };
}
