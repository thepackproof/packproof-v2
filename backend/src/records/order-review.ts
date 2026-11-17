import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { newId } from '../ids.js';
import type { RecordWorkspace } from './access.js';
import { idempotent } from '../platform/idempotency.js';
import { strictBody } from '../platform/organizations.js';
import type { Installation } from './agent-enrollments.js';
import { activeScope, boundedText, installationOperation, positive } from './order-workspace.js';
import { currentOrderScope, humanOrderFilter } from './order-feed.js';
import { lockOperation, orderComponent, commitOrderGroup } from './order-ledger.js';
import { refKey, type OrderRecord } from './order-projection.js';
interface AttentionFilter {
  where: string;
  params: unknown[];
}
export async function humanAttentionFilter(db: Database, w: RecordWorkspace, location?: unknown) {
  // The owner and location belong to the enrolled installation, including before
  // any matching order exists. Apply the same workspace predicate before paging.
  const f = await humanOrderFilter(db, w, location);
  return {
    where: f.where.replaceAll('r.', 'i.'),
    params: f.params
  };
}
export async function deviceAttentionFilter(db: Database, i: Installation) {
  await activeScope(db, i);
  return {
    where: 's.operation_key=$1',
    params: [installationOperation(i)]
  };
}
export async function attention(db: Database, f: AttentionFilter) {
  const rows = (await db.query<{
    id: string;
    source_id: string;
    file_name: string;
    record: OrderRecord;
  }>(`SELECT e.id,e.source_id,b.file_name,e.record FROM record_order_link_state s
 JOIN record_order_events e ON e.id=s.event_id JOIN record_order_receipts b ON b.id=e.receipt_id
 JOIN record_order_sessions session ON session.id=b.session_id JOIN record_agent_installations i ON i.id=session.installation_id
 WHERE s.unresolved AND ${f.where} ORDER BY s.updated_at DESC,e.id LIMIT 51`, f.params)).rows;
  return {
    items: rows.slice(0, 50).map(r => ({
      eventKey: r.id,
      sourceId: r.source_id,
      fileName: r.file_name,
      locator: r.record.locator,
      entity: r.record.entity,
      references: r.record.references,
      kind: r.record.kind,
      reason: r.id.startsWith('order_conflict_') ? 'This version differs from an earlier report. Review the source before linking.' : 'This report needs an order reference.'
    })),
    hasMore: rows.length > 50
  };
}
export async function decideAssociation(db: Database, clock: Clock, w: RecordWorkspace, proofId: string, input: unknown, key: unknown) {
  const b = strictBody(input, ['organizationId', 'environment', 'eventKey', 'action', 'expectedRevision', 'reason']);
  const id = boundedText(b.eventKey, 'event identity'),
    reason = boundedText(b.reason, 'decision reason', 1024),
    revision = positive(b.expectedRevision);
  if (b.action !== 'link' && b.action !== 'unlink') throw new DomainError('INVALID_REQUEST', 'Choose link or unlink.', 400);
  const f = currentOrderScope(await humanOrderFilter(db, w)),
    index = f.params.length + 1;
  const root = (await db.query<{
    operation_key: string;
    root_key: string;
  }>(`SELECT r.operation_key,r.root_key FROM record_order_roots r WHERE ${f.where} AND proof_id=$${index}`, [...f.params, proofId])).rows[0];
  if (!root) throw new DomainError('PROOF_NOT_FOUND', 'Choose an order in your authorized workspace.', 404);
  const res = await idempotent(db, clock, w.tenantId, 'review-order:' + w.organizationId + ':' + w.membershipId + ':' + proofId, key, input, async tx => {
    await lockOperation(tx, root.operation_key);
    const last = (await tx.query<{
      revision: number;
    }>('SELECT revision FROM record_order_revisions WHERE proof_id=$1 ORDER BY revision DESC LIMIT 1', [proofId])).rows[0];
    if (last?.revision !== revision) throw new DomainError('REVISION_CONFLICT', 'Review the latest revision before changing this link.', 409);
    const e = (await tx.query<{
      record: OrderRecord;
    }>('SELECT record FROM record_order_events WHERE operation_key=$1 AND id=$2', [root.operation_key, id])).rows[0];
    if (!e || e.record.kind === 'order' || !e.record.references) throw new DomainError('SOURCE_NOT_FOUND', 'Choose an eligible observation from this operation.', 404);
    const membership = (await tx.query<{
      proof_ids: string[];
    }>('SELECT proof_ids FROM record_order_link_state WHERE event_id=$1', [id])).rows[0];
    if (b.action === 'unlink' && !membership?.proof_ids.includes(proofId)) throw new DomainError('REVISION_CONFLICT', 'This observation is not linked to the selected order.', 409);
    const prior = (await tx.query<{
      id: string;
    }>(`SELECT d.id FROM record_order_decisions d WHERE d.event_id=$1 AND NOT EXISTS(SELECT 1 FROM record_order_decisions newer WHERE newer.supersedes_id=d.id)`, [id])).rows[0];
    const decisionId = newId('order_decision');
    await tx.query('INSERT INTO record_order_decisions(id,operation_key,event_id,proof_id,reason,actor_user_id,created_at,supersedes_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [decisionId, root.operation_key, id, b.action === 'link' ? proofId : null, reason, w.userId, clock.now().toISOString(), prior?.id ?? null]);
    if (id.startsWith('order_conflict_') && b.action === 'link') await tx.query('INSERT INTO record_order_event_refs(operation_key,ref_key,event_id) SELECT $1,k,$3 FROM unnest($2::text[]) k ON CONFLICT DO NOTHING', [root.operation_key, [e.record.entity, ...e.record.references].map(refKey), id]);
    const group = await orderComponent(tx, root.operation_key, [root.root_key, ...[e.record.entity, ...e.record.references].map(refKey)]);
    const {
      proofs
    } = await commitOrderGroup(tx, clock, root.operation_key, group, w.userId);
    return {
      decisionId,
      proofs
    };
  });
  return res.value;
}
